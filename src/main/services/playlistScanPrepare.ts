import path from 'node:path'
import fs from 'fs-extra'
import { collectFilesWithExtensions, runWithConcurrency } from '../nodeTaskUtils'
import { SUPPORTED_AUDIO_FORMATS } from '../../shared/audioFormats'

export type PlaylistFileStat = {
  file: string
  key: string
  size: number
  mtimeMs: number
}

/** 一次"枚举 + stat"的完整产出。perf 字段只用于埋点，别拿去做业务判断。 */
export type PlaylistFileStatScan = {
  files: PlaylistFileStat[]
  /** 枚举到了却没能拿到 size / mtime 的条目数。> 0 说明这份列表不完整，身份摘要不可用。 */
  skipped: number
  /** 'native' = 枚举与 stat 在原生层一遍做完；'js' = 原生模块不可用，走两轮 JS 实现。 */
  mode: 'native' | 'js'
  listMs: number
  /** 单独 stat 的耗时；native 模式恒为 0（已经折进 listMs）。 */
  statMs: number
}

type NativeAudioFileStat = {
  file: string
  size: number
  mtimeMs: number
}

type NativeAudioFileScanResult = {
  files: NativeAudioFileStat[]
  skipped: number
}

type RustPlaylistScanBinding = {
  listAudioFilesWithStat?: (
    dir: string,
    audioExts: string[]
  ) => NativeAudioFileScanResult | Promise<NativeAudioFileScanResult>
}

let rustPlaylistScanBinding: RustPlaylistScanBinding | null | undefined

/**
 * 原生绑定必须在函数里惰性 require：songListScanWorker 走 worker_threads 起线程，
 * 模块顶层 require 会在 nativeModuleSetup 补好 DLL 搜索路径之前就跑。
 */
const loadRustPlaylistScanBinding = (): RustPlaylistScanBinding | null => {
  if (rustPlaylistScanBinding !== undefined) return rustPlaylistScanBinding
  try {
    const binding = require('rust_package') as RustPlaylistScanBinding
    if (typeof binding.listAudioFilesWithStat !== 'function') {
      rustPlaylistScanBinding = null
      return null
    }
    rustPlaylistScanBinding = binding
    return binding
  } catch {
    rustPlaylistScanBinding = null
    return null
  }
}

/** 打开/扫描歌单时的 stat 并发上限，避免机械盘被打满。 */
export const PLAYLIST_STAT_CONCURRENCY = 8

export const normalizePlaylistPathKey = (value: string): string => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const cleanupConversionTempFiles = async (dir: string, cleanedDirs: Set<string>) => {
  if (cleanedDirs.has(dir)) return
  cleanedDirs.add(dir)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      if (!name.startsWith('.') || !name.includes('.tmp.')) continue
      const matched = SUPPORTED_AUDIO_FORMATS.find((fmt) => name.toLowerCase().endsWith(`.${fmt}`))
      if (!matched) continue
      const fullPath = path.join(dir, name)
      try {
        await fs.remove(fullPath)
      } catch {}
    }
  } catch {}
}

async function listPlaylistAudioFiles(
  scanPath: string | string[],
  audioExt: string[]
): Promise<string[]> {
  const songFileUrls: string[] = []
  const cleanedDirs = new Set<string>()
  const pathsToScan = Array.isArray(scanPath) ? scanPath : [scanPath]
  for (const filePath of pathsToScan) {
    const stats = await fs.stat(filePath)
    if (stats.isFile()) {
      await cleanupConversionTempFiles(path.dirname(filePath), cleanedDirs)
      const ext = path.extname(filePath).toLowerCase()
      if (audioExt.includes(ext)) {
        songFileUrls.push(filePath)
      }
    } else if (stats.isDirectory()) {
      await cleanupConversionTempFiles(filePath, cleanedDirs)
      const files = await collectFilesWithExtensions(filePath, audioExt)
      songFileUrls.push(...files)
    }
  }
  return songFileUrls
}

