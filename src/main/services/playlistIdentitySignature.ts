import crypto = require('crypto')

/**
 * 歌单“磁盘身份”摘要。只覆盖曲目集合 + 每首的 size/mtime，不含任何解析结果，
 * 因此可以在不解析元数据的前提下判断“这次打开的目录内容和快照是否同一份”。
 *
 * 这个模块被 songListScanWorker 通过 worker_threads 载入，禁止引入 electron 依赖。
 */
export type PlaylistIdentityEntry = {
  key: string
  size: number
  mtimeMs: number
}

const normalizeMtime = (mtimeMs: number): number =>
  Number.isFinite(mtimeMs) ? Math.round(mtimeMs) : 0

const normalizeSize = (size: number): number => (Number.isFinite(size) ? Math.round(size) : -1)

/**
 * 与 scanSongs 的命中判定保持同一套语义：路径 key 已经归一化过大小写，
 * mtime 取整到毫秒（原判定用 <1ms 容差），size 精确比较。
 */
export function computePlaylistIdentityDigest(entries: readonly PlaylistIdentityEntry[]): string {
  if (entries.length === 0) return 'empty'
  const rows = entries
    .map((entry) => `${entry.key}|${normalizeSize(entry.size)}|${normalizeMtime(entry.mtimeMs)}`)
    .sort()
  const hash = crypto.createHash('sha1')
  hash.update(String(rows.length))
  for (const row of rows) {
    hash.update('\n')
    hash.update(row)
  }
  return `${rows.length}-${hash.digest('hex')}`
}
