import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { readdir, rename, stat, unlink, utimes } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import fsExtra = require('fs-extra')
import store from '../store'
import { log } from '../log'
import { getNeteasePreviewCacheDir } from './paths'

/**
 * 试听缓存（磁盘 LRU）。
 *
 * 目的只有一个：同一首歌来回试听时不要每次都从 CDN 重新拉。
 * 它与 `.store`（「已下载」）是两回事——这里的东西随时可以被清掉，
 * 不影响任何列表状态，所以可以大方地设 10GB 上限。
 *
 * 只在**从第 0 字节开始的整段请求**上落缓存：音频元素 seek 时发的是
 * `bytes=NNN-` 的局部请求，那类请求直接透传，否则会把半截文件当成完整缓存。
 *
 * 文件名带上音质档位（`<songId>.<level>.<ext>`）：下载要判断"缓存里这份
 * 是不是我想要的规格"，只看 songId 会把 MP3 当成无损拷进 `.store`。
 */

const DEFAULT_LIMIT_BYTES = 10 * 1024 * 1024 * 1024
const MIN_LIMIT_BYTES = 256 * 1024 * 1024

type CacheEntry = { path: string; level: string }

/** songId → 缓存文件；启动后第一次用到时扫描一次 */
let index: Map<string, CacheEntry> | null = null
let enforceTimer: ReturnType<typeof setTimeout> | null = null

export function getPreviewCacheLimitBytes(): number {
  const configured = Number(store.settingConfig?.neteasePreviewCacheBytes || 0)
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_LIMIT_BYTES
  return Math.max(MIN_LIMIT_BYTES, Math.floor(configured))
}

const extFromContentType = (contentType: string): string => {
  const value = String(contentType || '').toLowerCase()
  if (value.includes('flac')) return 'flac'
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3'
  if (value.includes('mp4') || value.includes('m4a') || value.includes('aac')) return 'm4a'
  return ''
}

/** `<songId>.<level>.<ext>`；老文件没有档位段，按空档位处理 */
const parseCacheName = (name: string): { songId: string; level: string } | null => {
  const parts = name.split('.')
  if (parts.length < 2) return null
  const songId = parts[0]
  if (!songId) return null
  const level = parts.length >= 3 ? parts[parts.length - 2] : ''
  return { songId, level }
}

async function ensureIndex(): Promise<Map<string, CacheEntry>> {
  if (index) return index
  const map = new Map<string, CacheEntry>()
  const dir = getNeteasePreviewCacheDir()
  try {
    const entries = await readdir(dir)
    for (const name of entries) {
      if (name.endsWith('.part')) continue
      const parsed = parseCacheName(name)
      if (!parsed) continue
      map.set(parsed.songId, { path: path.join(dir, name), level: parsed.level })
    }
  } catch {
    // 目录还不存在：当作空缓存
  }
  index = map
  return map
}

export function invalidatePreviewCacheIndex(): void {
  index = null
}

/**
 * 命中时顺带 touch 一下 mtime，LRU 才有意义。
 * 传了 `preferredLevel` 就只在档位一致时命中——下载复用要的是"同规格的那份"。
 */
export async function findPreviewCacheFile(
  songId: string,
  preferredLevel?: string
): Promise<string | null> {
  const map = await ensureIndex()
  const entry = map.get(String(songId))
  if (!entry) return null
  if (preferredLevel && entry.level && entry.level !== preferredLevel) return null
  try {
    const info = await stat(entry.path)
    if (!info.isFile() || info.size === 0) {
      map.delete(String(songId))
      return null
    }
    const now = new Date()
    await utimes(entry.path, now, now).catch(() => {})
    return entry.path
  } catch {
    map.delete(String(songId))
    return null
  }
}

/**
 * 把上游流原样转发给播放器，同时写一份到 `finalPath`。
 *
 * 落盘的时序是这个函数唯一容易做错的地方：
 *   `end` → 文件流 flush → rename
 *   `close`（正常结束时紧跟在 `end` 之后）
 * 如果 `close` 也走"清理"逻辑，它会在 rename 之前把 `finalized` 置位并删掉 `.part`，
 * 于是缓存**永远落不了盘**——文件写完了、改名被跳过、临时文件还被删了。
 *
 * 因此：`close` 只在"没读完就断了"时清理；字节数到齐时把落盘完全交给 `end`。
 */