async function statPlaylistAudioFiles(songFileUrls: string[]): Promise<PlaylistFileStat[]> {
  if (songFileUrls.length === 0) return []
  const tasks = songFileUrls.map((file) => async () => {
    const st = await fs.stat(file)
    return {
      file,
      key: normalizePlaylistPathKey(file),
      size: st.size,
      mtimeMs: st.mtimeMs
    } satisfies PlaylistFileStat
  })
  const { results } = await runWithConcurrency(tasks, { concurrency: PLAYLIST_STAT_CONCURRENCY })
  const filesStatList: PlaylistFileStat[] = []
  for (const item of results) {
    if (!item || item instanceof Error) continue
    filesStatList.push(item)
  }
  return filesStatList
}

/**
 * 枚举歌单目录并同时拿到每首的 size / mtimeMs。
 *
 * 原生路径（Windows 上 FindFirstFileW 的 find-data 已经带了 size 和时间戳，
 * 取 metadata 不额外发系统调用）把原来"枚举一遍 + 逐个 stat 一遍"压成一遍，
 * 少一轮 libuv 线程池排队和一次跨 JS 边界的往返。
 *
 * 保留 JS 路径不是"兜底掩盖问题"：`.node` 是 gitignore 的按平台产物，没跑过
 * `napi build` 的仓库根本 require 不到原生模块。两条路径的输出必须逐字一致
 * （顺序、size、mtimeMs），`rust_package/__test__/playlist_scan.spec.mjs` 负责对账。
 *
 * 注意 `fs.stat(filePath)` 的抛错必须继续往外抛：歌单目录被删掉时要让上层看到错误，
 * 不能悄悄变成一份"空列表"，否则会被当权威快照存下去。
 */
export async function listPlaylistAudioFilesWithStat(
  scanPath: string | string[],
  audioExt: string[]
): Promise<PlaylistFileStatScan> {
  const startedAt = Date.now()
  const binding = loadRustPlaylistScanBinding()
  const listAudioFilesWithStat = binding?.listAudioFilesWithStat
  if (!listAudioFilesWithStat) {
    const songFileUrls = await listPlaylistAudioFiles(scanPath, audioExt)
    const listMs = Date.now() - startedAt
    const statStartedAt = Date.now()
    const files = await statPlaylistAudioFiles(songFileUrls)
    return {
      files,
      skipped: Math.max(0, songFileUrls.length - files.length),
      mode: 'js',
      listMs,
      statMs: Date.now() - statStartedAt
    }
  }

  const normalizedExts = audioExt.map((ext) => String(ext || '').toLowerCase()).filter(Boolean)
  const files: PlaylistFileStat[] = []
  const cleanedDirs = new Set<string>()
  const pathsToScan = Array.isArray(scanPath) ? scanPath : [scanPath]
  let skipped = 0
  for (const filePath of pathsToScan) {
    const stats = await fs.stat(filePath)
    if (stats.isFile()) {
      await cleanupConversionTempFiles(path.dirname(filePath), cleanedDirs)
      if (normalizedExts.includes(path.extname(filePath).toLowerCase())) {
        files.push({
          file: filePath,
          key: normalizePlaylistPathKey(filePath),
          size: stats.size,
          mtimeMs: stats.mtimeMs
        })
      }
      continue
    }
    if (!stats.isDirectory()) continue
    // 必须在枚举之前清临时文件，否则 `.xxx.tmp.mp3` 会命中后缀过滤混进列表。
    await cleanupConversionTempFiles(filePath, cleanedDirs)
    // 原生侧用 Path::join 拼路径，只有分隔符已经规整时才和 path.join 逐字一致。
    const scanned = await listAudioFilesWithStat(path.normalize(filePath), normalizedExts)
    for (const item of scanned?.files || []) {
      files.push({
        file: item.file,
        key: normalizePlaylistPathKey(item.file),
        size: item.size,
        mtimeMs: item.mtimeMs
      })
    }
    skipped += Math.max(0, Number(scanned?.skipped) || 0)
  }
  return { files, skipped, mode: 'native', listMs: Date.now() - startedAt, statMs: 0 }
}

export async function resolvePlaylistCacheRoot(scanPath: string | string[]): Promise<string> {
  const cacheBase =
    typeof scanPath === 'string' ? scanPath : Array.isArray(scanPath) ? (scanPath[0] ?? '') : ''
  if (!cacheBase) return ''
  try {
    if ((await fs.pathExists(cacheBase)) && (await fs.stat(cacheBase)).isDirectory()) {
      return cacheBase
    }
  } catch {}
  return ''
}
