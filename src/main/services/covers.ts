import path = require('path')
import fs = require('fs-extra')
import { operateHiddenFile, resolveLibraryPath } from '../utils'
import * as LibraryCacheDb from '../libraryCacheDb'
import { log } from '../log'
import {
  extractCoverOffMainThread,
  getCoverExtractionWorkerDiagnosticSnapshot,
  type CoverExtractionTiming
} from './coverExtractionWorker'
import { runPlaybackAwareBackgroundFileIo, type FileIoPriority } from './playbackForegroundActivity'
import { isPackagedRcBuild } from './rcDiagnostics'

const DISPLAY_CACHE_MARKER = '.display-v1'
const COVER_THUMB_MAX_CONCURRENCY = 3
const RECENT_COVER_DIAGNOSTIC_TTL_MS = 60_000
const MAX_RECENT_COVER_DIAGNOSTICS = 24
const SLOW_COVER_OPERATION_THRESHOLD_MS = 1_000
const coverSlowDiagnosticsEnabled = isPackagedRcBuild()
let pendingPostScanSweepTimer: NodeJS.Timeout | null = null
let activeCoverThumbTasks = 0
let coverThumbTaskSequence = 0
let coverDiagnosticSequence = 0
const pendingCoverThumbTasks: Array<{
  priority: number
  sequence: number
  queuedAtMs: number
  resolve: () => void
}> = []

type CoverDiagnosticKind = 'thumbnail' | 'persist-display-cache'
type CoverDiagnosticPhase =
  | 'waiting-cover-slot'
  | 'resolving-cache-root'
  | 'loading-cache-index'
  | 'preparing-cache-directory'
  | 'reading-cache-file'
  | 'waiting-extraction-file-io'
  | 'hashing-source-image'
  | 'waiting-persist-file-io'
  | 'preparing-persist-data'
  | 'writing-display-cache'
  | 'updating-cache-index'
  | 'removing-legacy-cache'
  | 'completed'

type CoverDiagnosticOperation = {
  id: number
  kind: CoverDiagnosticKind
  fileName: string
  priority: 'visible' | 'prefetch'
  requestedSize?: number
  phase: CoverDiagnosticPhase
  startedAtMs: number
  phaseStartedAtMs: number
  phaseDurationsMs: Partial<Record<CoverDiagnosticPhase, number>>
  endedAtMs?: number
  sourceBytes?: number
  outputBytes?: number
  cacheStatus?: CoverThumbResult['cacheStatus']
  workerTiming?: CoverExtractionTiming
  outcome?: 'success' | 'empty' | 'aborted' | 'error'
}

const activeCoverDiagnostics = new Map<number, CoverDiagnosticOperation>()
const recentCoverDiagnostics: CoverDiagnosticOperation[] = []

const startCoverDiagnostic = (params: {
  kind: CoverDiagnosticKind
  filePath: string
  priority: 'visible' | 'prefetch'
  requestedSize?: number
  phase: CoverDiagnosticPhase
}): CoverDiagnosticOperation => {
  const nowMs = Date.now()
  const operation: CoverDiagnosticOperation = {
    id: ++coverDiagnosticSequence,
    kind: params.kind,
    fileName: path.basename(params.filePath),
    priority: params.priority,
    requestedSize: params.requestedSize,
    phase: params.phase,
    startedAtMs: nowMs,
    phaseStartedAtMs: nowMs,
    phaseDurationsMs: {}
  }
  activeCoverDiagnostics.set(operation.id, operation)
  return operation
}

const markCoverDiagnosticPhase = (
  operation: CoverDiagnosticOperation,
  phase: CoverDiagnosticPhase
) => {
  const nowMs = Date.now()
  operation.phaseDurationsMs[operation.phase] =
    (operation.phaseDurationsMs[operation.phase] || 0) +
    Math.max(0, nowMs - operation.phaseStartedAtMs)
  operation.phase = phase
  operation.phaseStartedAtMs = nowMs
}

const pruneRecentCoverDiagnostics = (nowMs = Date.now()) => {
  while (
    recentCoverDiagnostics.length > 0 &&
    nowMs - (recentCoverDiagnostics[0].endedAtMs ?? recentCoverDiagnostics[0].startedAtMs) >
      RECENT_COVER_DIAGNOSTIC_TTL_MS
  ) {
    recentCoverDiagnostics.shift()
  }
}

