import path = require('path')
import { runWithConcurrency } from '../nodeTaskUtils'
import { ISongInfo } from '../../types/globals'
import { readWavRiffInfoWindows } from './wavRiffInfo'
import {
  listPlaylistAudioFilesWithStat,
  normalizePlaylistPathKey,
  resolvePlaylistCacheRoot
} from './playlistScanPrepare'
import * as LibraryCacheDb from '../libraryCacheDb'
import { normalizeSongHotCues } from '../../shared/hotCues'
import { normalizeSongMemoryCues } from '../../shared/memoryCues'
import {
  BEAT_GRID_STATUS_NO_BPM,
  normalizeBeatGridAlgorithmVersion
} from './beatGridAlgorithmVersion'
import { shouldAcceptKeyAnalysisCacheVersion } from './keyAnalysisAlgorithmVersion'
import {
  ensurePlaylistTrackNumbers,
  normalizePlaylistTrackNumber,
  sortSongsByPlaylistTrackNumber
} from './playlistTrackNumbers'
import { isInRecordingLibraryAbsPath } from '../recordingLibraryService'
import { hasCurrentSongEnergyAnalysis, hasUsableSongEnergyAnalysis } from '../../shared/songEnergy'
import { normalizeSongBeatGridMapV2 } from '../../shared/songBeatGridMapV2'
import {
  hasUsableKeyAnalysis,
  resolveCanonicalSongBeatGridV2
} from '../../shared/songAnalysisCompleteness'
import {
  discardIncompatibleSongStructure,
  preserveBestAvailableSongStructure
} from './songStructureCachePolicy'
import { preserveCachedAddedAtMs } from '../../shared/songAddedAt'
import { computePlaylistIdentityDigest } from './playlistIdentitySignature'

type DeferredSongCacheWrite = () => Promise<void>

export type DeferredWaveformAvailabilityCheck = {
  cacheRoot: string
  entries: Array<{ filePath: string; size: number; mtimeMs: number }>
}

type ScanSongListOptions = {
  enablePostScanTasks?: boolean
  /** 只做磁盘身份核对 + 缓存命中，不解析新文件。核对失败时返回空列表并标记 cacheIdentityVerified=false。 */
  verifiedOnly?: boolean
  /**
   * 首开歌单时让 worker 先返回可展示列表，再继续落盘缓存。回调拥有写入任务的生命周期，
   * 必须在 worker 被复用前执行它，避免同一个 SQLite 连接并发写入。
   */
  enqueueDeferredSongCacheWrite?: (write: DeferredSongCacheWrite) => void
  /**
   * 波形表在大型资料库里可能散落在大量 SQLite 页上。首开时先交付歌曲列表，
   * 由扫描 worker 在交付后继续核对波形；完成后再按同一份身份摘要更新快照。
   */
  deferWaveformAvailabilityCheck?: boolean
}

export type ScanSongListResult = {
  scanData: ISongInfo[]
  missingWaveformFilePaths: string[]
  songListUUID: string
  playlistTrackNumbering: null | {
    initialized: boolean
    repaired: boolean
  }
  cacheIdentityVerified: boolean
  /** 本次扫描时磁盘上的文件身份摘要（路径+size+mtime）。快照层用它判断"还要不要重扫"。 */
  identityDigest: string
  /** 仅供扫描 worker 在首个结果交付后继续完成，绝不能透传到 renderer。 */
  deferredWaveformAvailabilityCheck?: DeferredWaveformAvailabilityCheck
  perf: {
    listFilesMs: number
    cacheCheckMs: number
    parseMetadataMs: number
    totalMs: number
    filesCount: number
    successCount: number
    failedCount: number
    cacheHits: number
    parsedCount: number
    /** 以下为定位慢开销的细分项：读缓存表、stat、跨库补分析各花了多久。 */
    cacheLoadedFromDb: boolean
    cacheLoadMs: number
    cacheRows: number
    /** 未命中按原因拆分；仅用于慢扫描诊断，四项之和等于 filesCount - cacheHits。 */
    cacheMisses: {
      noEntry: number
      sizeMismatch: number
      mtimeMismatch: number
      analysisOnly: number
    }
    cacheRootResolveMs: number
    identityDigestMs: number
    waveformAvailabilityMs: number
    cacheMatchMs: number
    metadataModuleLoadMs: number
    cacheWriteMs: number
    cacheWriteDeferred: boolean
    trackFinalizeMs: number
    statMs: number
    /** 'native' = 枚举与 stat 走原生一遍过；'js' = 原生模块不可用，走两轮 JS 实现。 */
    listMode: 'native' | 'js'
    /** 枚举到了却拿不到 size / mtime 的条目数。> 0 说明 identityDigest 不完整。 */
    skippedCount: number
    refreshMissingMs: number
    refreshMissingCount: number
    refreshMissingChangedCount: number
  }
}

