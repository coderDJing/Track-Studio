import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import store from '../store'
import { neteaseClient, type NeteaseLevel } from './client'
import { fetchNeteaseCdn } from './cdn'
import { getLocalFilePath } from './library'
import { findPreviewCacheFile, teeToPreviewCache } from './cache'
import { isSafeSongId } from './paths'
import { log } from '../log'

/**
 * 试听/播放的网易云分支，挂在既有 frkb-preview 流协议上：
 *
 *   frkb-preview://?netease=<songId>
 *
 * 播放器不需要改动——它本来就消费 frkb-preview://，对渲染层而言这就是一个音频源。
 *
 * 两种情况：
 *   1. 已下载 → 直接读本地文件，按 Range 切片（和普通本地曲目完全一样）
 *   2. 未下载 → 取 CDN 直链，把 Range 透传给上游，边拉边 pipe
 *
 * 直链会过期（几十分钟），所以按 songId 缓存一小会儿，避免每次 seek 都重新请求接口。
 */

const URL_CACHE_TTL_MS = 5 * 60 * 1000
/** 直链缓存条数上限：一次试听会 seek 很多次，但不能一辈子不清 */
const URL_CACHE_MAX_ENTRIES = 200

const urlCache = new Map<string, { url: string; expiresAt: number }>()

function resolveLevel(): NeteaseLevel {
  const level = store.settingConfig?.neteaseLevel
  if (level === 'jymaster' || level === 'lossless' || level === 'exhigh' || level === 'standard') {
    return level
  }
  return 'lossless'
}

export type PreviewResponse = {
  statusCode: number
  data?: NodeJS.ReadableStream
  mimeType?: string
  headers?: Record<string, string>
}

type Range = { start: number; end: number; total: number } | null

function parseRange(rangeHeader: string | undefined, total: number): Range {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null
  const [rawStart, rawEnd] = rangeHeader.replace('bytes=', '').split('-')
  const start = Math.max(0, Number.parseInt(rawStart || '0', 10))
  const end = rawEnd ? Math.min(Number.parseInt(rawEnd, 10), total - 1) : total - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null
  return { start, end, total }
}

function mimeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.m4a' || ext === '.aac') return 'audio/mp4'
  if (ext === '.wav') return 'audio/wav'
  return 'application/octet-stream'
}

function dropDirectUrl(songId: string, level: NeteaseLevel): void {
  urlCache.delete(`${songId}:${level}`)
}

async function getDirectUrl(songId: string, level: NeteaseLevel): Promise<string | null> {
  const cacheKey = `${songId}:${level}`
  const cached = urlCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  const detail = await neteaseClient.songUrl(songId, level)
  if (!detail || !detail.url || detail.trial) return null
  const now = Date.now()
  for (const [key, value] of urlCache) {
    if (value.expiresAt <= now) urlCache.delete(key)
  }
  if (!urlCache.has(cacheKey) && urlCache.size >= URL_CACHE_MAX_ENTRIES) {
    const oldest = urlCache.keys().next().value
    if (oldest) urlCache.delete(oldest)
  }
  urlCache.set(cacheKey, { url: detail.url, expiresAt: now + URL_CACHE_TTL_MS })
  return detail.url
}

/**
 * 取一次上游响应。
 *
 * 直链带签名、几十分钟就失效，而我们的缓存 TTL 是 5 分钟——真遇到"缓存里这条已经
 * 过期"时会拿到 403。这种情况清掉缓存重取一次直链就能恢复；否则用户会看到一次
 * 莫名其妙的播放失败，直到 TTL 到点才自己好。
 */
async function fetchUpstream(
  songId: string,
  level: NeteaseLevel,
  rangeHeader: string | undefined
): Promise<{ response: Response; directUrl: string } | null> {
  const directUrl = await getDirectUrl(songId, level)
  if (!directUrl) return null
  const response = await fetchNeteaseCdn(directUrl, { range: rangeHeader })
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    dropDirectUrl(songId, level)
    const refreshed = await getDirectUrl(songId, level)
    if (refreshed && refreshed !== directUrl) {
      return {
        response: await fetchNeteaseCdn(refreshed, { range: rangeHeader }),
        directUrl: refreshed
      }
    }
  }
  return { response, directUrl }
}

