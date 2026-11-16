import path from 'node:path'
import fs from 'fs-extra'
import { fetchNeteaseCdn } from './cdn'
import { getTrackMeta } from './library'
import { getNeteaseCoverCacheDir, getNeteaseStoreDir } from './paths'
import { log } from '../log'
import { resolveNeteaseCoverSongId, toParametrizedCoverUrl } from './coverHelpers'

/**
 * 未下载曲目的列表/播放器封面：盘上没有音频文件，封面只能从网易云封面链接拉。
 * 必须走主进程（带 Referer），渲染层直接把 CDN 地址塞进 <img> 常会 403。
 */

const COVER_MAX_BYTES = 8 * 1024 * 1024

export type NeteaseCoverImage = {
  format: string
  data: Buffer
  cacheStatus: 'hit' | 'miss'
}

export {
  isNeteaseRemoteCoverPath,
  resolveNeteaseCoverSongId,
  toParametrizedCoverUrl
} from './coverHelpers'

function mimeFromBuffer(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png'
  }
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

function extFromMime(mime: string): string {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  return '.jpg'
}

async function readCachedCover(songId: string): Promise<NeteaseCoverImage | null> {
  const dir = getNeteaseCoverCacheDir()
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
    const filePath = path.join(dir, `${songId}${ext}`)
    if (!(await fs.pathExists(filePath))) continue
    const data = await fs.readFile(filePath)
    const mime = mimeFromBuffer(data)
    if (!mime || data.length === 0) continue
    return { format: mime, data, cacheStatus: 'hit' }
  }
  return null
}

async function writeCachedCover(songId: string, mime: string, data: Buffer): Promise<void> {
  const dir = getNeteaseCoverCacheDir()
  await fs.ensureDir(dir)
  const filePath = path.join(dir, `${songId}${extFromMime(mime)}`)
  await fs.writeFile(filePath, data)
}

export async function tryLoadNeteaseCover(filePath: string): Promise<NeteaseCoverImage | null> {
  const songId = resolveNeteaseCoverSongId(filePath, getNeteaseStoreDir())
  if (!songId) return null
  try {
    const cached = await readCachedCover(songId)
    if (cached) return cached
    const coverUrl = String(getTrackMeta(songId)?.coverUrl || '').trim()
    if (!coverUrl) return null
    const response = await fetchNeteaseCdn(toParametrizedCoverUrl(coverUrl), { retries: 1 })
    if (!response.ok) {
      log.warn(`[netease] 封面下载失败 ${songId} HTTP ${response.status}`)
      return null
    }
    const data = Buffer.from(await response.arrayBuffer())
    const mime = mimeFromBuffer(data)
    if (!mime || data.length === 0 || data.length > COVER_MAX_BYTES) {
      log.warn(`[netease] 封面不是可用图片 ${songId}`)
      return null
    }
    try {
      await writeCachedCover(songId, mime, data)
    } catch (error) {
      log.warn('[netease] 封面缓存写入失败', error)
    }
    return { format: mime, data, cacheStatus: 'miss' }
  } catch (error) {
    log.warn(`[netease] 读取封面失败 ${songId}`, error)
    return null
  }
}