type CachedKeyInfo = Pick<ISongInfo, 'key' | 'keyAnalysisAlgorithmVersion'>
type CachedGridInfo = Pick<
  ISongInfo,
  | 'beatGridAlgorithmVersion'
  | 'beatGridStatus'
  | 'beatGridMap'
  | 'timeBasisOffsetMs'
  | 'timeBasisOffsetAlgorithmVersion'
> & {
  beatThisWindowCount?: unknown
}
type CachedEnergyInfo = Pick<ISongInfo, 'energyScore' | 'energyAlgorithmVersion'>
const hasCurrentKeyAnalysis = (info: CachedKeyInfo | null | undefined) =>
  hasUsableKeyAnalysis(info) && shouldAcceptKeyAnalysisCacheVersion(info)
const hasCompleteGrid = (info: CachedGridInfo | null | undefined) =>
  resolveCanonicalSongBeatGridV2(info).kind !== 'missing'
const discardStaleAnalysisFields = (info: ISongInfo): ISongInfo => {
  const next = { ...info }
  if (!hasUsableKeyAnalysis(next)) {
    delete next.key
    delete next.keyAnalysisAlgorithmVersion
  }
  const grid = resolveCanonicalSongBeatGridV2(next)
  if (grid.kind === 'grid') {
    delete next.beatGridStatus
    next.beatGridMap = grid.beatGridMap
    delete next.bpm
    delete next.firstBeatMs
    delete next.downbeatBeatOffset
    delete (next as Record<string, unknown>).barBeatOffset
    delete next.beatGridSource
  } else if (grid.kind === 'no-bpm') {
    delete next.bpm
    delete next.firstBeatMs
    delete next.downbeatBeatOffset
    delete (next as Record<string, unknown>).barBeatOffset
    delete next.timeBasisOffsetMs
    delete next.timeBasisOffsetAlgorithmVersion
    delete next.beatGridSource
    delete next.beatGridMap
  } else {
    delete next.bpm
    delete next.firstBeatMs
    delete next.downbeatBeatOffset
    delete (next as Record<string, unknown>).barBeatOffset
    delete next.timeBasisOffsetMs
    delete next.timeBasisOffsetAlgorithmVersion
    delete next.beatGridSource
    delete next.beatGridStatus
    delete next.beatGridMap
    delete next.beatGridAlgorithmVersion
  }
  if (!hasUsableSongEnergyAnalysis(next)) {
    delete next.energyScore
    delete next.energyAlgorithmVersion
  }
  if (grid.kind !== 'grid') discardIncompatibleSongStructure(next)
  return next
}

const preserveCachedKeyAndBpm = (target: ISongInfo, cachedInfo?: ISongInfo | null) => {
  if (!cachedInfo) return
  if (
    hasUsableKeyAnalysis(cachedInfo) &&
    (!hasUsableKeyAnalysis(target) ||
      (!hasCurrentKeyAnalysis(target) && hasCurrentKeyAnalysis(cachedInfo)))
  ) {
    target.key = cachedInfo.key as string
    target.keyAnalysisAlgorithmVersion = cachedInfo.keyAnalysisAlgorithmVersion
  }
}

const preserveCachedGridTimeBasisFields = (target: ISongInfo, cachedInfo: ISongInfo) => {
  const cachedTimeBasisOffsetMs = Number(cachedInfo.timeBasisOffsetMs)
  const targetTimeBasisOffsetMs = Number(target.timeBasisOffsetMs)
  let targetUsesCachedTimeBasisOffset = false
  if (!Number.isFinite(targetTimeBasisOffsetMs) || targetTimeBasisOffsetMs < 0) {
    if (Number.isFinite(cachedTimeBasisOffsetMs) && cachedTimeBasisOffsetMs >= 0) {
      target.timeBasisOffsetMs = Number(cachedTimeBasisOffsetMs.toFixed(3))
      targetUsesCachedTimeBasisOffset = true
    }
  } else if (
    Number.isFinite(cachedTimeBasisOffsetMs) &&
    cachedTimeBasisOffsetMs >= 0 &&
    Math.abs(targetTimeBasisOffsetMs - cachedTimeBasisOffsetMs) <= 0.001
  ) {
    targetUsesCachedTimeBasisOffset = true
  }

  const cachedOffsetAlgorithmVersion = Number(cachedInfo.timeBasisOffsetAlgorithmVersion)
  if (
    targetUsesCachedTimeBasisOffset &&
    target.timeBasisOffsetAlgorithmVersion === undefined &&
    Number.isFinite(cachedOffsetAlgorithmVersion) &&
    cachedOffsetAlgorithmVersion > 0
  ) {
    target.timeBasisOffsetAlgorithmVersion = Math.floor(cachedOffsetAlgorithmVersion)
  }

  if (target.beatGridAlgorithmVersion === undefined) {
    const cachedBeatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
      cachedInfo.beatGridAlgorithmVersion
    )
    if (cachedBeatGridAlgorithmVersion !== undefined) {
      target.beatGridAlgorithmVersion = cachedBeatGridAlgorithmVersion
    }
  }
}