const completeCoverDiagnostic = (
  operation: CoverDiagnosticOperation,
  outcome: NonNullable<CoverDiagnosticOperation['outcome']>
) => {
  markCoverDiagnosticPhase(operation, 'completed')
  operation.endedAtMs = Date.now()
  operation.outcome = outcome
  activeCoverDiagnostics.delete(operation.id)
  recentCoverDiagnostics.push(operation)
  pruneRecentCoverDiagnostics()
  if (recentCoverDiagnostics.length > MAX_RECENT_COVER_DIAGNOSTICS) {
    recentCoverDiagnostics.splice(0, recentCoverDiagnostics.length - MAX_RECENT_COVER_DIAGNOSTICS)
  }

  const durationMs = Math.max(0, operation.endedAtMs - operation.startedAtMs)
  if (coverSlowDiagnosticsEnabled && durationMs >= SLOW_COVER_OPERATION_THRESHOLD_MS) {
    log.info('[cover-diagnostics] slow operation', {
      kind: operation.kind,
      fileName: operation.fileName,
      priority: operation.priority,
      requestedSize: operation.requestedSize,
      durationMs,
      phaseDurationsMs: operation.phaseDurationsMs,
      sourceBytes: operation.sourceBytes,
      outputBytes: operation.outputBytes,
      cacheStatus: operation.cacheStatus,
      workerTiming: operation.workerTiming,
      outcome: operation.outcome
    })
  }
}

const summarizeCoverDiagnostic = (operation: CoverDiagnosticOperation, nowMs: number) => ({
  kind: operation.kind,
  fileName: operation.fileName,
  priority: operation.priority,
  requestedSize: operation.requestedSize,
  phase: operation.phase,
  durationMs: Math.max(0, (operation.endedAtMs ?? nowMs) - operation.startedAtMs),
  currentPhaseDurationMs:
    operation.phase === 'completed' ? 0 : Math.max(0, nowMs - operation.phaseStartedAtMs),
  phaseDurationsMs: operation.phaseDurationsMs,
  sourceBytes: operation.sourceBytes,
  outputBytes: operation.outputBytes,
  cacheStatus: operation.cacheStatus,
  workerTiming: operation.workerTiming,
  outcome: operation.outcome
})

export const getCoverTaskDiagnosticSnapshot = (nowMs = Date.now()) => {
  pruneRecentCoverDiagnostics(nowMs)
  const visibleQueued = pendingCoverThumbTasks.filter((task) => task.priority === 0)
  const prefetchQueued = pendingCoverThumbTasks.filter((task) => task.priority !== 0)
  const oldestQueuedAtMs = pendingCoverThumbTasks.reduce<number | null>(
    (oldest, task) => (oldest === null ? task.queuedAtMs : Math.min(oldest, task.queuedAtMs)),
    null
  )
  return {
    concurrencyLimit: COVER_THUMB_MAX_CONCURRENCY,
    active: activeCoverThumbTasks,
    queued: pendingCoverThumbTasks.length,
    queuedByPriority: {
      visible: visibleQueued.length,
      prefetch: prefetchQueued.length
    },
    oldestQueueWaitMs: oldestQueuedAtMs === null ? 0 : Math.max(0, nowMs - oldestQueuedAtMs),
    operations: {
      active: [...activeCoverDiagnostics.values()].map((operation) =>
        summarizeCoverDiagnostic(operation, nowMs)
      ),
      recent: recentCoverDiagnostics.map((operation) => summarizeCoverDiagnostic(operation, nowMs))
    },
    extractionWorkers: getCoverExtractionWorkerDiagnosticSnapshot(nowMs)
  }
}

export type CoverThumbRequestContext = {
  shouldAbort?: () => boolean
  priority?: 'visible' | 'prefetch'
}

export type CoverThumbResult = {
  format: string
  data: Buffer
  cacheStatus: 'hit' | 'miss' | 'disabled'
  sourceBytes: number
  outputBytes: number
  resized: boolean
  needsDisplayCache?: boolean
  imageHash?: string
  legacyExt?: string
}

export async function getSongCover(
  filePath: string
): Promise<{ format: string; data: Buffer } | null> {
  try {
    return await runPlaybackAwareBackgroundFileIo(
      'cover:extract-full',
      { filePath },
      () => extractCoverOffMainThread(filePath, undefined, true),
      { priority: 'visible' }
    )
  } catch {
    return null
  }
}

const mimeFromExt = (ext: string) =>
  ext.toLowerCase().endsWith('.png')
    ? 'image/png'
    : ext.toLowerCase().endsWith('.webp')
      ? 'image/webp'
      : ext.toLowerCase().endsWith('.gif')
        ? 'image/gif'
        : ext.toLowerCase().endsWith('.bmp')
          ? 'image/bmp'
          : 'image/jpeg'
