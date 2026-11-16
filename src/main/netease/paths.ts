import path from 'node:path'
import fs from 'fs-extra'
import store from '../store'
import { getCoreFsDirName } from '../coreLibraries'

/**
 * 网易云音乐库的物理路径约定。
 *
 *   <databaseDir>/library/NeteaseLibrary/          ← 库根（本模块的 list_root）
 *     .store/1234567.flac                          ← 下载的音频，按 songId 平铺
 *     .preview-cache/1234567.lossless.flac         ← 试听缓存（LRU，可随时清）
 *     .cover-cache/1234567.jpg                     ← 列表/播放器封面（按 songId 缓存）
 *     .netease-session                             ← 登录态（safeStorage 加密）
 *
 * 注意 `.store/`、`.preview-cache/`、`.cover-cache` 与 `.netease-session` 都是点开头，
 * 不会被库树扫描当成曲目或歌单。
 *
 * `.store` 与 `.preview-cache` 刻意分开：前者是"已下载"（用户资产，出现在「查看已下载」里），
 * 后者只是试听时的临时缓冲，清掉不影响任何可见状态。
 */
export function getNeteaseRootDir(): string {
  const databaseDir = String(store.databaseDir || '')
  if (!databaseDir) throw new Error('library database root is not configured')
  return path.join(path.resolve(databaseDir), 'library', getCoreFsDirName('NeteaseLibrary'))
}

export function getNeteaseStoreDir(): string {
  return path.join(getNeteaseRootDir(), '.store')
}

export function getNeteasePreviewCacheDir(): string {
  return path.join(getNeteaseRootDir(), '.preview-cache')
}

export function getNeteaseCoverCacheDir(): string {
  return path.join(getNeteaseRootDir(), '.cover-cache')
}

export function getNeteaseSessionFile(): string {
  return path.join(getNeteaseRootDir(), '.netease-session')
}

/**
 * 曲目 id 只可能是纯数字。
 *
 * 这不是洁癖：songId 会直接拼进 `.store/<songId>.<ext>`，而调用方是 IPC——
 * 渲染层传什么都可能。`..%2F..%2Ffoo` 之类的片段一旦拼进去就是任意文件写入。
 * 所有来自外部的 id 都必须先过这一关。
 */
const SONG_ID_PATTERN = /^[1-9]\d{0,19}$/

export function isSafeSongId(songId: unknown): boolean {
  return SONG_ID_PATTERN.test(String(songId ?? '').trim())
}

export function assertSongId(songId: unknown): string {
  const value = String(songId ?? '').trim()
  if (!SONG_ID_PATTERN.test(value)) {
    throw new Error(`非法的网易云曲目 id：${value.slice(0, 32)}`)
  }
  return value
}

/** 存进 netease_file.file_path 的是相对库根的路径，跨机器迁移库目录时仍然有效 */
export function toRelativeStorePath(absPath: string): string {
  return path.relative(getNeteaseRootDir(), absPath).split(path.sep).join('/')
}

/**
 * 库内相对路径 → 绝对路径，并且**保证落在库根之下**。
 *
 * 这条路径虽然出自库里的数据，但库文件可以被拷贝、合并、手工编辑，
 * 所以不能假设它老实——解析后不在库根内的，一律拒绝。
 */
export function fromRelativeStorePath(relativePath: string): string {
  const root = getNeteaseRootDir()
  const raw = String(relativePath || '').trim()
  if (!raw) throw new Error('库内路径为空')
  // 绝对路径、带盘符的路径都不能当"库内相对路径"用：
  // split 之后前导空段会被 resolve 吃掉，`/etc/passwd` 会悄悄变成 `<root>/etc/passwd`
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`库内路径越界：${raw.slice(0, 64)}`)
  }
  const abs = path.resolve(root, ...raw.split('/'))
  if (abs === root || !abs.startsWith(root + path.sep)) {
    throw new Error(`库内路径越界：${raw.slice(0, 64)}`)
  }
  return abs
}

export async function ensureNeteaseDirs(): Promise<void> {
  await fs.ensureDir(getNeteaseStoreDir())
  await fs.ensureDir(getNeteasePreviewCacheDir())
  await fs.ensureDir(getNeteaseCoverCacheDir())
}

/** 下载落盘的文件名：<songId>.<ext>，扩展名取自响应头或默认 flac */
export function getStoreFilePath(songId: string, ext: string): string {
  const safeId = assertSongId(songId)
  const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext.toLowerCase() : 'flac'
  return path.join(getNeteaseStoreDir(), `${safeId}.${safeExt}`)
}

/** 临时文件必须落在 `.store` 里：这个目录是点开头，监听器不会拿它去对账 */
export function isAbsPathInsideStore(absPath: string): boolean {
  const storeDir = path.resolve(getNeteaseStoreDir())
  const resolved = path.resolve(String(absPath || ''))
  const left = process.platform === 'win32' ? storeDir.toLowerCase() : storeDir
  const right = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  return right === left || right.startsWith(left + path.sep)
}

export function assertAbsPathInsideStore(absPath: string): string {
  const resolved = path.resolve(String(absPath || ''))
  if (!isAbsPathInsideStore(resolved)) {
    throw new Error('临时文件必须落在网易云库的 .store 目录内')
  }
  return resolved
}