export const preserveCachedGridAnalysisFields = (
  target: ISongInfo,
  cachedInfo?: ISongInfo | null
) => {
  if (!cachedInfo) return
  const cachedGrid = resolveCanonicalSongBeatGridV2(cachedInfo)
  if (cachedGrid.kind === 'no-bpm') {
    if (hasCompleteGrid(target)) return
    delete target.bpm
    delete target.firstBeatMs
    delete target.downbeatBeatOffset
    delete (target as unknown as Record<string, unknown>).barBeatOffset
    delete target.timeBasisOffsetMs
    delete target.timeBasisOffsetAlgorithmVersion
    delete target.beatGridSource
    delete target.beatGridMap
    target.beatGridStatus = BEAT_GRID_STATUS_NO_BPM
    target.beatGridAlgorithmVersion = cachedInfo.beatGridAlgorithmVersion
    return
  }
  const cachedBeatGridMap = normalizeSongBeatGridMapV2(cachedInfo.beatGridMap, {
    allowSingleClip: true
  })
  if (cachedBeatGridMap) {
    preserveCachedGridTimeBasisFields(target, cachedInfo)
    if (hasCompleteGrid(target)) return
    delete target.beatGridStatus
    target.beatGridMap = cachedBeatGridMap
    delete target.bpm
    delete target.firstBeatMs
    delete target.downbeatBeatOffset
    delete (target as unknown as Record<string, unknown>).barBeatOffset
    delete target.beatGridSource
    return
  }
}

const preserveCachedEnergyAnalysisFields = (
  target: ISongInfo,
  cachedInfo?: CachedEnergyInfo | null
) => {
  if (!cachedInfo) return
  if (
    !hasUsableSongEnergyAnalysis(cachedInfo) ||
    (hasUsableSongEnergyAnalysis(target) &&
      (!hasCurrentSongEnergyAnalysis(cachedInfo) || hasCurrentSongEnergyAnalysis(target)))
  ) {
    return
  }
  target.energyScore = cachedInfo.energyScore
  target.energyAlgorithmVersion = cachedInfo.energyAlgorithmVersion
}

const preserveCachedAnalysisFields = (target: ISongInfo, cachedInfo?: ISongInfo | null) => {
  preserveCachedKeyAndBpm(target, cachedInfo)
  preserveCachedGridAnalysisFields(target, cachedInfo)
  preserveCachedEnergyAnalysisFields(target, cachedInfo)
  preserveBestAvailableSongStructure(target, cachedInfo)
}

const preserveCachedUserListFields = (target: ISongInfo, cachedInfo?: ISongInfo | null) => {
  const cachedPlaylistTrackNumber = normalizePlaylistTrackNumber(cachedInfo?.playlistTrackNumber)
  if (
    normalizePlaylistTrackNumber(target.playlistTrackNumber) === undefined &&
    cachedPlaylistTrackNumber !== undefined
  ) {
    target.playlistTrackNumber = cachedPlaylistTrackNumber
  }
  preserveCachedAddedAtMs(target, cachedInfo)
}

export const scheduleSongListPostScanTasks = async (
  scanPath: string | string[],
  scanData: ISongInfo[],
  options: { enableAutoAnalysis?: boolean; missingWaveformFilePaths?: string[] } = {}
) => {
  const cacheRoot = await resolvePlaylistCacheRoot(scanPath)

  if (!cacheRoot || scanData.length === 0) return

  // 自动入队分析默认关闭：扫描/导入歌单不再静默触发后台分析，
  // 是否分析交由前端“询问是否分析”弹框或闲时全库扫描决定。
  if (options.enableAutoAnalysis === true) {
    const pendingKeys = scanData
      .filter((info) => !isInRecordingLibraryAbsPath(info.filePath))
      .filter(
        (info) =>
          !hasUsableKeyAnalysis(info) ||
          !hasCompleteGrid(info) ||
          !hasUsableSongEnergyAnalysis(info)
      )
      .map((info) => info.filePath)
      .filter((filePath) => typeof filePath === 'string' && filePath.trim().length > 0)
    const pendingFiles = Array.from(
      new Set([...(pendingKeys || []), ...(options.missingWaveformFilePaths || [])])
    )
    if (pendingFiles.length > 0) {
      const { enqueueKeyAnalysisList } = await import('./keyAnalysisQueue')
      enqueueKeyAnalysisList(pendingFiles, 'background', { source: 'background' })
    }
  }

  const currentFilePaths = scanData.map((info) => info.filePath)
  const { scheduleSongListCoverSweep } = await import('./covers')
  scheduleSongListCoverSweep(cacheRoot, currentFilePaths)
}

