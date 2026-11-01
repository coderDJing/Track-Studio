import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { log } from '../log'
import { resolveMainWorkerPath } from '../workerPath'
import {
  getMixtapeProjectMixMode,
  listMixtapeItems,
  removeMixtapeItemsById,
  updateMixtapeItemFilePathsById,
  type MixtapeItemRecord
} from '../mixtapeDb'
import { upsertMixtapeItemStemStateById, type MixtapeStemStatus } from '../mixtapeStemDb'
import store from '../store'
import { loadLibraryNodes, type LibraryNodeRow } from '../libraryTreeDb'
import { listSetItemsByPlaylist } from '../setListDb'
import { queueMixtapeRawWaveforms } from '../services/mixtapeRawWaveformQueue'
import { queueUnifiedDisplayWaveforms } from '../services/unifiedDisplayWaveformQueue'
import {
  cleanupMixtapeWaveformCache,
  cleanupOrphanedMixtapeVaultFiles
} from '../services/mixtapeWaveformMaintenance'
import {
  isCompleteSharedSongGridDefinition,
  loadSharedSongGridDefinitions
} from '../services/sharedSongGrid'
import {
  resolveAudioFirstBeatTimelineMs,
  resolveAudioTimeBasisOffsetMsForFile
} from '../services/audioTimeBasisOffset'
import { CURRENT_BEAT_GRID_ALGORITHM_VERSION } from '../services/beatGridAlgorithmVersion'
import { resolveMissingMixtapeFilePath } from '../recycleBinService'
import { getBeatThisRuntimeAvailabilitySnapshot } from '../workers/beatThisRuntime'
import { resolveAnalysisBpmRange } from '../../shared/analysisBpmRange'
import {
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid
} from '../../shared/songBeatGridMapV2'

const resolveKeyAnalysisWorkerPath = () => resolveMainWorkerPath(__dirname, 'keyAnalysisWorker.js')

type MixtapeBpmAnalyzeResult = {
  results: Array<{
    filePath: string
    bpm: number
    firstBeatMs: number
    downbeatBeatOffset?: number
    timeBasisOffsetMs?: number
    beatGridAlgorithmVersion?: number
  }>
  unresolved: string[]
  unresolvedDetails: Array<{ filePath: string; reason: string }>
}

type MixtapeMissingRecovery = {
  recovered: Array<{
    itemId: string
    fromPath: string
    toPath: string
    source: 'recycle_bin' | 'mixtape_vault'
  }>
  removedPaths: string[]
}

const inFlightBpmBatchMap = new Map<string, Promise<MixtapeBpmAnalyzeResult>>()

type BpmWorkerPayload = {
  jobId?: number
  progress?: unknown
  error?: string
  result?: {
    bpm?: unknown
    bpmError?: unknown
    firstBeatMs?: unknown
    downbeatBeatOffset?: unknown
  }
}