export function teeStreamToFile(options: {
  finalPath: string
  source: Readable
  expectedBytes: number
  onSettled?: (ok: boolean) => void
}): Readable {
  const { finalPath, source, expectedBytes } = options
  const partPath = `${finalPath}.part`
  const fileStream = createWriteStream(partPath)

  let bytes = 0
  let settled = false
  let cacheBroken = false

  const settle = (ok: boolean) => {
    if (settled) return
    settled = true
    options.onSettled?.(ok)
  }

  const abort = () => {
    if (settled) return
    settled = true
    // Windows 上 destroy() 不会立刻放开文件句柄，先等 close 再删，否则 .part 会留下。
    const removePart = () => {
      void unlink(partPath)
        .catch(() => {})
        .finally(() => options.onSettled?.(false))
    }
    const writable = fileStream as typeof fileStream & { closed?: boolean }
    if (writable.closed) {
      removePart()
      return
    }
    fileStream.once('close', removePart)
    fileStream.destroy()
  }

  // 缓存写失败绝不能影响播放：出错就闭嘴，继续把字节转发给播放器。
  fileStream.on('error', (error) => {
    cacheBroken = true
    log.warn('[netease] 试听缓存写入失败，改为纯流式', error)
  })

  const finish = () => {
    if (settled) return
    if (cacheBroken || bytes !== expectedBytes) {
      abort()
      return
    }
    void rename(partPath, finalPath)
      .then(() => settle(true))
      .catch((error) => {
        log.warn('[netease] 试听缓存落盘失败', error)
        void unlink(partPath).catch(() => {})
        settle(false)
      })
  }

  const tee = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (cacheBroken) {
        callback(null, chunk)
        return
      }
      let flushed = false
      try {
        flushed = fileStream.write(chunk)
      } catch {
        cacheBroken = true
      }
      if (flushed || cacheBroken) {
        callback(null, chunk)
        return
      }
      // 磁盘跟不上网络时把上游一起刹住：不管 write() 的返回值，
      // 一首 130MB 的无损会把整块文件堆在内存里（而且是边播边堆）。
      // 等到 drain 再放行；这个期间播放器只是暂时拿不到数据，不会卡死。
      const resume = () => {
        fileStream.off('drain', resume)
        fileStream.off('close', resume)
        fileStream.off('error', resume)
        callback(null, chunk)
      }
      fileStream.once('drain', resume)
      fileStream.once('close', resume)
      fileStream.once('error', resume)
    }
  })

  tee.on('end', () => {
    // 正常读完：等文件流把缓冲刷完再改名
    try {
      fileStream.end(() => finish())
    } catch {
      abort()
    }
  })
  tee.on('close', () => {
    // 正常结束这一路已经交给 'end' 了，别在这里抢着删
    if (settled) return
    if (!cacheBroken && bytes === expectedBytes) return
    abort()
  })
  tee.on('error', abort)
  source.on('error', abort)

  return source.pipe(tee) as unknown as Readable
}

/**
 * 给试听流挂上缓存。
 *
 * 只有"看起来是完整文件"时才改名生效：字节数对不上（用户 seek 打断了、网络断了）
 * 就把 `.part` 删掉。判断依据是上游给的 content-length——没有这个头就不缓存，
 * 宁可少缓存也不要留半截文件。容器认不出来（`.bin`）同样不缓存：
 * 那种文件既放不出来也认不出，留着只会占地方。
 */