/**
 * 只在扫描 worker 已把歌曲列表交付后调用。此查询可能因波形 BLOB 所在页分散而较慢，
 * 不能再挡住首开或用户触发的“刷新分析字段”。
 */
export const loadMissingWaveformFilePaths = (
  check: DeferredWaveformAvailabilityCheck
): string[] => {
  const cacheRoot = String(check?.cacheRoot || '').trim()
  const entries = Array.isArray(check?.entries) ? check.entries : []
  if (!cacheRoot || entries.length === 0) return []
  const availability = LibraryCacheDb.loadWaveformSurfaceAvailabilityByMeta(cacheRoot, entries)
  return entries
    .filter((entry) => availability.get(entry.filePath) !== true)
    .map((entry) => entry.filePath)
}

// 扫描歌单目录，带 SQLite 缓存
export async function scanSongList(
  scanPath: string | string[],
  audioExt: string[],
  songListUUID: string,
  options: ScanSongListOptions = {}
): Promise<ScanSongListResult> {
  const perfAllStart = Date.now()
  let songInfoArr: ISongInfo[] = []
  let playlistTrackNumbering: {
    initialized: boolean
    repaired: boolean
  } | null = null

  // 枚举与 stat 一次做完：原生模块在时是一遍目录遍历，否则退回两轮 JS 实现。
  const fileScan = await listPlaylistAudioFilesWithStat(scanPath, audioExt)
  const filesStatList = fileScan.files
  const normalizePathKey = normalizePlaylistPathKey

  type CacheEntry = {
    size: number
    mtimeMs: number
    info: ISongInfo
  }
  const perfCacheRootResolveStart = Date.now()
  const cacheRoot = await resolvePlaylistCacheRoot(scanPath)
  const perfCacheRootResolveMs = Date.now() - perfCacheRootResolveStart
  let cacheMap = new Map<string, CacheEntry>()
  let cacheFromDb = false
  const perfCacheLoadStart = Date.now()
  if (cacheRoot) {
    const dbCache = await LibraryCacheDb.loadSongCache(cacheRoot)
    if (dbCache) {
      if (process.platform === 'win32') {
        const normalizedMap = new Map<string, CacheEntry>()
        for (const [filePath, entry] of dbCache) {
          normalizedMap.set(normalizePathKey(filePath), entry)
        }
        cacheMap = normalizedMap
      } else {
        cacheMap = dbCache
      }
      cacheFromDb = true
    }
  }
  const perfCacheLoadMs = Date.now() - perfCacheLoadStart

  const perfCacheCheckStart = Date.now()
  const perfIdentityDigestStart = Date.now()
  const identityDigest = computePlaylistIdentityDigest(filesStatList)
  const perfIdentityDigestMs = Date.now() - perfIdentityDigestStart
  const filesStatByKey = new Map(filesStatList.map((item) => [item.key, item]))
  const waveformAvailabilityEntries = filesStatList.map((item) => ({
    filePath: item.file,
    size: item.size,
    mtimeMs: item.mtimeMs
  }))
  const deferWaveformAvailabilityCheck =
    options.deferWaveformAvailabilityCheck === true &&
    !!cacheRoot &&
    waveformAvailabilityEntries.length > 0
  const perfWaveformAvailabilityStart = Date.now()
  const waveformAvailability =
    cacheRoot && !deferWaveformAvailabilityCheck
      ? LibraryCacheDb.loadWaveformSurfaceAvailabilityByMeta(cacheRoot, waveformAvailabilityEntries)
      : new Map<string, boolean>()
  const perfWaveformAvailabilityMs = Date.now() - perfWaveformAvailabilityStart
  const missingWaveformFilePaths =
    cacheRoot && !deferWaveformAvailabilityCheck
      ? filesStatList
          .filter((item) => waveformAvailability.get(item.file) !== true)
          .map((item) => item.file)
      : []
  const cachedInfos: ISongInfo[] = []
  const filesToParse: string[] = []
  const analysisOnlyByPath = new Map<string, ISongInfo>()
  const cacheMisses = {
    noEntry: 0,
    sizeMismatch: 0,
    mtimeMismatch: 0,
    analysisOnly: 0
  }
  const isAnalysisOnly = (info?: ISongInfo | null): boolean => Boolean(info?.analysisOnly)
  const perfCacheMatchStart = Date.now()
  for (const it of filesStatList) {
    const c = cacheMap.get(it.key)
    if (!c) {
      cacheMisses.noEntry += 1
      filesToParse.push(it.file)
      continue
    }
    if (c.size !== it.size) {
      cacheMisses.sizeMismatch += 1
      filesToParse.push(it.file)
      continue
    }
    if (Math.abs(c.mtimeMs - it.mtimeMs) >= 1) {
      cacheMisses.mtimeMismatch += 1
      filesToParse.push(it.file)
      continue
    }
    if (isAnalysisOnly(c.info)) {
      cacheMisses.analysisOnly += 1
      analysisOnlyByPath.set(it.key, c.info)
      filesToParse.push(it.file)
      continue
    }
    cachedInfos.push(enrichSongInfo(discardStaleAnalysisFields({ ...c.info, filePath: it.file })))
  }
  const perfCacheMatchMs = Date.now() - perfCacheMatchStart
  const perfCacheCheckEnd = Date.now()

  let perfMetadataModuleLoadMs = 0
  let perfCacheWriteMs = 0
  let perfCacheWriteDeferred = false
  let perfTrackFinalizeMs = 0

  function convertSecondsToMinutesSeconds(seconds: number) {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    const minutesStr = minutes.toString().padStart(2, '0')
    const secondsStr = remainingSeconds.toString().padStart(2, '0')
    return `${minutesStr}:${secondsStr}`
  }

  function computeFileMeta(
    filePath: string,
    container?: string | null
  ): { fileName: string; fileFormat: string } {
    const baseName = path.basename(filePath)
    const ext = path.extname(filePath)
    const normalizedExt = ext ? ext.slice(1).toUpperCase() : ''
    const fallbackFormat =
      typeof container === 'string' && container.trim() !== '' ? container.trim().toUpperCase() : ''
    return {
      fileName: baseName,
      fileFormat: normalizedExt || fallbackFormat
    }
  }

  function enrichSongInfo(info: ISongInfo): ISongInfo {
    const meta = computeFileMeta(info.filePath, info.container)
    const fileName =
      typeof info.fileName === 'string' && info.fileName.trim() !== ''
        ? info.fileName
        : meta.fileName
    const fileFormat =
      typeof info.fileFormat === 'string' && info.fileFormat.trim() !== ''
        ? info.fileFormat.trim().toUpperCase()
        : meta.fileFormat
    return {
      ...info,
      fileName,
      fileFormat
    }
  }

  const buildScanResult = (
    scanData: ISongInfo[],
    parseMetadataMs: number,
    parsedCount: number,
    failedCount: number,
    cacheIdentityVerified: boolean
  ): ScanSongListResult => {
    const perfAllEnd = Date.now()
    return {
      scanData,
      missingWaveformFilePaths,
      songListUUID,
      playlistTrackNumbering,
      cacheIdentityVerified,
      identityDigest,
      ...(deferWaveformAvailabilityCheck
        ? {
            deferredWaveformAvailabilityCheck: {
              cacheRoot,
              entries: waveformAvailabilityEntries
            }
          }
        : {}),
      perf: {
        listFilesMs: fileScan.listMs,
        cacheCheckMs: perfCacheCheckEnd - perfCacheCheckStart,
        parseMetadataMs,
        totalMs: perfAllEnd - perfAllStart,
        filesCount: filesStatList.length,
        successCount: scanData.length,
        failedCount,
        cacheHits: cachedInfos.length,
        parsedCount,
        cacheLoadedFromDb: cacheFromDb,
        cacheLoadMs: perfCacheLoadMs,
        cacheRows: cacheMap.size,
        cacheMisses,
        cacheRootResolveMs: perfCacheRootResolveMs,
        identityDigestMs: perfIdentityDigestMs,
        waveformAvailabilityMs: perfWaveformAvailabilityMs,
        cacheMatchMs: perfCacheMatchMs,
        metadataModuleLoadMs: perfMetadataModuleLoadMs,
        cacheWriteMs: perfCacheWriteMs,
        cacheWriteDeferred: perfCacheWriteDeferred,
        trackFinalizeMs: perfTrackFinalizeMs,
        statMs: fileScan.statMs,
        listMode: fileScan.mode,
        skippedCount: fileScan.skipped,
        refreshMissingMs: perfRefreshMissing.ms,
        refreshMissingCount: perfRefreshMissing.count,
        refreshMissingChangedCount: perfRefreshMissing.changed
      }
    }
  }

  const writeSongCacheIfNeeded = async (songs: ISongInfo[]) => {
    if (!cacheRoot || !cacheFromDb) return
    const performWrite: DeferredSongCacheWrite = async () => {
      const startedAt = Date.now()
      try {
        const infoMap = new Map<string, ISongInfo>()
        for (const info of songs) {
          infoMap.set(normalizePathKey(info.filePath), enrichSongInfo(info))
        }
        const newEntriesMap = new Map<string, CacheEntry>()
        for (const st of filesStatList) {
          const info = infoMap.get(st.key)
          if (!info) continue
          const nextInfo = { ...info }
          const cached = cacheMap.get(st.key)
          if (cached?.info) {
            preserveCachedKeyAndBpm(nextInfo, cached.info)
            const cachedStatMatches =
              cached.size === st.size && Math.abs(cached.mtimeMs - st.mtimeMs) < 1
            if (cachedStatMatches) {
              preserveCachedGridAnalysisFields(nextInfo, cached.info)
              preserveCachedEnergyAnalysisFields(nextInfo, cached.info)
            }
            if (nextInfo.analysisOnly === undefined && cached.info.analysisOnly) {
              nextInfo.analysisOnly = true
            }
            preserveCachedUserListFields(nextInfo, cached.info)
          }
          newEntriesMap.set(st.file, {
            size: st.size,
            mtimeMs: st.mtimeMs,
            info: enrichSongInfo(nextInfo)
          })
        }
        await LibraryCacheDb.replaceSongCache(cacheRoot, newEntriesMap, {
          // 首开主进程会在收到扫描结果后立即保存同一份视图快照；异步写缓存不能再把
          // 这份新快照标脏，否则会徒增一次后台重扫。
          markSnapshotStale: !options.enqueueDeferredSongCacheWrite
        })
      } catch {
      } finally {
        perfCacheWriteMs += Date.now() - startedAt
      }
    }
    if (options.enqueueDeferredSongCacheWrite) {
      perfCacheWriteDeferred = true
      options.enqueueDeferredSongCacheWrite(performWrite)
      return
    }
    await performWrite()
  }

  const finalizeVerifiedCacheHit = async () => {
    const finalizeStartedAt = Date.now()
    let verifiedSongs = cachedInfos.map((info) => discardStaleAnalysisFields({ ...info }))
    for (const info of verifiedSongs) {
      const key = normalizePathKey(info.filePath)
      const cached = cacheMap.get(key)
      if (!cached?.info) continue
      const cachedInfo = cached.info
      const stat = filesStatByKey.get(key)
      const cachedStatMatches =
        !!stat && cached.size === stat.size && Math.abs(cached.mtimeMs - stat.mtimeMs) < 1
      if (cachedStatMatches) {
        preserveCachedAnalysisFields(info, cachedInfo)
      }
      preserveCachedUserListFields(info, cachedInfo)
    }
    if (cacheRoot) {
      const ensureResult = ensurePlaylistTrackNumbers(verifiedSongs, cacheRoot)
      if (ensureResult.changed) {
        playlistTrackNumbering = {
          initialized: ensureResult.initialized,
          repaired: ensureResult.repaired
        }
      }
      if (ensureResult.changed || perfRefreshMissing.changed > 0) {
        await writeSongCacheIfNeeded(verifiedSongs)
      }
      verifiedSongs = sortSongsByPlaylistTrackNumber(verifiedSongs, cacheRoot)
    }
    if (options.enablePostScanTasks !== false) {
      void scheduleSongListPostScanTasks(scanPath, verifiedSongs, { missingWaveformFilePaths })
    }
    perfTrackFinalizeMs += Date.now() - finalizeStartedAt
    return buildScanResult(verifiedSongs, 0, 0, 0, true)
  }

  // 跨库分析一次批量只读，合并后随本次扫描统一写回，避免逐首同步查询和自动提交阻塞主进程。
  const perfRefreshMissing = { ms: 0, count: 0, changed: 0 }
  const refreshMissingAnalysisFromOtherRoots = async () => {
    if (!cacheFromDb || !cacheRoot || cacheMap.size === 0 || filesStatList.length === 0) return
    const startedAt = Date.now()
    const missingEntries: Array<{ key: string; file: string; entry: CacheEntry }> = []
    for (const st of filesStatList) {
      const entry = cacheMap.get(st.key)
      if (!entry || !entry.info) continue
      const missingAnalysis =
        !hasUsableKeyAnalysis(entry.info) ||
        !hasCompleteGrid(entry.info) ||
        !hasUsableSongEnergyAnalysis(entry.info)
      if (!missingAnalysis) continue
      perfRefreshMissing.count += 1
      missingEntries.push({ key: st.key, file: st.file, entry })
    }
    const sourcesByPath = await LibraryCacheDb.loadSongCacheAnalysisSources(
      cacheRoot,
      missingEntries.map(({ file }) => file)
    )
    for (const { key, file, entry } of missingEntries) {
      const sources = sourcesByPath.get(normalizePathKey(file))
      if (!sources?.length) continue
      const nextInfo = { ...entry.info }
      const before = JSON.stringify(nextInfo)
      for (const source of sources) {
        preserveCachedAnalysisFields(nextInfo, discardStaleAnalysisFields(source))
      }
      if (JSON.stringify(nextInfo) === before) continue
      const refreshed = { ...entry, info: nextInfo }
      cacheMap.set(key, refreshed)
      perfRefreshMissing.changed += 1
      if (nextInfo.analysisOnly) {
        analysisOnlyByPath.set(key, nextInfo)
      }
    }
    perfRefreshMissing.ms += Date.now() - startedAt
  }

  // 磁盘身份与缓存完全一致：直接用缓存出列表，不再解析、不再全量写回。
  if (filesToParse.length === 0) {
    await refreshMissingAnalysisFromOtherRoots()
    return await finalizeVerifiedCacheHit()
  }
  if (options.verifiedOnly) {
    return buildScanResult([], 0, 0, 0, false)
  }

  await refreshMissingAnalysisFromOtherRoots()

  const metadataModuleLoadStartedAt = Date.now()
  const mm = await import('music-metadata')
  perfMetadataModuleLoadMs += Date.now() - metadataModuleLoadStartedAt
  const perfParseStart = Date.now()
  const FALLBACK_ONLY_EXTS = new Set(['.ac3', '.dts', '.tak', '.tta'])

  const tasks: Array<() => Promise<ISongInfo>> = filesToParse.map((url) => async () => {
    const extLower = path.extname(url).toLowerCase()
    if (FALLBACK_ONLY_EXTS.has(extLower)) {
      const meta = computeFileMeta(url, extLower.slice(1))
      return {
        filePath: url,
        fileName: meta.fileName,
        fileFormat: meta.fileFormat,
        cover: null,
        title: meta.fileName,
        artist: undefined,
        album: undefined,
        duration: '',
        genre: undefined,
        label: undefined,
        bitrate: undefined,
        container: meta.fileFormat
      } as ISongInfo
    }
    try {
      // 列表封面由独立的缩略图链路按可见范围加载；冷扫描不读取嵌入图片，
      // 避免为整份歌单搬运大块图片数据。
      const metadata = await mm.parseFile(url, { skipCovers: true })
      const meta = computeFileMeta(url, metadata.format?.container)
      let title =
        metadata.common?.title && metadata.common.title.trim() !== ''
          ? metadata.common.title
          : meta.fileName
      let artist = metadata.common?.artist
      let album = metadata.common?.album
      let genre = metadata.common?.genre?.[0]

      // Windows + WAV：用 LIST/INFO 覆盖明显异常的 common 值（如 '0!0!0!' 或夹杂 \x00）
      if (process.platform === 'win32' && extLower === '.wav') {
        try {
          const info = await readWavRiffInfoWindows(url)
          if (info) {
            const containsNull = (s: string | undefined) =>
              typeof s === 'string' && s.includes('\x00')
            const asciiOnly = (s: string | undefined) =>
              typeof s === 'string' && /^[\x00-\x7F]+$/.test(s)
            const prefer = (primary?: string, fallback?: string) => {
              const p = typeof primary === 'string' ? primary.trim() : ''
              const f = typeof fallback === 'string' ? fallback.trim() : ''
              if (f && (!p || containsNull(primary) || asciiOnly(p))) return f
              return p || f
            }
            title = prefer(title, info.title) || meta.fileName
            artist = prefer(artist, info.artist)
            album = prefer(album, info.album)
            genre = genre && !containsNull(genre) ? genre : info.genre || genre
          }
        } catch {}
      }

      return {
        filePath: url,
        fileName: meta.fileName,
        fileFormat: meta.fileFormat,
        cover: null,
        title,
        artist,
        album,
        duration: convertSecondsToMinutesSeconds(
          metadata.format.duration === undefined ? 0 : Math.round(metadata.format.duration)
        ),
        genre,
        label: metadata.common?.label?.[0],
        bitrate: metadata.format?.bitrate,
        container: metadata.format?.container
      } as ISongInfo
    } catch (error) {
      const meta = computeFileMeta(url, undefined)
      return {
        filePath: url,
        fileName: meta.fileName,
        fileFormat: meta.fileFormat,
        cover: null,
        title: meta.fileName,
        artist: undefined,
        album: undefined,
        duration: '',
        genre: undefined,
        label: undefined,
        bitrate: undefined,
        container: meta.fileFormat
      } as ISongInfo
    }
  })
  const { results, failed } = await runWithConcurrency(tasks, { concurrency: 8 })
  const parsedInfos: ISongInfo[] = results
    .filter((r) => r && !(r instanceof Error))
    .map((info) => enrichSongInfo(info as ISongInfo))
  if (analysisOnlyByPath.size > 0) {
    for (const info of parsedInfos) {
      const cached = analysisOnlyByPath.get(normalizePathKey(info.filePath))
      if (!cached) continue
      preserveCachedAnalysisFields(info, cached)
      const cachedInfo = cacheMap.get(normalizePathKey(info.filePath))?.info
      if (cachedInfo) {
        if (!Array.isArray(info.hotCues) || info.hotCues.length === 0) {
          info.hotCues = normalizeSongHotCues(cachedInfo.hotCues)
        }
        if (!Array.isArray(info.memoryCues) || info.memoryCues.length === 0) {
          info.memoryCues = normalizeSongMemoryCues(cachedInfo.memoryCues)
        }
      }
    }
  }
  songInfoArr = [...cachedInfos, ...parsedInfos]
  songInfoArr = songInfoArr.map(discardStaleAnalysisFields)

  for (const info of songInfoArr) {
    const key = normalizePathKey(info.filePath)
    const cached = cacheMap.get(key)
    const cachedInfo = cached?.info
    if (!cachedInfo) continue
    const stat = filesStatByKey.get(key)
    const cachedStatMatches =
      !!stat && cached.size === stat.size && Math.abs(cached.mtimeMs - stat.mtimeMs) < 1
    if (cachedStatMatches) {
      preserveCachedAnalysisFields(info, cachedInfo)
    }
    preserveCachedUserListFields(info, cachedInfo)
  }

  // Windows 下 WAV：对缓存与新解析的结果做一次统一修正，避免列表残留 '0!0!0!' 或含 \x00 的值
  if (process.platform === 'win32') {
    const refined = await Promise.all(
      songInfoArr.map(async (info) => {
        try {
          if (path.extname(info.filePath).toLowerCase() !== '.wav') return info
          const suspicious = (s?: string) =>
            typeof s === 'string' && (s.includes('\x00') || s === '0!0!0!')
          const needFix =
            suspicious(info.title) ||
            suspicious(info.artist) ||
            suspicious(info.album) ||
            suspicious(info.genre)
          if (!needFix) return info
          const ri = await readWavRiffInfoWindows(info.filePath).catch(() => null)
          if (!ri) return info
          const pick = (primary?: string, fallback?: string) => {
            const p = typeof primary === 'string' ? primary.trim() : ''
            const f = typeof fallback === 'string' ? fallback.trim() : ''
            if (!p || suspicious(p)) return f || p
            return p
          }
          return {
            ...info,
            title: pick(info.title, ri.title) || info.title,
            artist: pick(info.artist, ri.artist) || info.artist,
            album: pick(info.album, ri.album) || info.album,
            genre: pick(info.genre, ri.genre) || info.genre
          }
        } catch {
          return info
        }
      })
    )
    songInfoArr = refined
  }
  const perfParseEnd = Date.now()

  const trackFinalizeStartedAt = Date.now()
  if (cacheRoot) {
    const ensureResult = ensurePlaylistTrackNumbers(songInfoArr, cacheRoot)
    if (ensureResult.changed) {
      playlistTrackNumbering = {
        initialized: ensureResult.initialized,
        repaired: ensureResult.repaired
      }
    }
    songInfoArr = sortSongsByPlaylistTrackNumber(songInfoArr, cacheRoot)
  }
  perfTrackFinalizeMs += Date.now() - trackFinalizeStartedAt

  // 回写缓存
  await writeSongCacheIfNeeded(songInfoArr)

  if (options.enablePostScanTasks !== false) {
    void scheduleSongListPostScanTasks(scanPath, songInfoArr, { missingWaveformFilePaths })
  }

  return buildScanResult(
    songInfoArr,
    perfParseEnd - perfParseStart,
    parsedInfos.length,
    failed,
    false
  )
}