const normalizePathForBatchKey = (value: string): string => {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const buildBpmBatchInput = (filePaths: string[]): string[] => {
  const set = new Set<string>()
  for (const item of filePaths) {
    const normalized = typeof item === 'string' ? item.trim() : ''
    if (!normalized) continue
    set.add(normalized)
  }
  return Array.from(set)
}

const buildBpmBatchKey = (filePaths: string[]): string =>
  filePaths
    .map((item) => normalizePathForBatchKey(item))
    .filter(Boolean)
    .sort()
    .join('\n')

type MixtapeBpmAnalyzeRunOptions = {
  fastAnalysis?: boolean
  stage?: 'primary' | 'retry-fast'
  attempt?: number
  totalAttempts?: number
}

const BPM_ANALYZE_JOB_TIMEOUT_NORMAL_MS = 3 * 60 * 1000
const BPM_ANALYZE_JOB_TIMEOUT_FAST_MS = 2 * 60 * 1000
const resolveBpmJobTimeoutMs = (fastAnalysis: boolean) =>
  fastAnalysis ? BPM_ANALYZE_JOB_TIMEOUT_FAST_MS : BPM_ANALYZE_JOB_TIMEOUT_NORMAL_MS

const analyzeMixtapeBpmBatch = async (
  filePaths: string[],
  options: MixtapeBpmAnalyzeRunOptions = {}
) => {
  const unique = buildBpmBatchInput(filePaths)
  if (unique.length === 0) {
    return {
      results: [],
      unresolved: [] as string[],
      unresolvedDetails: [] as Array<{ filePath: string; reason: string }>
    }
  }
  if (getBeatThisRuntimeAvailabilitySnapshot() === false) {
    return {
      results: [],
      unresolved: unique,
      unresolvedDetails: unique.map((filePath) => ({
        filePath,
        reason: 'analysis runtime unavailable'
      }))
    }
  }

  const workerPath = resolveKeyAnalysisWorkerPath()
  if (!fs.existsSync(workerPath)) {
    log.error('[mixtape] BPM worker entry not found', { workerPath, requested: unique.length })
    return {
      results: [],
      unresolved: unique,
      unresolvedDetails: unique.map((filePath) => ({ filePath, reason: 'worker entry not found' }))
    }
  }

  const fastAnalysis = options.fastAnalysis === true
  const analysisBpmRange = resolveAnalysisBpmRange(store.settingConfig.analysisBpmRange)
  const jobTimeoutMs = resolveBpmJobTimeoutMs(fastAnalysis)

  const maxWorkers = Math.max(1, Math.min(2, os.cpus().length, unique.length))
  const workers: Worker[] = []
  const busy = new Map<Worker, number>()
  const jobMap = new Map<number, string>()
  const unresolved = new Set<string>(unique)
  const results: Array<{
    filePath: string
    bpm: number
    firstBeatMs: number
    downbeatBeatOffset?: number
    timeBasisOffsetMs?: number
    beatGridAlgorithmVersion?: number
  }> = []
  const unresolvedReasons = new Map<string, string>()
  let cursor = 0
  let jobId = 0
  let finished = false

  return await new Promise<MixtapeBpmAnalyzeResult>((resolve) => {
    const workerJobTimerMap = new Map<Worker, ReturnType<typeof setTimeout>>()

    const markUnresolvedReason = (filePath: string, reason: string) => {
      if (!filePath || unresolvedReasons.has(filePath)) return
      unresolvedReasons.set(filePath, reason || 'unknown error')
    }

    const clearWorkerTimer = (worker: Worker) => {
      const timer = workerJobTimerMap.get(worker)
      if (!timer) return
      clearTimeout(timer)
      workerJobTimerMap.delete(worker)
    }

    function handleFailure(worker: Worker, error?: unknown) {
      if (!workers.includes(worker) && !busy.has(worker)) return
      clearWorkerTimer(worker)
      const currentJobId = busy.get(worker)
      if (currentJobId !== undefined) {
        busy.delete(worker)
        const filePath = jobMap.get(currentJobId)
        if (filePath) {
          jobMap.delete(currentJobId)
          unresolved.add(filePath)
          markUnresolvedReason(
            filePath,
            error instanceof Error ? error.message : String(error || 'worker failure')
          )
        }
      }
      try {
        worker.removeAllListeners()
      } catch {}
      try {
        void worker.terminate()
      } catch {}
      const idx = workers.indexOf(worker)
      if (idx !== -1) workers.splice(idx, 1)
      if (!finished && cursor < unique.length) {
        const replacement = createWorker()
        if (replacement) {
          assignNext(replacement)
        } else if (busy.size === 0) {
          finish()
        }
      } else if (busy.size === 0 && cursor >= unique.length) {
        finish()
      }
    }

    const setWorkerTimeout = (worker: Worker, currentJobId: number, filePath: string) => {
      clearWorkerTimer(worker)
      const timer = setTimeout(() => {
        if (finished) return
        const activeJobId = busy.get(worker)
        if (activeJobId !== currentJobId) return
        markUnresolvedReason(filePath, 'analysis timeout')
        handleFailure(worker, new Error(`analysis timeout (${jobTimeoutMs}ms)`))
      }, jobTimeoutMs)
      workerJobTimerMap.set(worker, timer)
    }

    const cleanup = () => {
      for (const timer of workerJobTimerMap.values()) {
        clearTimeout(timer)
      }
      workerJobTimerMap.clear()
      for (const worker of workers) {
        try {
          worker.removeAllListeners()
        } catch {}
        try {
          void worker.terminate()
        } catch {}
      }
      workers.length = 0
      busy.clear()
      jobMap.clear()
    }

    const finish = () => {
      if (finished) return
      finished = true

      cleanup()
      const unresolvedList = Array.from(unresolved)
      const unresolvedDetails = unresolvedList.map((filePath) => ({
        filePath,
        reason: unresolvedReasons.get(filePath) || 'unknown error'
      }))
      resolve({ results, unresolved: unresolvedList, unresolvedDetails })
    }

    const assignNext = (worker: Worker) => {
      if (cursor >= unique.length) {
        if (busy.size === 0) finish()
        return
      }
      const filePath = unique[cursor]
      cursor += 1
      const nextJobId = (jobId += 1)
      busy.set(worker, nextJobId)
      jobMap.set(nextJobId, filePath)
      setWorkerTimeout(worker, nextJobId, filePath)
      worker.postMessage({
        jobId: nextJobId,
        filePath,
        fastAnalysis,
        needsKey: false,
        needsBpm: true,
        needsWaveform: false,
        analysisBpmRange
      })
    }

    const handleMessage = async (worker: Worker, payload: BpmWorkerPayload) => {
      const hasProgressPayload =
        payload &&
        typeof payload === 'object' &&
        Object.prototype.hasOwnProperty.call(payload, 'progress')
      if (hasProgressPayload) return

      const hasFinalPayload =
        payload &&
        typeof payload === 'object' &&
        (Object.prototype.hasOwnProperty.call(payload, 'result') ||
          Object.prototype.hasOwnProperty.call(payload, 'error'))
      if (!hasFinalPayload) return

      clearWorkerTimer(worker)
      const currentJobId = busy.get(worker)
      const resolvedJobId =
        typeof payload?.jobId === 'number' ? payload.jobId : (currentJobId ?? -1)
      try {
        const filePath = jobMap.get(resolvedJobId)
        if (filePath) {
          jobMap.delete(resolvedJobId)
          const bpmValue = payload?.result?.bpm
          if (typeof bpmValue === 'number' && Number.isFinite(bpmValue) && bpmValue > 0) {
            const rawFirstBeatMs = Number(payload?.result?.firstBeatMs)
            const firstBeatAudioMs = Number.isFinite(rawFirstBeatMs)
              ? Number(rawFirstBeatMs.toFixed(3))
              : 0
            const timeBasisOffsetMs = await resolveAudioTimeBasisOffsetMsForFile(filePath)
            const firstBeatMs = resolveAudioFirstBeatTimelineMs(firstBeatAudioMs, timeBasisOffsetMs)
            const rawDownbeatBeatOffset = Number(payload?.result?.downbeatBeatOffset)
            const downbeatBeatOffset =
              Number.isInteger(rawDownbeatBeatOffset) &&
              rawDownbeatBeatOffset >= 0 &&
              rawDownbeatBeatOffset < 4
                ? rawDownbeatBeatOffset
                : undefined
            results.push({
              filePath,
              bpm: bpmValue,
              firstBeatMs,
              downbeatBeatOffset,
              timeBasisOffsetMs,
              beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION
            })
            unresolved.delete(filePath)
          } else {
            const reason =
              (typeof payload?.error === 'string' && payload.error) ||
              (typeof payload?.result?.bpmError === 'string' && payload.result.bpmError) ||
              `invalid bpm value: ${String(bpmValue)}`
            markUnresolvedReason(filePath, reason)
          }
        }
      } finally {
        if (currentJobId !== undefined) {
          busy.delete(worker)
        }
        assignNext(worker)
      }
    }

    const bindWorker = (worker: Worker) => {
      worker.on('message', (payload) => {
        void handleMessage(worker, payload)
      })
      worker.on('error', (error) => handleFailure(worker, error))
      worker.on('exit', (code) => {
        const activeJobId = busy.get(worker)
        if (code !== 0) {
          handleFailure(worker, new Error(`worker exited with code ${code}`))
          return
        }
        if (activeJobId !== undefined) {
          handleFailure(worker, new Error('worker exited before returning analysis result'))
        }
      })
    }

    const createWorker = () => {
      try {
        const worker = new Worker(workerPath)
        workers.push(worker)
        bindWorker(worker)
        return worker
      } catch (error) {
        log.error('[mixtape] BPM worker spawn failed', {
          workerPath,
          error: error instanceof Error ? error.message : String(error)
        })
        return null
      }
    }

    for (let index = 0; index < maxWorkers; index += 1) {
      const worker = createWorker()
      if (!worker) break
    }

    if (workers.length === 0) {
      log.error('[mixtape] BPM analyze aborted because no worker can be started', {
        workerPath,
        requested: unique.length
      })
      finish()
      return
    }

    for (const worker of workers) {
      assignNext(worker)
    }
  })
}

export const analyzeMixtapeBpmBatchShared = async (filePaths: string[]) => {
  const input = buildBpmBatchInput(filePaths)
  if (input.length === 0) {
    return {
      results: [],
      unresolved: [],
      unresolvedDetails: []
    } satisfies MixtapeBpmAnalyzeResult
  }

  const key = buildBpmBatchKey(input)
  const existing = inFlightBpmBatchMap.get(key)
  if (existing) return existing

  const task = (async (): Promise<MixtapeBpmAnalyzeResult> => {
    const resultMap = new Map<
      string,
      {
        filePath: string
        bpm: number
        firstBeatMs: number
        downbeatBeatOffset?: number
        timeBasisOffsetMs?: number
        beatGridAlgorithmVersion?: number
      }
    >()
    const unresolvedReasonMap = new Map<string, string>()
    const plans: Array<{ stage: 'primary' | 'retry-fast'; fastAnalysis: boolean }> = [
      { stage: 'primary', fastAnalysis: false },
      { stage: 'retry-fast', fastAnalysis: true }
    ]
    const sharedGridMap = await loadSharedSongGridDefinitions(input).catch(() => new Map())
    for (const filePath of input) {
      const sharedGrid = sharedGridMap.get(filePath)
      if (!isCompleteSharedSongGridDefinition(sharedGrid)) continue
      const normalizedPath = normalizePathForBatchKey(filePath)
      if (!normalizedPath) continue
      const sharedMapV2 = normalizeSongBeatGridMapV2(sharedGrid.beatGridMap, {
        allowSingleClip: true
      })
      const sharedProjection = projectSongBeatGridMapV2ToFixedGrid(sharedMapV2)
      if (!sharedProjection) continue
      resultMap.set(normalizedPath, {
        filePath,
        bpm: Number(sharedProjection.bpm.toFixed(6)),
        firstBeatMs: Number(sharedProjection.firstBeatMs.toFixed(3)),
        downbeatBeatOffset: sharedProjection.downbeatBeatOffset,
        timeBasisOffsetMs:
          typeof sharedGrid.timeBasisOffsetMs === 'number' &&
          Number.isFinite(sharedGrid.timeBasisOffsetMs)
            ? Number(sharedGrid.timeBasisOffsetMs.toFixed(3))
            : undefined,
        beatGridAlgorithmVersion:
          typeof sharedGrid.beatGridAlgorithmVersion === 'number' &&
          Number.isFinite(sharedGrid.beatGridAlgorithmVersion)
            ? Math.max(1, Math.floor(sharedGrid.beatGridAlgorithmVersion))
            : undefined
      })
    }
    let pending = input.filter((filePath) => !resultMap.has(normalizePathForBatchKey(filePath)))

    for (let index = 0; index < plans.length && pending.length > 0; index += 1) {
      const plan = plans[index]!
      const runResult = await analyzeMixtapeBpmBatch(pending, {
        stage: plan.stage,
        fastAnalysis: plan.fastAnalysis,
        attempt: index + 1,
        totalAttempts: plans.length
      })

      for (const item of runResult.results) {
        const normalizedPath = normalizePathForBatchKey(item.filePath)
        if (!normalizedPath) continue
        resultMap.set(normalizedPath, {
          filePath: item.filePath,
          bpm: item.bpm,
          firstBeatMs: Number(item.firstBeatMs.toFixed(3)),
          downbeatBeatOffset:
            typeof item.downbeatBeatOffset === 'number' &&
            Number.isInteger(item.downbeatBeatOffset) &&
            item.downbeatBeatOffset >= 0 &&
            item.downbeatBeatOffset < 4
              ? item.downbeatBeatOffset
              : undefined,
          timeBasisOffsetMs:
            typeof item.timeBasisOffsetMs === 'number' && Number.isFinite(item.timeBasisOffsetMs)
              ? Number(item.timeBasisOffsetMs.toFixed(3))
              : undefined,
          beatGridAlgorithmVersion:
            typeof item.beatGridAlgorithmVersion === 'number' &&
            Number.isFinite(item.beatGridAlgorithmVersion)
              ? Math.max(1, Math.floor(item.beatGridAlgorithmVersion))
              : undefined
        })
        unresolvedReasonMap.delete(normalizedPath)
      }

      const retryCandidates: string[] = []
      for (const detail of runResult.unresolvedDetails) {
        const normalizedPath = normalizePathForBatchKey(detail.filePath)
        if (!normalizedPath || resultMap.has(normalizedPath)) continue
        unresolvedReasonMap.set(normalizedPath, detail.reason || 'unknown error')
        retryCandidates.push(detail.filePath)
      }
      pending = buildBpmBatchInput(retryCandidates)
    }

    const unresolved = pending
    const unresolvedDetails = unresolved.map((filePath) => {
      const normalizedPath = normalizePathForBatchKey(filePath)
      return {
        filePath,
        reason: unresolvedReasonMap.get(normalizedPath) || 'unknown error'
      }
    })

    return {
      results: Array.from(resultMap.values()),
      unresolved,
      unresolvedDetails
    }
  })().finally(() => {
    if (inFlightBpmBatchMap.get(key) === task) {
      inFlightBpmBatchMap.delete(key)
    }
  })

  inFlightBpmBatchMap.set(key, task)
  return task
}

const normalizeUniquePaths = (values: unknown[]): string[] => {
  if (!Array.isArray(values)) return []
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  )
}

