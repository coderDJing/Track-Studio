import path from 'node:path'
import fs = require('fs-extra')
import { log } from '../log'
import store from '../store'
import FingerprintStore from '../fingerprintStore'
import { getCoreFsDirName } from '../coreLibraries'
import {
  getSongsAnalyseResult,
  moveOrCopyItemWithCheckIsExist,
  resolveLibraryChildPath,
  resolveLibraryPath,
  runWithConcurrency
} from '../utils'
import { beginLibraryTreeWatcherBulkOperation } from '../libraryTreeWatcher'
import {
  appendSongListTrackNumbers,
  isSupportedPlaylistTrackNumberListRoot
} from '../services/playlistTrackNumbers'
import { stampPlaylistSongsAddedAt } from '../services/playlistAddedAt'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { scheduleCuratedLibrarySyncAfterLocalChange } from '../cloudSyncScheduler'
import { rememberCuratedArtistsForAddedTracks } from '../curatedArtistLibrary'
import { downloadTrack, getLocalFileOutcome, getPlaylistTracks, getTrackMeta } from './library'
import { ensureTracksDownloaded } from './ensureDownloaded'
export { ensureTracksDownloaded } from './ensureDownloaded'
import type { NeteaseLevel } from './client'
import { estimateImportSize, type ImportEstimate } from './importEstimate'
import { isSafeSongId } from './paths'
import { buildImportBaseName } from './importName'

export { buildImportBaseName }

/**
 * 整张歌单导入。
 *
 * 语义（与普通导入刻意不同，别照抄 importHandlers 的默认值）：
 *   - **只复制，从不移动**。源文件是 `.store/<songId>.flac`，那是网易云的下载缓存，
 *     删了下次还得重下；用户从歌单里移除一首歌，也不该影响已经导入到筛选库的副本。
 *   - **改名**。`.store` 里是按 songId 命名的，进了库必须变成「艺人 - 标题」。
 *   - **保序**。按网易云的 trackIds 顺序追加，而不是按文件名排序。
 *   - **整批包在 bulk 里**。否则每一首复制都会触发一次目录核对与云同步。
 */

export type NeteaseProgressPayload = {
  id: string
  titleKey?: string
  now?: number
  total?: number
  isInitial?: boolean
  dismiss?: boolean
}

export type NeteaseImportResult = {
  total: number
  imported: number
  skippedDuplicate: number
  skippedUnavailable: number
  failed: number
  errorSamples: string[]
  importedPaths: string[]
  importedSongIds: string[]
  skippedDuplicateSongIds: string[]
  fingerprintAdded: number
}

/**
 * 同目录下取一个没被占用的名字：`名字.ext`、`名字 (2).ext`、`名字 (3).ext` …
 *
 * `claimed` 是本批次已经认领过的路径。并发复制时两首歌可能算出同一个基础名
 * （同名不同版本、或艺人与标题恰好相同），只看磁盘会在 await 的缝隙里双双通过，
 * 后一个 copy 直接覆盖前一个，列表里就少了一首。所以认领必须同步完成。
 */
async function resolveAvailablePath(
  dirAbs: string,
  base: string,
  ext: string,
  claimed: Set<string>
): Promise<string> {
  for (let index = 1; index < 999; index += 1) {
    const name = index === 1 ? `${base}${ext}` : `${base} (${index})${ext}`
    const candidate = resolveLibraryChildPath(dirAbs, name)
    if (claimed.has(candidate)) continue
    if (await fs.pathExists(candidate)) continue
    // await 回来之后再看一眼：这期间可能已被另一路认领
    if (claimed.has(candidate)) continue
    claimed.add(candidate)
    return candidate
  }
  throw new Error('同名文件过多，无法生成文件名')
}

const isCuratedTargetPath = (mappedPath: string): boolean => {
  const normalize = (value: string) => value.replace(/\\/g, '/')
  const targetPath = normalize(mappedPath)
  const curatedRoot = normalize(path.join('library', getCoreFsDirName('CuratedLibrary')))
  return targetPath === curatedRoot || targetPath.startsWith(`${curatedRoot}/`)
}

const isFilterTargetPath = (mappedPath: string): boolean => {
  const normalize = (value: string) => value.replace(/\\/g, '/')
  const targetPath = normalize(mappedPath)
  const filterRoot = normalize(path.join('library', getCoreFsDirName('FilterLibrary')))
  return targetPath === filterRoot || targetPath.startsWith(`${filterRoot}/`)
}

/**
 * 导入目标只能是筛选库或精选库。
 *
 * `songListPath` 来自渲染层的选择结果，虽然理论上只会指向那两个库，
 * 但这条通道会往里**写文件**——越界一次就是把不知道什么东西复制进用户的别的目录。
 */
