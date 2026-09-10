import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { sweepSongListCovers } from '../covers'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { getLibraryDb } from '../../libraryDb'
import {
  loadLibraryNodes,
  pruneMissingLibraryNodes,
  type LibraryNodeRow
} from '../../libraryTreeDb'
import { log } from '../../log'
import { requestBackgroundTaskExecution } from '../backgroundOrchestrator'
import { getBackgroundIdleSnapshot } from '../backgroundIdleGate'
import store from '../../store'
import {
  hasUsableKeyAnalysis,
  hasUsableSongBeatGridAnalysis,
  hasRequiredSongStructureAnalysis
} from '../../../shared/songAnalysisCompleteness'
import { hasUsableSongEnergyAnalysis } from '../../../shared/songEnergy'
import type { KeyAnalysisPersistence } from './persistence'
import {
  BACKGROUND_BATCH_SIZE,
  BACKGROUND_CLEAN_BATCH_SIZE,
  BACKGROUND_CLEAN_ROW_LIMIT,
  BACKGROUND_COVER_CLEANUP_BATCH_SIZE,
  BACKGROUND_COVER_CLEANUP_INTERVAL_MS,
  BACKGROUND_FS_DIR_LIMIT,
  BACKGROUND_FS_ENTRY_LIMIT,
  BACKGROUND_FS_REFRESH_MS,
  BACKGROUND_IDLE_DELAY_MS,
  BACKGROUND_LIBRARY_TREE_CLEANUP_INTERVAL_MS,
  BACKGROUND_SCAN_COOLDOWN_MS,
  BACKGROUND_SCAN_ROW_LIMIT,
  normalizePath,
  type BackgroundDirItem,
  type DirHandle,
  type DoneEntry,
  type KeyAnalysisBackgroundStatus,
  type KeyAnalysisJob,
  type KeyAnalysisPriority,
  type KeyAnalysisSource
} from './types'

type CachedAnalysisInfo = {
  key?: unknown
  keyAnalysisAlgorithmVersion?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  beatThisWindowCount?: unknown
  beatGridAlgorithmVersion?: unknown
  beatGridSource?: unknown
  beatGridStatus?: unknown
  beatGridMap?: unknown
  energyScore?: unknown
  songStructure?: unknown
}

const BACKGROUND_EXCLUDED_CORE_LIBRARY_DIRS = new Set([
  'setlibrary',
  'mixtapelibrary',
  'recyclebin',
  'recordinglibrary'
])

type KeyAnalysisBackgroundDeps = {
  events: EventEmitter
  enqueueList: (
    filePaths: string[],
    priority: KeyAnalysisPriority,
    options?: {
      urgent?: boolean
      source?: KeyAnalysisSource
      fastAnalysis?: boolean
      includeStructure?: boolean
    }
  ) => void
  clearPendingBackground: () => void
  hasForegroundWork: () => boolean
  isIdle: () => boolean
  countBackgroundInFlight: () => number
  getPendingBackgroundCount: () => number
  pendingByPath: Map<string, KeyAnalysisJob>
  activeByPath: Map<string, KeyAnalysisJob>
  doneByPath: Map<string, DoneEntry>
  persistence: KeyAnalysisPersistence
}