type OriginPlaylistSnapshot =
  | {
      nodeType: 'songList'
      rootPath: string
    }
  | {
      nodeType: 'mixtapeList' | 'setList'
      filePathKeys: Set<string>
    }

type OriginPlaylistResolver = {
  canValidate: boolean
  resolve: (playlistUuid: string) => OriginPlaylistSnapshot | null
}

type MixtapeItemInfoJson = Record<string, unknown>

const READY_STEM_PATH_FIELDS = [
  'stemVocalPath',
  'stemInstPath',
  'stemBassPath',
  'stemDrumsPath'
] as const

const parseMixtapeItemInfoJson = (raw: unknown): MixtapeItemInfoJson => {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as MixtapeItemInfoJson)
      : {}
  } catch {
    return {}
  }
}

const normalizeInfoText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const normalizeStemStatus = (value: unknown): MixtapeStemStatus => {
  if (
    value === 'idle' ||
    value === 'pending' ||
    value === 'running' ||
    value === 'ready' ||
    value === 'failed'
  ) {
    return value
  }
  return 'ready'
}

const hasReadyStemAssetMismatch = (info: MixtapeItemInfoJson): boolean => {
  if (normalizeStemStatus(info.stemStatus) !== 'ready') return false
  const stemPaths = READY_STEM_PATH_FIELDS.map((field) => normalizeInfoText(info[field]))
  if (!stemPaths.some(Boolean)) return false
  return stemPaths.some((filePath) => !filePath || !fs.existsSync(filePath))
}