const assertAllowedImportTarget = (mappedPath: string): void => {
  if (isCuratedTargetPath(mappedPath) || isFilterTargetPath(mappedPath)) return
  throw new Error('导入目标只能是筛选库或精选库')
}

export type NeteaseImportOptions = {
  /** 目标歌单（渲染层路径，如 `library/FilterLibrary/某歌单`） */
  songListPath: string
  /** 目标歌单 uuid，只用于搜索索引失效与日志 */
  songListUUID?: string
  /** 歌单 id；与 songIds 二选一 */
  playlistId?: string
  /** 用户选中的曲目 id（按显示顺序）；为空则取整张歌单 */
  songIds?: string[]
  deduplicateMode?: 'library' | 'batch' | 'none'
  pushFingerprintLibrary?: boolean
  level?: NeteaseLevel
  progressId?: string
  sendProgress?: (payload: NeteaseProgressPayload) => void
}

type PendingTrack = { songId: string; title: string; artist: string }

/**
 * 主流程。调用方负责 UI 上的忙碌态；这里只负责把文件搬到正确位置。
 */
export async function importNeteasePlaylist(
  options: NeteaseImportOptions
): Promise<NeteaseImportResult> {
  const progressId = options.progressId || `netease_import_${Date.now()}`
  const progress = options.sendProgress || (() => {})
  const dedupMode: 'library' | 'batch' | 'none' = options.deduplicateMode || 'library'
  const level: NeteaseLevel = options.level || 'lossless'
  const pushFingerprintLibrary = options.pushFingerprintLibrary === true

  const target = resolveLibraryPath(options.songListPath)
  assertAllowedImportTarget(target.mappedPath)
  const pending = resolvePendingTracks(options)
  const result: NeteaseImportResult = {
    total: pending.length,
    imported: 0,
    skippedDuplicate: 0,
    skippedUnavailable: 0,
    failed: 0,
    errorSamples: [],
    importedPaths: [],
    importedSongIds: [],
    skippedDuplicateSongIds: [],
    fingerprintAdded: 0
  }
  if (pending.length === 0) return result

  // ── 1. 下载缺失的曲目（串行：同一账号并发拉直链更容易被限流） ────────────────
  progress({ id: progressId, titleKey: 'netease.downloadingTracks', now: 0, total: pending.length })
  const downloaded: Array<PendingTrack & { filePath: string }> = []
  for (let index = 0; index < pending.length; index += 1) {
    const track = pending[index]
    try {
      const outcome = await downloadTrack(track.songId, level)
      downloaded.push({ ...track, filePath: outcome.filePath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`[netease] 下载 ${track.songId} 失败`, error)
      result.skippedUnavailable += 1
      if (result.errorSamples.length < 5) {
        result.errorSamples.push(`${track.title || track.songId}: ${message}`)
      }
    }
    progress({
      id: progressId,
      titleKey: 'netease.downloadingTracks',
      now: index + 1,
      total: pending.length
    })
  }
  if (downloaded.length === 0) {
    progress({ id: progressId, dismiss: true })
    return result
  }

  // ── 2. 指纹去重 ────────────────────────────────────────────────────────────
  // 与普通导入同一套判定：library = 与整个曲库比，batch = 只在本次内比，none = 不分析。
  // 命中去重时**不删源文件**——.store 里的是网易云缓存，不是用户目录里的重复文件。
  let candidates = downloaded
  const fingerprintsToAdd: string[] = []

  if (dedupMode !== 'none') {
    const analyse = await getSongsAnalyseResult(
      downloaded.map((item) => item.filePath),
      (processed: number) =>
        progress({
          id: progressId,
          titleKey: 'netease.analyzingTracks',
          now: processed,
          total: downloaded.length
        })
    )
    const hashByPath = new Map<string, string>()
    for (const item of analyse.songsAnalyseResult) {
      hashByPath.set(item.file_path, item.sha256_Hash)
    }
    const libraryHashes = new Set(store.songFingerprintList)
    const seenInBatch = new Set<string>()
    const kept: typeof candidates = []
    for (const item of candidates) {
      const hash = hashByPath.get(item.filePath)
      if (!hash) {
        // 分析失败的照样导入：不因为一次解码失败就吞掉用户的歌
        kept.push(item)
        continue
      }
      if (dedupMode === 'library' && libraryHashes.has(hash)) {
        result.skippedDuplicate += 1
        result.skippedDuplicateSongIds.push(item.songId)
        continue
      }
      if (dedupMode === 'batch') {
        if (seenInBatch.has(hash)) {
          result.skippedDuplicate += 1
          result.skippedDuplicateSongIds.push(item.songId)
          continue
        }
        seenInBatch.add(hash)
      }
      if (pushFingerprintLibrary) fingerprintsToAdd.push(hash)
      kept.push(item)
    }
    candidates = kept
  } else if (pushFingerprintLibrary) {
    // 不比对也要入指纹库：单独跑一遍分析，只取哈希
    const analyse = await getSongsAnalyseResult(
      downloaded.map((item) => item.filePath),
      () => {}
    )
    for (const item of analyse.songsAnalyseResult) fingerprintsToAdd.push(item.sha256_Hash)
  }

  if (candidates.length === 0) {
    progress({ id: progressId, dismiss: true })
    return result
  }

  // ── 3. 复制进目标歌单（保留顺序） ──────────────────────────────────────────
  const releaseBulk = beginLibraryTreeWatcherBulkOperation()
  try {
    progress({
      id: progressId,
      titleKey: 'netease.importingTracks',
      now: 0,
      total: candidates.length
    })
    const orderedTargets: Array<string | null> = new Array(candidates.length).fill(null)
    const claimedPaths = new Set<string>()
    const tasks = candidates.map((item, index) => async () => {
      const ext = path.extname(item.filePath) || '.flac'
      const base = buildImportBaseName(item.artist, item.title, item.songId)
      const plannedPath = await resolveAvailablePath(target.absPath, base, ext, claimedPaths)
      // 复制用既有入口：它会重试 EBUSY/EPERM（Windows 上杀软或索引服务正读着文件时很常见）
      const finalPath = await moveOrCopyItemWithCheckIsExist(item.filePath, plannedPath, false)
      orderedTargets[index] = finalPath
      return finalPath
    })

    const run = await runWithConcurrency(tasks, {
      concurrency: 8,
      onProgress: (done, total) =>
        progress({ id: progressId, titleKey: 'netease.importingTracks', now: done, total })
    })
    result.failed += run.failed
    if (run.failed > 0 && result.errorSamples.length < 5) {
      result.errorSamples.push(`复制失败 ${run.failed} 首`)
    }

    const importedPaths = orderedTargets.filter((item): item is string => !!item)
    result.imported = importedPaths.length
    result.importedPaths = importedPaths
    result.importedSongIds = candidates
      .filter((_, index) => orderedTargets[index])
      .map((item) => item.songId)

    if (importedPaths.length > 0) {
      if (isSupportedPlaylistTrackNumberListRoot(target.absPath)) {
        await appendSongListTrackNumbers({
          listRoot: target.absPath,
          appendedFilePaths: importedPaths
        })
      }
      await stampPlaylistSongsAddedAt({ listRoot: target.absPath, filePaths: importedPaths })
    }

    if (pushFingerprintLibrary && fingerprintsToAdd.length > 0) {
      const unique = Array.from(new Set(fingerprintsToAdd))
      const before = store.songFingerprintList.length
      await FingerprintStore.unionFingerprintList(
        unique,
        store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
      )
      result.fingerprintAdded = Math.max(0, store.songFingerprintList.length - before)
    }

    markGlobalSongSearchDirty('neteaseImport', { songListUUID: options.songListUUID })

    if (isCuratedTargetPath(target.mappedPath)) {
      if (importedPaths.length > 0) scheduleCuratedLibrarySyncAfterLocalChange()
      void rememberCuratedArtistsForAddedTracks({ targetPaths: importedPaths }).catch((error) => {
        log.error('[netease] 记录精选表演者失败', error)
      })
    }
  } finally {
    releaseBulk()
    progress({ id: progressId, dismiss: true })
  }

  return result
}

/** 本次要处理哪些曲目：优先用调用方给的 songIds，否则取整张歌单的原始顺序 */
function resolvePendingTracks(options: NeteaseImportOptions): PendingTrack[] {
  const playlistId = String(options.playlistId || '')
  const tracks = playlistId ? getPlaylistTracks(playlistId) : []
  const byId = new Map(tracks.map((track) => [track.songId, track]))
  const selected = Array.isArray(options.songIds)
    ? options.songIds.map((id) => String(id)).filter((id) => isSafeSongId(id))
    : []

  if (selected.length > 0) {
    return selected.map((songId) => {
      const known = byId.get(songId)
      const meta = known || getTrackMeta(songId)
      return {
        songId,
        title: meta?.title || '',
        artist: meta?.artist || ''
      }
    })
  }
  return tracks.map((track) => ({
    songId: track.songId,
    title: track.title,
    artist: track.artist
  }))
}

/** 导入确认框用的体积估算：不请求 CDN，已下载的用实际大小 */
export async function estimatePlaylistImportSize(
  playlistId: string,
  level: NeteaseLevel
): Promise<ImportEstimate> {
  const tracks = getPlaylistTracks(String(playlistId || ''))
  const mapped = []
  for (const track of tracks) {
    const existing = await getLocalFileOutcome(track.songId)
    mapped.push({
      songId: track.songId,
      durationMs: track.durationMs,
      actualSizeBytes: existing?.sizeBytes
    })
  }
  return estimateImportSize(mapped, level)
}
