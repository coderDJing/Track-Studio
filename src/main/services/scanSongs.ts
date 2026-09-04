import path = require('path')
import { runWithConcurrency } from '../nodeTaskUtils'
import { ISongInfo } from '../../types/globals'
import { readWavRiffInfoWindows } from './wavRiffInfo'
import {
  listPlaylistAudioFiles,
  normalizePlaylistPathKey,
  resolvePlaylistCacheRoot,
  statPlaylistAudioFiles
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

type ScanSongListOptions = {
  enablePostScanTasks?: boolean
  /** 只做磁盘身份核对 + 缓存命中，不解析新文件。核对失败时返回空列表并标记 cacheIdentityVerified=false。 */
  verifiedOnly?: boolean
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
    cacheLoadMs: number
    cacheRows: number
    statMs: number
    refreshMissingMs: number
    refreshMissingCount: number
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

// 扫描歌单目录，带 SQLite 缓存
export async function scanSongList(
  scanPath: string | string[],
  audioExt: string[],
  songListUUID: string,
  options: ScanSongListOptions = {}
): Promise<ScanSongListResult> {
  const perfAllStart = Date.now()
  const perfListStart = Date.now()
  let songInfoArr: ISongInfo[] = []
  let playlistTrackNumbering: {
    initialized: boolean
    repaired: boolean
  } | null = null

  const songFileUrls = await listPlaylistAudioFiles(scanPath, audioExt)
  const perfListEnd = Date.now()
  const normalizePathKey = normalizePlaylistPathKey

  type CacheEntry = {
    size: number
    mtimeMs: number
    info: ISongInfo
  }
  const cacheRoot = await resolvePlaylistCacheRoot(scanPath)
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
  const filesStatList = await statPlaylistAudioFiles(songFileUrls)
  const perfStatMs = Date.now() - perfCacheCheckStart
  const identityDigest = computePlaylistIdentityDigest(filesStatList)
  const filesStatByKey = new Map(filesStatList.map((item) => [item.key, item]))
  const waveformAvailability = cacheRoot
    ? LibraryCacheDb.loadWaveformSurfaceAvailabilityByMeta(
        cacheRoot,
        filesStatList.map((item) => ({
          filePath: item.file,
          size: item.size,
          mtimeMs: item.mtimeMs
        }))
      )
    : new Map<string, boolean>()
  const missingWaveformFilePaths = cacheRoot
    ? filesStatList
        .filter((item) => waveformAvailability.get(item.file) !== true)
        .map((item) => item.file)
    : []
  const cachedInfos: ISongInfo[] = []
  const filesToParse: string[] = []
  const analysisOnlyByPath = new Map<string, ISongInfo>()
  const isAnalysisOnly = (info?: ISongInfo | null): boolean => Boolean(info?.analysisOnly)
  for (const it of filesStatList) {
    const c = cacheMap.get(it.key)
    if (c && c.size === it.size && Math.abs(c.mtimeMs - it.mtimeMs) < 1) {
      if (isAnalysisOnly(c.info)) {
        analysisOnlyByPath.set(it.key, c.info)
        filesToParse.push(it.file)
      } else {
        cachedInfos.push(
          enrichSongInfo(discardStaleAnalysisFields({ ...c.info, filePath: it.file }))
        )
      }
    } else {
      filesToParse.push(it.file)
    }
  }
  const perfCacheCheckEnd = Date.now()

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
      perf: {
        listFilesMs: perfListEnd - perfListStart,
        cacheCheckMs: perfCacheCheckEnd - perfCacheCheckStart,
        parseMetadataMs,
        totalMs: perfAllEnd - perfAllStart,
        filesCount: songFileUrls.length,
        successCount: scanData.length,
        failedCount,
        cacheHits: cachedInfos.length,
        parsedCount,
        cacheLoadMs: perfCacheLoadMs,
        cacheRows: cacheMap.size,
        statMs: perfStatMs,
        refreshMissingMs: perfRefreshMissing.ms,
        refreshMissingCount: perfRefreshMissing.count
      }
    }
  }

  const writeSongCacheIfNeeded = async (songs: ISongInfo[]) => {
    if (!cacheRoot || !cacheFromDb) return
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
      await LibraryCacheDb.replaceSongCache(cacheRoot, newEntriesMap)
    } catch {}
  }

  const finalizeVerifiedCacheHit = async () => {
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
        await writeSongCacheIfNeeded(verifiedSongs)
      }
      verifiedSongs = sortSongsByPlaylistTrackNumber(verifiedSongs, cacheRoot)
    }
    if (options.enablePostScanTasks !== false) {
      void scheduleSongListPostScanTasks(scanPath, verifiedSongs, { missingWaveformFilePaths })
    }
    return buildScanResult(verifiedSongs, 0, 0, 0, true)
  }

  // 跨库补分析是"每首一次 loadSongCacheEntry"的串行开销，且 loadSongCacheEntry 内部
  // 还可能做非索引松散比较与写回，因此单独计量，别混进 cacheCheckMs 里看不出来。
  const perfRefreshMissing = { ms: 0, count: 0 }
  const refreshMissingAnalysisFromOtherRoots = async () => {
    if (!cacheFromDb || !cacheRoot || cacheMap.size === 0 || filesStatList.length === 0) return
    const startedAt = Date.now()
    for (const st of filesStatList) {
      const entry = cacheMap.get(st.key)
      if (!entry || !entry.info) continue
      const missingAnalysis =
        !hasUsableKeyAnalysis(entry.info) ||
        !hasCompleteGrid(entry.info) ||
        !hasUsableSongEnergyAnalysis(entry.info)
      if (!missingAnalysis) continue
      perfRefreshMissing.count += 1
      const refreshed = await LibraryCacheDb.loadSongCacheEntry(cacheRoot, st.file)
      if (refreshed?.info) {
        cacheMap.set(st.key, refreshed)
        if (refreshed.info.analysisOnly) {
          analysisOnlyByPath.set(st.key, refreshed.info)
        }
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

  const mm = await import('music-metadata')
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
      const metadata = await mm.parseFile(url)
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