export function teeToPreviewCache(
  songId: string,
  level: string,
  contentType: string,
  source: Readable,
  expectedBytes: number
): NodeJS.ReadableStream {
  if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) return source
  const ext = extFromContentType(contentType)
  if (!ext) return source

  const dir = getNeteasePreviewCacheDir()
  try {
    fsExtra.ensureDirSync(dir)
  } catch {
    return source
  }
  const safeLevel = /^[a-z0-9]+$/i.test(level) ? level.toLowerCase() : 'unknown'
  const finalPath = path.join(dir, `${songId}.${safeLevel}.${ext}`)

  return teeStreamToFile({
    finalPath,
    source,
    expectedBytes,
    onSettled: (ok) => {
      if (!ok) return
      void (async () => {
        const map = await ensureIndex()
        map.set(String(songId), { path: finalPath, level: safeLevel })
        // 同一首歌的其它档位缓存已经过时：留着只会被 LRU 慢慢清，不如现在收掉
        await removeSiblingCacheFiles(songId, finalPath)
        scheduleEnforce()
      })()
    }
  })
}

async function removeSiblingCacheFiles(songId: string, keepPath: string): Promise<void> {
  const dir = getNeteasePreviewCacheDir()
  try {
    const names = await readdir(dir)
    for (const name of names) {
      if (name.endsWith('.part')) continue
      const parsed = parseCacheName(name)
      if (!parsed || parsed.songId !== String(songId)) continue
      const abs = path.join(dir, name)
      if (abs === keepPath) continue
      // 播放器可能正读着这份，删不掉就算了
      await unlink(abs).catch(() => {})
    }
  } catch {}
}

function scheduleEnforce(): void {
  if (enforceTimer) return
  enforceTimer = setTimeout(() => {
    enforceTimer = null
    void enforcePreviewCacheLimit()
  }, 2000)
  enforceTimer.unref?.()
}

/** 超过上限就按 mtime 从旧到新删，直到降回上限的 90% */
export async function enforcePreviewCacheLimit(): Promise<{ removed: number; freedBytes: number }> {
  const dir = getNeteasePreviewCacheDir()
  const limit = getPreviewCacheLimitBytes()
  const now = Date.now()
  let entries: Array<{ filePath: string; size: number; mtimeMs: number }> = []
  try {
    const names = await readdir(dir)
    for (const name of names) {
      const filePath = path.join(dir, name)
      try {
        const info = await stat(filePath)
        if (!info.isFile()) continue
        // 正在写入的 .part 不能删：删了那一路 tee 会在 rename 时扑空，
        // 播放本身不受影响，但缓存白写一遍。只有明显是崩溃残留（很久没动）的才收。
        if (name.endsWith('.part') && now - info.mtimeMs < 5 * 60 * 1000) continue
        entries.push({ filePath, size: info.size, mtimeMs: info.mtimeMs })
      } catch {}
    }
  } catch {
    return { removed: 0, freedBytes: 0 }
  }

  const total = entries.reduce((sum, item) => sum + item.size, 0)
  if (total <= limit) return { removed: 0, freedBytes: 0 }

  const target = Math.floor(limit * 0.9)
  entries = entries.sort((left, right) => left.mtimeMs - right.mtimeMs)
  let current = total
  let removed = 0
  let freedBytes = 0
  for (const entry of entries) {
    if (current <= target) break
    try {
      await unlink(entry.filePath)
      current -= entry.size
      removed += 1
      freedBytes += entry.size
    } catch {}
  }
  invalidatePreviewCacheIndex()
  return { removed, freedBytes }
}

export async function clearPreviewCache(): Promise<{ removed: number; freedBytes: number }> {
  const dir = getNeteasePreviewCacheDir()
  let removed = 0
  let freedBytes = 0
  try {
    const names = await readdir(dir)
    for (const name of names) {
      const filePath = path.join(dir, name)
      try {
        const info = await stat(filePath)
        await unlink(filePath)
        removed += 1
        freedBytes += info.size
      } catch {}
    }
  } catch {}
  invalidatePreviewCacheIndex()
  return { removed, freedBytes }
}

export async function getPreviewCacheUsage(): Promise<{ count: number; bytes: number }> {
  const dir = getNeteasePreviewCacheDir()
  let count = 0
  let bytes = 0
  try {
    const names = await readdir(dir)
    for (const name of names) {
      try {
        const info = await stat(path.join(dir, name))
        if (!info.isFile()) continue
        count += 1
        bytes += info.size
      } catch {}
    }
  } catch {}
  return { count, bytes }
}