const normalizeFilePathKey = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  const resolved = path.resolve(text)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const isPathUnderRoot = (rootPath: string, filePath: string): boolean => {
  const rootKey = normalizeFilePathKey(rootPath)
  const fileKey = normalizeFilePathKey(filePath)
  if (!rootKey || !fileKey) return false
  return fileKey === rootKey || fileKey.startsWith(`${rootKey}${path.sep}`)
}

const buildLibraryNodePathMap = (nodes: readonly LibraryNodeRow[]): Map<string, string> => {
  const root = nodes.find((row) => row.parentUuid === null && row.nodeType === 'root')
  if (!root) return new Map()

  const childrenMap = new Map<string, LibraryNodeRow[]>()
  for (const row of nodes) {
    if (!row.parentUuid) continue
    const list = childrenMap.get(row.parentUuid)
    if (list) {
      list.push(row)
    } else {
      childrenMap.set(row.parentUuid, [row])
    }
  }

  const pathByUuid = new Map<string, string>([[root.uuid, root.dirName]])
  const queue: LibraryNodeRow[] = [root]
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]
    const parentPath = pathByUuid.get(parent.uuid)
    if (!parentPath) continue
    const children = childrenMap.get(parent.uuid) || []
    for (const child of children) {
      if (pathByUuid.has(child.uuid)) continue
      pathByUuid.set(child.uuid, path.join(parentPath, child.dirName))
      queue.push(child)
    }
  }
  return pathByUuid
}