/** 主进程流协议里调用；songId 来自 URL 的 netease 参数 */
export async function handleNeteasePreview(
  songId: string,
  rangeHeader: string | undefined
): Promise<PreviewResponse> {
  // songId 会拼进试听缓存的文件名（`.preview-cache/<songId>.<level>.<ext>`），
  // 而它来自 URL —— 与 IPC 一样是信任边界，必须先过白名单。
  if (!songId) return { statusCode: 400 }
  if (!isSafeSongId(songId)) return { statusCode: 400 }

  // 1. 已下载：与本地曲目同一条路径
  const local = await serveLocalFile(songId, rangeHeader)
  if (local) return local

  // 2. 试听缓存命中：同样是本地文件，只是这份随时可能被 LRU 清掉
  const cached = await serveCachedPreview(songId, rangeHeader)
  if (cached) return cached

  // 3. 都没有：透传上游，顺手把"从 0 开始的整段请求"写进缓存
  if (!neteaseClient.isLoggedIn) return { statusCode: 401 }
  const level = resolveLevel()
  const upstreamResult = await fetchUpstream(songId, level, rangeHeader)
  if (!upstreamResult) return { statusCode: 404 }
  const upstream = upstreamResult.response
  if (!upstream.ok || !upstream.body) return { statusCode: 502 }

  const contentType = upstream.headers.get('content-type') || 'audio/flac'
  const contentRange = upstream.headers.get('content-range')
  const contentLength = upstream.headers.get('content-length')
  const totalBytes = Number(contentLength) || 0
  let data: NodeJS.ReadableStream = Readable.fromWeb(upstream.body as never)

  // 只有整段请求（没带 Range）才有资格落缓存：局部请求拿到的半截文件不能当完整缓存用。
  const isWholeFile = !rangeHeader && upstream.status === 200 && totalBytes > 0
  if (isWholeFile) {
    try {
      data = teeToPreviewCache(songId, level, contentType, data as Readable, totalBytes)
    } catch (error) {
      log.warn('[netease] 试听缓存写入失败，改为纯流式', error)
    }
  }

  const responseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin'
  }
  if (contentRange) responseHeaders['Content-Range'] = contentRange
  if (contentLength) responseHeaders['Content-Length'] = contentLength

  return {
    statusCode: upstream.status === 206 ? 206 : 200,
    data,
    mimeType: responseHeaders['Content-Type'],
    headers: responseHeaders
  }
}

/** 已下载的本地文件（`.store`），Range 感知 */
async function serveLocalFile(
  songId: string,
  rangeHeader: string | undefined
): Promise<PreviewResponse | null> {
  try {
    const localPath = getLocalFilePath(songId)
    if (!localPath) return null
    return await serveFileRange(localPath, rangeHeader)
  } catch (error) {
    log.warn('[netease] 读取本地文件失败，回退流式', error)
    return null
  }
}

/** 试听缓存命中 */
async function serveCachedPreview(
  songId: string,
  rangeHeader: string | undefined
): Promise<PreviewResponse | null> {
  try {
    const cachePath = await findPreviewCacheFile(songId)
    if (!cachePath) return null
    return await serveFileRange(cachePath, rangeHeader)
  } catch {
    return null
  }
}

async function serveFileRange(
  filePath: string,
  rangeHeader: string | undefined
): Promise<PreviewResponse> {
  const fileStat = await stat(filePath)
  const mimeType = mimeOf(filePath)
  const range = parseRange(rangeHeader, fileStat.size)
  if (range) {
    return {
      statusCode: 206,
      data: createReadStream(filePath, { start: range.start, end: range.end }),
      mimeType,
      headers: {
        'Content-Type': mimeType,
        'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(range.end - range.start + 1),
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin'
      }
    }
  }
  return {
    statusCode: 200,
    data: createReadStream(filePath),
    mimeType,
    headers: {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(fileStat.size),
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    }
  }
}

/** 本地已有文件时，播放器完全不必走流式 */
export function hasLocalFile(songId: string): boolean {
  try {
    return Boolean(getLocalFilePath(songId))
  } catch {
    return false
  }
}