export const extFromMime = (mime: string) => {
  const lower = (mime || '').toLowerCase()
  if (lower.includes('png')) return '.png'
  if (lower.includes('webp')) return '.webp'
  if (lower.includes('gif')) return '.gif'
  if (lower.includes('bmp')) return '.bmp'
  return '.jpg'
}

const isDisplayCacheExt = (ext: string) => ext.toLowerCase().includes(DISPLAY_CACHE_MARKER)

const displayCacheExtFromFormat = (format: string) =>
  `${DISPLAY_CACHE_MARKER}${extFromMime(format)}`

const writeDisplayCacheFile = async (targetPath: string, data: Buffer) => {
  const tmp = `${targetPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.writeFile(tmp, data)
    await fs.move(tmp, targetPath, { overwrite: true })
    await operateHiddenFile(targetPath, async () => {})
  } finally {
    try {
      if (await fs.pathExists(tmp)) await fs.remove(tmp)
    } catch {}
  }
}

const releaseCoverThumbSlot = () => {
  pendingCoverThumbTasks.sort(
    (left, right) => left.priority - right.priority || left.sequence - right.sequence
  )
  const next = pendingCoverThumbTasks.shift()
  if (next) {
    next.resolve()
    return
  }
  activeCoverThumbTasks = Math.max(0, activeCoverThumbTasks - 1)
}

const acquireCoverThumbSlot = async (
  context?: CoverThumbRequestContext
): Promise<(() => void) | null> => {
  if (context?.shouldAbort?.()) return null
  if (activeCoverThumbTasks >= COVER_THUMB_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) =>
      pendingCoverThumbTasks.push({
        priority: context?.priority === 'prefetch' ? 1 : 0,
        sequence: coverThumbTaskSequence++,
        queuedAtMs: Date.now(),
        resolve
      })
    )
    if (context?.shouldAbort?.()) {
      releaseCoverThumbSlot()
      return null
    }
  } else {
    activeCoverThumbTasks += 1
  }
  let released = false
  return () => {
    if (released) return
    released = true
    releaseCoverThumbSlot()
  }
}

async function loadSongCoverThumb(
  filePath: string,
  _size: number = 48,
  listRootDir?: string | null,
  context?: CoverThumbRequestContext,
  diagnostic?: CoverDiagnosticOperation
): Promise<CoverThumbResult | null> {
  try {
    if (context?.shouldAbort?.()) return null
    const crypto = await import('crypto')

    // 解析 listRootDir 为绝对路径（允许 library 相对路径）
    if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'resolving-cache-root')
    let resolvedRoot: string | null = null
    if (listRootDir && typeof listRootDir === 'string' && listRootDir.length > 0) {
      let input = listRootDir
      if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
      if (path.isAbsolute(input)) {
        resolvedRoot = input
      } else {
        resolvedRoot = resolveLibraryPath(input).absPath
      }
    }
    let useDiskCache = !!(
      resolvedRoot &&
      path.isAbsolute(resolvedRoot) &&
      (await fs.pathExists(resolvedRoot))
    )
    let coversDir: string | null = useDiskCache
      ? path.join(resolvedRoot as string, '.frkb_covers')
      : null
    let dbEntry: { hash: string; ext: string } | null = null
    if (useDiskCache && coversDir) {
      if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'loading-cache-index')
      const listRoot = resolvedRoot as string
      const entry = await LibraryCacheDb.loadCoverIndexEntry(listRoot, filePath)
      if (context?.shouldAbort?.()) return null
      if (entry === undefined) {
        useDiskCache = false
        coversDir = null
      } else {
        dbEntry = entry
      }
    }
    if (useDiskCache && coversDir) {
      if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'preparing-cache-directory')
      await fs.ensureDir(coversDir)
      await operateHiddenFile(coversDir, async () => {})
    }

    // 命中索引则直接返回
    if (useDiskCache && coversDir && dbEntry) {
      if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'reading-cache-file')
      const ext = dbEntry.ext || '.jpg'
      const p = path.join(coversDir, `${dbEntry.hash}${ext}`)
      if (await fs.pathExists(p)) {
        const st0 = await fs.stat(p)
        if (st0.size > 0) {
          const data = await fs.readFile(p)
          const mime = mimeFromExt(ext)
          if (context?.shouldAbort?.()) return null
          if (isDisplayCacheExt(ext)) {
            if (diagnostic) {
              diagnostic.cacheStatus = 'hit'
              diagnostic.sourceBytes = data.length
              diagnostic.outputBytes = data.length
            }
            return {
              format: mime,
              data,
              cacheStatus: 'hit',
              sourceBytes: data.length,
              outputBytes: data.length,
              resized: false
            }
          }
          if (diagnostic) {
            diagnostic.cacheStatus = 'hit'
            diagnostic.sourceBytes = data.length
            diagnostic.outputBytes = data.length
          }
          return {
            format: mime,
            data,
            cacheStatus: 'hit',
            sourceBytes: data.length,
            outputBytes: data.length,
            resized: false,
            needsDisplayCache: true,
            imageHash: dbEntry.hash,
            legacyExt: ext
          }
        }
      }
    }

    // 解析嵌入封面
    const priority: FileIoPriority = context?.priority === 'prefetch' ? 'prefetch' : 'visible'
    if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'waiting-extraction-file-io')
    const cover = await runPlaybackAwareBackgroundFileIo(
      'cover:extract',
      { filePath },
      () => extractCoverOffMainThread(filePath, context?.shouldAbort),
      { priority }
    )
    if (context?.shouldAbort?.() || !cover) return null
    const format = cover.format
    const data = cover.data
    if (!data || data.length === 0) return null

    if (diagnostic) {
      diagnostic.sourceBytes = data.length
      diagnostic.outputBytes = data.length
      diagnostic.cacheStatus = useDiskCache ? 'miss' : 'disabled'
      diagnostic.workerTiming = cover.timing
      markCoverDiagnosticPhase(diagnostic, 'hashing-source-image')
    }
    const imageHash = (await crypto).createHash('sha1').update(data).digest('hex')
    return {
      format: format || 'image/jpeg',
      data,
      cacheStatus: useDiskCache ? 'miss' : 'disabled',
      sourceBytes: data.length,
      outputBytes: data.length,
      resized: false,
      needsDisplayCache: useDiskCache,
      imageHash: useDiskCache ? imageHash : undefined,
      legacyExt: useDiskCache && dbEntry ? dbEntry.ext : undefined
    }
  } catch {
    return null
  }
}

export async function getSongCoverThumb(
  filePath: string,
  size: number = 48,
  listRootDir?: string | null,
  context?: CoverThumbRequestContext
): Promise<CoverThumbResult | null> {
  const diagnostic = startCoverDiagnostic({
    kind: 'thumbnail',
    filePath,
    priority: context?.priority === 'prefetch' ? 'prefetch' : 'visible',
    requestedSize: size,
    phase: 'waiting-cover-slot'
  })
  const release = await acquireCoverThumbSlot(context)
  if (!release) {
    completeCoverDiagnostic(diagnostic, 'aborted')
    return null
  }
  let result: CoverThumbResult | null = null
  try {
    result = await loadSongCoverThumb(filePath, size, listRootDir, context, diagnostic)
    return result
  } catch (error) {
    completeCoverDiagnostic(diagnostic, 'error')
    throw error
  } finally {
    if (!diagnostic.outcome) {
      completeCoverDiagnostic(diagnostic, result ? 'success' : 'empty')
    }
    release()
  }
}

async function persistSongCoverDisplayCacheNow(params: {
  filePath: string
  listRootDir: string
  imageHash: string
  legacyExt?: string
  format: string
  data: Buffer | Uint8Array
  context?: CoverThumbRequestContext
  diagnostic?: CoverDiagnosticOperation
}): Promise<boolean> {
  const { filePath, listRootDir, imageHash, legacyExt, format, data, context, diagnostic } = params
  if (context?.shouldAbort?.() || !filePath || !listRootDir || !/^[a-f0-9]{40}$/i.test(imageHash)) {
    return false
  }
  try {
    if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'resolving-cache-root')
    let input = listRootDir
    if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
    const resolvedRoot = path.isAbsolute(input) ? input : resolveLibraryPath(input).absPath
    if (!(await fs.pathExists(resolvedRoot)) || context?.shouldAbort?.()) return false
    const coversDir = path.join(resolvedRoot, '.frkb_covers')
    if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'preparing-cache-directory')
    await fs.ensureDir(coversDir)
    await operateHiddenFile(coversDir, async () => {})
    const ext = displayCacheExtFromFormat(format)
    const targetPath = path.join(coversDir, `${imageHash}${ext}`)
    if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'preparing-persist-data')
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (diagnostic) {
      diagnostic.sourceBytes = data.byteLength
      diagnostic.outputBytes = buffer.byteLength
    }
    if (!buffer.length || context?.shouldAbort?.()) return false
    if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'writing-display-cache')
    if (!(await fs.pathExists(targetPath))) await writeDisplayCacheFile(targetPath, buffer)
    if (context?.shouldAbort?.()) return false
    const replacedLegacyExt =
      !legacyExt ||
      legacyExt === ext ||
      (await LibraryCacheDb.replaceCoverIndexExtByHash(resolvedRoot, imageHash, legacyExt, ext))
    if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'updating-cache-index')
    const saved = await LibraryCacheDb.upsertCoverIndexEntry(resolvedRoot, filePath, imageHash, ext)
    if (!saved) return false
    if (legacyExt && legacyExt !== ext && replacedLegacyExt) {
      if (diagnostic) markCoverDiagnosticPhase(diagnostic, 'removing-legacy-cache')
      try {
        await fs.remove(path.join(coversDir, `${imageHash}${legacyExt}`))
      } catch {}
    }
    return true
  } catch {
    return false
  }
}

export async function persistSongCoverDisplayCache(params: {
  filePath: string
  listRootDir: string
  imageHash: string
  legacyExt?: string
  format: string
  data: Buffer | Uint8Array
  context?: CoverThumbRequestContext
}): Promise<boolean> {
  const priority: FileIoPriority = params.context?.priority === 'prefetch' ? 'prefetch' : 'visible'
  const diagnostic = startCoverDiagnostic({
    kind: 'persist-display-cache',
    filePath: params.filePath,
    priority,
    phase: 'waiting-persist-file-io'
  })
  let result = false
  try {
    result = await runPlaybackAwareBackgroundFileIo(
      'cover:persist-display-cache',
      { filePath: params.filePath },
      () => persistSongCoverDisplayCacheNow({ ...params, diagnostic }),
      { priority }
    )
    return result
  } catch (error) {
    completeCoverDiagnostic(diagnostic, 'error')
    throw error
  } finally {
    if (!diagnostic.outcome) {
      completeCoverDiagnostic(diagnostic, result ? 'success' : 'empty')
    }
  }
}

export async function sweepSongListCovers(
  listRootDir: string,
  currentFilePaths: string[]
): Promise<{ removed: number }> {
  try {
    if (!listRootDir || typeof listRootDir !== 'string') return { removed: 0 }
    let input = listRootDir
    if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
    const resolvedRoot = path.isAbsolute(input) ? input : resolveLibraryPath(input).absPath
    const coversDir = path.join(resolvedRoot, '.frkb_covers')
    if (!(await fs.pathExists(coversDir))) return { removed: 0 }

    const dbEntries = await LibraryCacheDb.loadCoverIndexEntries(resolvedRoot)
    if (dbEntries) {
      const alive = new Set(currentFilePaths || [])
      const fileCounts = new Map<string, number>()
      for (const entry of dbEntries) {
        const cacheName = `${entry.hash}${entry.ext || '.jpg'}`
        fileCounts.set(cacheName, (fileCounts.get(cacheName) || 0) + 1)
      }
      const toRemove: string[] = []
      for (const entry of dbEntries) {
        if (!alive.has(entry.filePath)) {
          toRemove.push(entry.filePath)
          const cacheName = `${entry.hash}${entry.ext || '.jpg'}`
          fileCounts.set(cacheName, (fileCounts.get(cacheName) || 1) - 1)
        }
      }
      if (toRemove.length > 0) {
        await LibraryCacheDb.removeCoverIndexEntries(resolvedRoot, toRemove)
      }
      let removed = 0
      const liveCacheNames = new Set<string>()
      for (const [cacheName, count] of fileCounts.entries()) {
        if (count > 0) {
          liveCacheNames.add(cacheName)
          continue
        }
        const p = path.join(coversDir, cacheName)
        try {
          if (await fs.pathExists(p)) {
            await fs.remove(p)
            removed++
          }
        } catch {}
      }
      try {
        const entries = await fs.readdir(coversDir)
        const imgRegex = /^[a-f0-9]{40}(?:\.display-v1)?\.(jpg|png|webp|gif|bmp)$/i
        for (const name of entries) {
          const full = path.join(coversDir, name)
          if (name.includes('.tmp_')) {
            try {
              await fs.remove(full)
            } catch {}
            continue
          }
          if (!imgRegex.test(name)) continue
          if (!liveCacheNames.has(name)) {
            try {
              await fs.remove(full)
              removed++
            } catch {}
          }
        }
      } catch {}
      return { removed }
    }

    return { removed: 0 }
  } catch {
    return { removed: 0 }
  }
}

export function scheduleSongListCoverSweep(
  listRootDir: string,
  currentFilePaths: string[],
  delayMs: number = 10_000
) {
  if (pendingPostScanSweepTimer) clearTimeout(pendingPostScanSweepTimer)
  pendingPostScanSweepTimer = setTimeout(
    () => {
      pendingPostScanSweepTimer = null
      void sweepSongListCovers(listRootDir, currentFilePaths)
    },
    Math.max(1_000, delayMs)
  )
}