const createOriginPlaylistResolver = (): OriginPlaylistResolver => {
  const libraryRoot = store.databaseDir || ''
  const nodes = loadLibraryNodes(libraryRoot) || []
  const pathByUuid = buildLibraryNodePathMap(nodes)
  const canValidate = !!libraryRoot && pathByUuid.size > 0
  if (!canValidate) {
    return {
      canValidate: false,
      resolve: () => null
    }
  }

  const nodeByUuid = new Map(nodes.map((row) => [row.uuid, row]))
  const snapshotCache = new Map<string, OriginPlaylistSnapshot | null>()

  return {
    canValidate: true,
    resolve: (playlistUuid: string): OriginPlaylistSnapshot | null => {
      const normalizedUuid = typeof playlistUuid === 'string' ? playlistUuid.trim() : ''
      if (!normalizedUuid) return null
      if (snapshotCache.has(normalizedUuid)) {
        return snapshotCache.get(normalizedUuid) || null
      }

      const node = nodeByUuid.get(normalizedUuid)
      let snapshot: OriginPlaylistSnapshot | null = null
      if (node?.nodeType === 'songList') {
        const relativePath = pathByUuid.get(normalizedUuid)
        const rootPath = relativePath ? path.join(libraryRoot, relativePath) : ''
        snapshot = rootPath ? { nodeType: 'songList', rootPath } : null
      } else if (node?.nodeType === 'mixtapeList') {
        snapshot = {
          nodeType: 'mixtapeList',
          filePathKeys: new Set(
            listMixtapeItems(normalizedUuid)
              .map((item) => normalizeFilePathKey(item.filePath))
              .filter(Boolean)
          )
        }
      } else if (node?.nodeType === 'setList') {
        // SET 条目可能存相对 library 的托管路径，需与 setList:load-items 一致地解析为绝对路径
        snapshot = {
          nodeType: 'setList',
          filePathKeys: new Set(
            listSetItemsByPlaylist(normalizedUuid)
              .map((item) =>
                normalizeFilePathKey(
                  path.isAbsolute(item.filePath)
                    ? item.filePath
                    : path.join(libraryRoot, 'library', item.filePath)
                )
              )
              .filter(Boolean)
          )
        }
      }

      snapshotCache.set(normalizedUuid, snapshot)
      return snapshot
    }
  }
}