export const createKeyAnalysisBackground = (deps: KeyAnalysisBackgroundDeps) => {
  let backgroundTimer: ReturnType<typeof setTimeout> | null = null
  let backgroundScanInProgress = false
  let backgroundCursor = 0
  let backgroundLastScanAt = 0
  let backgroundRoots: string[] = []
  let backgroundRootsSignature = ''
  let backgroundRootIndex = 0
  let backgroundDirQueue: BackgroundDirItem[] = []
  let backgroundRootsLastRefresh = 0
  let backgroundCleanCursor = 0
  let backgroundEnabled = true
  let backgroundResumeTimer: ReturnType<typeof setTimeout> | null = null
  let lastForegroundAt = 0
  let backgroundProcessingJobs = new Set<number>()
  let lastBackgroundStatus: KeyAnalysisBackgroundStatus | null = null
  let lastLibraryTreeCleanupAt = 0
  let lastCoverCleanupAt = 0
  let coverCleanupRootIndex = 0

  const getBackgroundStatus = (): KeyAnalysisBackgroundStatus => {
    const pending = deps.getPendingBackgroundCount()
    const inFlight = deps.countBackgroundInFlight()
    const processing = backgroundProcessingJobs.size
    const scanInProgress = backgroundScanInProgress
    const enabled = backgroundEnabled
    const active = enabled && (processing > 0 || inFlight > 0 || pending > 0)
    return { active, pending, inFlight, processing, scanInProgress, enabled }
  }

  const emitBackgroundStatus = () => {
    const next = getBackgroundStatus()
    const prev = lastBackgroundStatus
    if (prev && prev.active === next.active && prev.enabled === next.enabled) {
      return
    }
    lastBackgroundStatus = next
    deps.events.emit('background-status', next)
  }

  const getBackgroundStatusSnapshot = (): KeyAnalysisBackgroundStatus => getBackgroundStatus()

  const isEnabled = () => backgroundEnabled

  const canUseAggressiveConcurrency = () => {
    if (!backgroundEnabled) return false
    if (deps.hasForegroundWork()) return false
    const idleSnapshot = getBackgroundIdleSnapshot()
    return idleSnapshot.allowed && idleSnapshot.profile === 'deep-idle'
  }

  const touchForeground = () => {
    lastForegroundAt = Date.now()
  }

  const clearBackgroundTimer = () => {
    if (backgroundTimer) {
      clearTimeout(backgroundTimer)
      backgroundTimer = null
    }
  }

  const clearBackgroundResumeTimer = () => {
    if (backgroundResumeTimer) {
      clearTimeout(backgroundResumeTimer)
      backgroundResumeTimer = null
    }
  }

  const scheduleBackgroundScan = () => {
    if (!backgroundEnabled) return
    if (backgroundTimer) return
    if (!deps.isIdle()) return
    const now = Date.now()
    const idleDelay = Math.max(BACKGROUND_IDLE_DELAY_MS - (now - lastForegroundAt), 0)
    const cooldownDelay = Math.max(BACKGROUND_SCAN_COOLDOWN_MS - (now - backgroundLastScanAt), 0)
    const delay = Math.max(idleDelay, cooldownDelay)
    backgroundTimer = setTimeout(() => {
      backgroundTimer = null
      requestBackgroundTaskExecution({
        category: 'key-analysis',
        trigger: 'key-analysis-timer',
        run: runBackgroundScan
      })
    }, delay)
  }

  const startBackgroundSweep = () => {
    if (!backgroundEnabled) return
    if (backgroundTimer) return
    if (deps.isIdle()) {
      scheduleBackgroundScan()
    }
    emitBackgroundStatus()
  }

  const cancelBackgroundWork = (pauseMs?: number) => {
    const resumeDelay = Number.isFinite(pauseMs) && pauseMs && pauseMs > 0 ? pauseMs : 0
    backgroundEnabled = false
    clearBackgroundTimer()
    clearBackgroundResumeTimer()
    deps.clearPendingBackground()
    if (resumeDelay > 0) {
      backgroundResumeTimer = setTimeout(() => {
        backgroundEnabled = true
        backgroundResumeTimer = null
        emitBackgroundStatus()
        if (deps.isIdle()) {
          scheduleBackgroundScan()
        }
      }, resumeDelay)
    }
    emitBackgroundStatus()
  }

  const markProcessing = (jobId: number) => {
    backgroundProcessingJobs.add(jobId)
  }

  const unmarkProcessing = (jobId: number) => {
    backgroundProcessingJobs.delete(jobId)
  }

  const getAudioExtensions = (): Set<string> => {
    const result = new Set<string>()
    const raw = store.settingConfig?.audioExt
    if (!Array.isArray(raw)) return result
    for (const item of raw) {
      if (!item) continue
      let ext = String(item).trim().toLowerCase()
      if (!ext) continue
      if (!ext.startsWith('.')) ext = `.${ext}`
      result.add(ext)
    }
    return result
  }

  const isExcludedCoreLibraryAbsPath = (absPath: string) => {
    const rootDir = store.databaseDir
    if (!rootDir || !absPath) return false
    const libraryRoot = path.join(rootDir, 'library')
    const rel = path.relative(libraryRoot, path.resolve(absPath))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
    const firstSegment = rel.split(/[\\/]/)[0]?.toLowerCase()
    return !!firstSegment && BACKGROUND_EXCLUDED_CORE_LIBRARY_DIRS.has(firstSegment)
  }

  const resolveSongListRoots = (): string[] => {
    const rootDir = store.databaseDir
    if (!rootDir) return []
    const rows: LibraryNodeRow[] = loadLibraryNodes(rootDir) || []
    const root = rows.find((row) => row.parentUuid === null && row.nodeType === 'root')
    if (!root) return []
    const childrenMap = new Map<string, LibraryNodeRow[]>()
    for (const row of rows) {
      if (!row.parentUuid) continue
      const list = childrenMap.get(row.parentUuid)
      if (list) {
        list.push(row)
      } else {
        childrenMap.set(row.parentUuid, [row])
      }
    }
    const pathByUuid = new Map<string, string>()
    pathByUuid.set(root.uuid, root.dirName)
    const queue: LibraryNodeRow[] = [root]
    for (let i = 0; i < queue.length; i += 1) {
      const parent = queue[i]
      const parentPath = pathByUuid.get(parent.uuid)
      if (!parentPath) continue
      const children = childrenMap.get(parent.uuid) || []
      for (const child of children) {
        const childPath = path.join(parentPath, child.dirName)
        if (!pathByUuid.has(child.uuid)) {
          pathByUuid.set(child.uuid, childPath)
          queue.push(child)
        }
      }
    }
    const roots: string[] = []
    for (const row of rows) {
      if (row.nodeType !== 'songList') continue
      const rel = pathByUuid.get(row.uuid)
      if (!rel) continue
      const normalizedRel = rel.replace(/\\/g, '/').toLowerCase()
      if (
        normalizedRel.startsWith('library/setlibrary/') ||
        normalizedRel.startsWith('library/mixtapelibrary/') ||
        normalizedRel.startsWith('library/recyclebin/') ||
        normalizedRel.startsWith('library/recordinglibrary/')
      ) {
        continue
      }
      roots.push(path.join(rootDir, rel))
    }
    return roots
  }

  const resolveSongListRootsFromFs = async (): Promise<string[]> => {
    const rootDir = store.databaseDir
    if (!rootDir) return []
    const libraryRoot = path.join(rootDir, 'library')
    let libraryEntries: Dirent[] = []
    try {
      libraryEntries = await fs.readdir(libraryRoot, { withFileTypes: true })
    } catch {
      return []
    }

    const roots: string[] = []
    for (const libraryEntry of libraryEntries) {
      if (!libraryEntry.isDirectory()) continue
      if (libraryEntry.name.startsWith('.')) continue
      if (BACKGROUND_EXCLUDED_CORE_LIBRARY_DIRS.has(libraryEntry.name.toLowerCase())) {
        continue
      }
      const libraryDir = path.join(libraryRoot, libraryEntry.name)
      let songListEntries: Dirent[] = []
      try {
        songListEntries = await fs.readdir(libraryDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const songListEntry of songListEntries) {
        if (!songListEntry.isDirectory()) continue
        if (songListEntry.name.startsWith('.') || songListEntry.name === '.frkb_covers') continue
        roots.push(path.join(libraryDir, songListEntry.name))
      }
    }

    return roots
  }

  const mergeSongListRoots = (...groups: string[][]): string[] => {
    const deduped = new Map<string, string>()
    for (const group of groups) {
      for (const root of group) {
        const normalized = normalizePath(root)
        if (!normalized || deduped.has(normalized)) continue
        deduped.set(normalized, root)
      }
    }
    return Array.from(deduped.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, root]) => root)
  }

  const refreshBackgroundRoots = async (): Promise<string[]> => {
    const now = Date.now()
    const shouldRefresh =
      now - backgroundRootsLastRefresh >= BACKGROUND_FS_REFRESH_MS || backgroundRoots.length === 0
    if (!shouldRefresh) return backgroundRoots
    const nodeRoots = resolveSongListRoots()
    const fsRoots = await resolveSongListRootsFromFs()
    const nextRoots = mergeSongListRoots(nodeRoots, fsRoots)
    const signature = nextRoots.join('|')
    if (signature !== backgroundRootsSignature) {
      backgroundDirQueue = []
      backgroundRootIndex = 0
      backgroundRootsSignature = signature
    }
    backgroundRoots = nextRoots
    backgroundRootsLastRefresh = now
    return backgroundRoots
  }

  const runPeriodicMaintenanceTasks = async (now: number) => {
    if (deps.hasForegroundWork()) return

    if (now - lastLibraryTreeCleanupAt >= BACKGROUND_LIBRARY_TREE_CLEANUP_INTERVAL_MS) {
      try {
        const removed = await pruneMissingLibraryNodes()
        if (removed > 0) {
          deps.events.emit('library-tree-cleaned', { removed })
        }
        lastLibraryTreeCleanupAt = now
      } catch {}
    }

    if (deps.hasForegroundWork()) return

    if (now - lastCoverCleanupAt >= BACKGROUND_COVER_CLEANUP_INTERVAL_MS) {
      try {
        await cleanupOrphanedCovers()
        lastCoverCleanupAt = now
      } catch {}
    }
  }

  const cleanupOrphanedCovers = async () => {
    const roots = await refreshBackgroundRoots()
    if (roots.length === 0) return

    const audioExts = getAudioExtensions()
    if (audioExts.size === 0) return

    const startIndex = coverCleanupRootIndex % roots.length
    const endIndex = Math.min(startIndex + BACKGROUND_COVER_CLEANUP_BATCH_SIZE, roots.length)

    for (let i = startIndex; i < endIndex; i++) {
      if (deps.hasForegroundWork()) break
      const listRoot = roots[i]
      try {
        const currentFilePaths = await collectAudioFilesInRoot(listRoot, audioExts)
        if (deps.hasForegroundWork()) break
        await sweepSongListCovers(listRoot, currentFilePaths)
      } catch {}
    }

    coverCleanupRootIndex = endIndex >= roots.length ? 0 : endIndex
  }

  const collectAudioFilesInRoot = async (
    listRoot: string,
    audioExts: Set<string>
  ): Promise<string[]> => {
    const filePaths: string[] = []
    const queue: string[] = [listRoot]

    while (queue.length > 0 && !deps.hasForegroundWork()) {
      const dir = queue.shift()
      if (!dir) break
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === '.frkb_covers') continue
            queue.push(path.join(dir, entry.name))
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (audioExts.has(ext)) {
              filePaths.push(path.join(dir, entry.name))
            }
          }
        }
      } catch {}
    }

    return filePaths
  }

  const collectBackgroundCandidates = async (limit: number): Promise<string[]> => {
    if (!backgroundEnabled) return []
    const fromCache = await collectBackgroundCacheCandidates(limit)
    if (fromCache.length > 0) return fromCache
    return collectBackgroundFsCandidates(limit)
  }

  const collectBackgroundCacheCandidates = async (limit: number): Promise<string[]> => {
    const results: string[] = []
    if (limit <= 0) return results
    const db = getLibraryDb()
    if (!db) return results
    let rows: Array<{
      rowId: number
      list_root: string
      file_path: string
      info_json: string
      size: number
      mtime_ms: number
    }> = []
    try {
      const stmt = db.prepare<{
        rowId: number
        list_root: string
        file_path: string
        info_json: string
        size: number
        mtime_ms: number
      }>(
        'SELECT rowid as rowId, list_root, file_path, info_json, size, mtime_ms FROM song_cache WHERE rowid > ? ORDER BY rowid LIMIT ?'
      )
      rows = stmt.all(backgroundCursor, BACKGROUND_SCAN_ROW_LIMIT)
    } catch {
      return results
    }
    if (!rows || rows.length === 0) {
      if (backgroundCursor !== 0) {
        backgroundCursor = 0
      }
      return results
    }
    type EvaluatedRow = {
      rowId: number
      absFilePath?: string
      size?: number
      mtimeMs?: number
      needsCoreAnalysis?: boolean
    }
    const evaluatedRows: EvaluatedRow[] = []
    const waveformChecksByRoot = new Map<
      string,
      Array<{ rowId: number; filePath: string; size: number; mtimeMs: number }>
    >()
    for (const row of rows) {
      const rowId = Number(row?.rowId)
      if (!Number.isFinite(rowId)) continue
      const evaluated: EvaluatedRow = { rowId }
      evaluatedRows.push(evaluated)
      const filePath = typeof row?.file_path === 'string' ? row.file_path.trim() : ''
      if (!filePath) continue
      let info: CachedAnalysisInfo | null = null
      try {
        info = JSON.parse(String(row?.info_json || '{}')) as CachedAnalysisInfo
      } catch {
        info = null
      }
      const hasKey = hasUsableKeyAnalysis(info)
      const hasBpm = hasUsableSongBeatGridAnalysis(info)
      const hasEnergy = hasUsableSongEnergyAnalysis(info)
      const hasStructure = hasRequiredSongStructureAnalysis(info)
      const listRoot = typeof row?.list_root === 'string' ? row.list_root.trim() : ''
      if (!listRoot) continue
      const absFilePath = LibraryCacheDb.resolveCacheFilePath(listRoot, filePath)
      if (!absFilePath) continue
      if (isExcludedCoreLibraryAbsPath(absFilePath)) continue
      evaluated.absFilePath = absFilePath
      evaluated.needsCoreAnalysis = !hasKey || !hasBpm || !hasEnergy || !hasStructure
      if (evaluated.needsCoreAnalysis) continue
      const size = Number(row?.size)
      const mtimeMs = Number(row?.mtime_ms)
      if (Number.isFinite(size) && Number.isFinite(mtimeMs)) {
        evaluated.size = size
        evaluated.mtimeMs = mtimeMs
        const checks = waveformChecksByRoot.get(listRoot)
        const check = { rowId, filePath: absFilePath, size, mtimeMs }
        if (checks) checks.push(check)
        else waveformChecksByRoot.set(listRoot, [check])
      }
    }

    const waveformAvailableByRowId = new Map<number, boolean>()
    for (const [listRoot, checks] of waveformChecksByRoot) {
      const availability = LibraryCacheDb.loadWaveformSurfaceAvailabilityByMeta(listRoot, checks)
      for (const check of checks) {
        waveformAvailableByRowId.set(check.rowId, availability.get(check.filePath) === true)
      }
      // A library may contain many small playlists. Let timers and foreground IPC run between
      // playlist groups instead of draining every synchronous SQLite batch in one turn.
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (deps.hasForegroundWork()) return results
    }

    let processedAll = true
    let lastRowId = backgroundCursor
    for (const evaluated of evaluatedRows) {
      lastRowId = evaluated.rowId
      if (!evaluated.absFilePath) continue
      const needsAnalysis =
        evaluated.needsCoreAnalysis === true ||
        evaluated.size === undefined ||
        evaluated.mtimeMs === undefined ||
        waveformAvailableByRowId.get(evaluated.rowId) !== true
      if (!needsAnalysis) continue
      results.push(evaluated.absFilePath)
      if (results.length >= limit) {
        processedAll = false
        break
      }
    }
    backgroundCursor = lastRowId
    if (processedAll && rows.length < BACKGROUND_SCAN_ROW_LIMIT) {
      backgroundCursor = 0
    }
    return results
  }

  const collectBackgroundFsCandidates = async (limit: number): Promise<string[]> => {
    const results: string[] = []
    if (limit <= 0 || !store.databaseDir || deps.hasForegroundWork()) return results
    const roots = await refreshBackgroundRoots()
    if (roots.length === 0) return results
    const audioExts = getAudioExtensions()
    if (audioExts.size === 0) return results

    let dirsProcessed = 0
    while (results.length < limit && dirsProcessed < BACKGROUND_FS_DIR_LIMIT) {
      if (deps.hasForegroundWork()) break
      if (backgroundDirQueue.length === 0) {
        const nextRoot = roots[backgroundRootIndex % roots.length]
        backgroundRootIndex = (backgroundRootIndex + 1) % roots.length
        if (!nextRoot) break
        backgroundDirQueue.push({ dir: nextRoot, listRoot: nextRoot })
      }
      const current = backgroundDirQueue.shift()
      if (!current) break
      dirsProcessed += 1
      let dirHandle: DirHandle
      try {
        dirHandle = await fs.opendir(current.dir)
      } catch {
        continue
      }
      let entryCount = 0
      try {
        for await (const entry of dirHandle) {
          if (entryCount >= BACKGROUND_FS_ENTRY_LIMIT) break
          if (deps.hasForegroundWork()) break
          entryCount += 1
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === '.frkb_covers') continue
            const childDir = path.join(current.dir, entry.name)
            backgroundDirQueue.push({ dir: childDir, listRoot: current.listRoot })
            continue
          }
          if (!entry.isFile()) continue
          const ext = path.extname(entry.name).toLowerCase()
          if (!audioExts.has(ext)) continue
          const filePath = path.join(current.dir, entry.name)
          if (isExcludedCoreLibraryAbsPath(filePath)) continue
          const normalizedPath = normalizePath(filePath)
          if (deps.pendingByPath.has(normalizedPath) || deps.activeByPath.has(normalizedPath)) {
            continue
          }
          const cached = await LibraryCacheDb.loadSongCacheEntry(current.listRoot, filePath)
          if (cached === undefined) continue
          const hasKey = hasUsableKeyAnalysis(cached?.info)
          const hasBpm = hasUsableSongBeatGridAnalysis(cached?.info)
          const hasEnergy = hasUsableSongEnergyAnalysis(cached?.info)
          const hasStructure = hasRequiredSongStructureAnalysis(cached?.info)
          let hasWaveform = false
          if (cached && Number.isFinite(cached.size) && Number.isFinite(cached.mtimeMs)) {
            hasWaveform = await LibraryCacheDb.hasWaveformSurfaceCacheEntryByMeta(
              current.listRoot,
              filePath,
              cached.size,
              cached.mtimeMs
            )
          }
          if (!cached || !hasKey || !hasBpm || !hasEnergy || !hasWaveform || !hasStructure) {
            results.push(filePath)
            if (results.length >= limit) break
          }
        }
      } finally {
        try {
          await dirHandle.close()
        } catch {}
      }
    }
    return results
  }

  const cleanupMissingCacheEntries = async (limit: number): Promise<number> => {
    if (limit <= 0) return 0
    if (deps.hasForegroundWork()) return 0
    const db = getLibraryDb()
    if (!db) return 0
    let rows: Array<{ rowId: number; list_root: string; file_path: string }> = []
    try {
      const stmt = db.prepare<{ rowId: number; list_root: string; file_path: string }>(
        'SELECT rowid as rowId, list_root, file_path FROM song_cache WHERE rowid > ? ORDER BY rowid LIMIT ?'
      )
      rows = stmt.all(backgroundCleanCursor, BACKGROUND_CLEAN_ROW_LIMIT)
    } catch {
      return 0
    }
    if (!rows || rows.length === 0) {
      if (backgroundCleanCursor !== 0) {
        backgroundCleanCursor = 0
      }
      return 0
    }
    let removed = 0
    let lastRowId = backgroundCleanCursor
    const listRootExistsCache = new Map<string, boolean>()
    for (const row of rows) {
      if (deps.hasForegroundWork()) break
      const rowId = Number(row?.rowId)
      if (!Number.isFinite(rowId)) continue
      lastRowId = rowId
      const listRoot = typeof row?.list_root === 'string' ? row.list_root.trim() : ''
      const filePath = typeof row?.file_path === 'string' ? row.file_path.trim() : ''
      if (!listRoot || !filePath) continue
      const absListRoot = LibraryCacheDb.resolveCacheListRootAbs(listRoot)
      const absFilePath = LibraryCacheDb.resolveCacheFilePath(listRoot, filePath)
      if (!absListRoot || !absFilePath) continue
      let listRootExists = listRootExistsCache.get(absListRoot)
      if (listRootExists === undefined) {
        try {
          const st = await fs.stat(absListRoot)
          listRootExists = st.isDirectory()
        } catch {
          listRootExists = false
        }
        listRootExistsCache.set(absListRoot, listRootExists)
      }
      if (!listRootExists) continue
      let fileExists = false
      try {
        const st = await fs.stat(absFilePath)
        fileExists = st.isFile()
      } catch {
        fileExists = false
      }
      if (fileExists) continue
      await LibraryCacheDb.removeSongCacheEntry(listRoot, absFilePath)
      await LibraryCacheDb.removeWaveformCacheEntry(listRoot, absFilePath)
      await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, absFilePath)
      await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, absFilePath)
      await LibraryCacheDb.removeWaveformSurfaceCacheEntry(listRoot, absFilePath)
      await deps.persistence.removeCoverCacheForMissingTrack(listRoot, absFilePath)
      deps.doneByPath.delete(normalizePath(absFilePath))
      removed += 1
      if (removed >= limit) break
    }
    backgroundCleanCursor = lastRowId
    if (rows.length < BACKGROUND_CLEAN_ROW_LIMIT) {
      backgroundCleanCursor = 0
    }
    return removed
  }

  const runBackgroundScan = async () => {
    if (!backgroundEnabled) return
    if (backgroundScanInProgress) return
    if (!deps.isIdle()) return
    const now = Date.now()
    if (now - lastForegroundAt < BACKGROUND_IDLE_DELAY_MS) {
      scheduleBackgroundScan()
      return
    }
    if (now - backgroundLastScanAt < BACKGROUND_SCAN_COOLDOWN_MS) {
      scheduleBackgroundScan()
      return
    }
    backgroundScanInProgress = true
    backgroundLastScanAt = now
    emitBackgroundStatus()
    try {
      const candidates = await collectBackgroundCandidates(BACKGROUND_BATCH_SIZE)
      if (backgroundEnabled) {
        if (candidates.length > 0) {
          deps.enqueueList(candidates, 'background', {
            source: 'background',
            includeStructure: true
          })
        } else {
          const cleaned = await cleanupMissingCacheEntries(BACKGROUND_CLEAN_BATCH_SIZE)
          if (cleaned === 0 && !deps.hasForegroundWork()) {
            await runPeriodicMaintenanceTasks(now)
          }
        }
      }
    } catch (error) {
      log.error('[闲时分析] 扫描过程出错', error)
    } finally {
      backgroundScanInProgress = false
      emitBackgroundStatus()
      if (deps.isIdle()) {
        scheduleBackgroundScan()
      }
    }
  }

  return {
    cancelBackgroundWork,
    clearBackgroundTimer,
    emitBackgroundStatus,
    getBackgroundStatusSnapshot,
    isEnabled,
    canUseAggressiveConcurrency,
    markProcessing,
    scheduleBackgroundScan,
    startBackgroundSweep,
    touchForeground,
    unmarkProcessing
  }
}

export type KeyAnalysisBackground = ReturnType<typeof createKeyAnalysisBackground>