export const reconcileMixtapeMissingFiles = async (
  playlistId: string
): Promise<{ items: MixtapeItemRecord[]; recovery: MixtapeMissingRecovery }> => {
  const emptyRecovery: MixtapeMissingRecovery = { recovered: [], removedPaths: [] }
  if (!playlistId) return { items: [], recovery: emptyRecovery }

  const items = listMixtapeItems(playlistId)
  if (!items.length) return { items, recovery: emptyRecovery }
  const mixMode = getMixtapeProjectMixMode(playlistId)

  const updates: Array<{ id: string; filePath: string }> = []
  const stalePaths: string[] = []
  const removeIds: string[] = []
  const stemStatePatches: Array<{
    itemId: string
    stemStatus: MixtapeStemStatus
    stemError: null
    stemReadyAt: null
    stemVocalPath: null
    stemInstPath: null
    stemBassPath: null
    stemDrumsPath: null
  }> = []
  const originPlaylistResolver = createOriginPlaylistResolver()

  for (const item of items) {
    const itemId = typeof item?.id === 'string' ? item.id.trim() : ''
    const filePath = typeof item?.filePath === 'string' ? item.filePath.trim() : ''
    if (!itemId || !filePath) {
      if (itemId) removeIds.push(itemId)
      if (filePath) {
        emptyRecovery.removedPaths.push(filePath)
        stalePaths.push(filePath)
      }
      continue
    }
    const originPlaylistUuid =
      typeof item?.originPlaylistUuid === 'string' ? item.originPlaylistUuid.trim() : ''
    if (originPlaylistUuid && originPlaylistResolver.canValidate) {
      const originSnapshot = originPlaylistResolver.resolve(originPlaylistUuid)
      let existsInOrigin = false
      if (originSnapshot?.nodeType === 'songList') {
        existsInOrigin =
          isPathUnderRoot(originSnapshot.rootPath, filePath) && fs.existsSync(filePath)
      } else if (
        originSnapshot?.nodeType === 'mixtapeList' ||
        originSnapshot?.nodeType === 'setList'
      ) {
        const filePathKey = normalizeFilePathKey(filePath)
        existsInOrigin = !!filePathKey && originSnapshot.filePathKeys.has(filePathKey)
      }
      if (!existsInOrigin) {
        removeIds.push(itemId)
        emptyRecovery.removedPaths.push(filePath)
        stalePaths.push(filePath)
        continue
      }
    }
    if (hasReadyStemAssetMismatch(parseMixtapeItemInfoJson(item.infoJson))) {
      stemStatePatches.push({
        itemId,
        stemStatus: 'pending',
        stemError: null,
        stemReadyAt: null,
        stemVocalPath: null,
        stemInstPath: null,
        stemBassPath: null,
        stemDrumsPath: null
      })
    }
    if (fs.existsSync(filePath)) continue
    const resolved = await resolveMissingMixtapeFilePath(filePath)
    if (resolved?.resolvedPath) {
      updates.push({ id: itemId, filePath: resolved.resolvedPath })
      stalePaths.push(filePath)
      emptyRecovery.recovered.push({
        itemId,
        fromPath: filePath,
        toPath: resolved.resolvedPath,
        source: resolved.source
      })
      continue
    }
    removeIds.push(itemId)
    emptyRecovery.removedPaths.push(filePath)
    stalePaths.push(filePath)
  }

  if (updates.length > 0) {
    updateMixtapeItemFilePathsById(updates)
    const resolvedPaths = normalizeUniquePaths(updates.map((item) => item.filePath))
    if (resolvedPaths.length > 0) {
      if (mixMode === 'eq') {
        queueUnifiedDisplayWaveforms(resolvedPaths)
      }
      if (mixMode === 'stem') {
        queueMixtapeRawWaveforms(resolvedPaths)
      }
    }
  }
  if (removeIds.length > 0) {
    removeMixtapeItemsById(playlistId, removeIds)
  }
  if (stemStatePatches.length > 0) {
    upsertMixtapeItemStemStateById(stemStatePatches)
  }
  if (stalePaths.length > 0) {
    const uniqueStalePaths = normalizeUniquePaths(stalePaths)
    await cleanupMixtapeWaveformCache(uniqueStalePaths)
    await cleanupOrphanedMixtapeVaultFiles(uniqueStalePaths)
  }
  if (updates.length === 0 && removeIds.length === 0 && stemStatePatches.length === 0) {
    return { items, recovery: emptyRecovery }
  }

  const refreshed = listMixtapeItems(playlistId)
  return {
    items: refreshed,
    recovery: {
      recovered: emptyRecovery.recovered,
      removedPaths: normalizeUniquePaths(emptyRecovery.removedPaths)
    }
  }
}
