import {
  DYNAMIC_BEAT_GRID_POLICY,
  DYNAMIC_BEAT_GRID_POLICY_VERSION,
  type DynamicBeatGridWindowPlanEntry,
  type DynamicBeatWindowEvidence
} from '../../shared/dynamicBeatGridTypes'
import { createDynamicBeatGridWindowPlan } from '../../shared/dynamicBeatGridAnalysis'
import type { BeatThisWindowSession, BeatThisWindowSessionOptions } from './beatThisAnalyzer'
import { resolveWindowRequestTimeoutMs } from './beatThisWindowProtocol'

export type DynamicGridWindowSource = 'coarse' | 'refined'

export type DynamicGridScanScope = 'full' | 'refine-only'

export type DynamicGridWindowPlan = DynamicBeatGridWindowPlanEntry & {
  source: DynamicGridWindowSource
}

export type DynamicGridRefineRegion = {
  startAudioSec: number
  endAudioSec: number
}

export type DynamicGridDecodeRequest = {
  filePath: string
  startSec: number
  maxDurationSec: number
  sampleRate: number
  channels: number
}

export type DynamicGridDecodedPcm = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  actualStartSec?: number
  error?: string
}

export type DynamicGridDecodeDeps = {
  decodeChunk: (request: DynamicGridDecodeRequest) => DynamicGridDecodedPcm
  createSession: (options?: BeatThisWindowSessionOptions) => BeatThisWindowSession
  now?: () => number
}

export type DynamicGridScanProgress = {
  phase: 'scan' | 'refine' | 'complete'
  completedWindows: number
  totalWindows: number
  coveredAudioSec: number
  /** 供 main 在 worker 被硬终止时按 PID 清理本任务拥有的 sidecar */
  sidecarPid?: number | null
}

export type DynamicGridChunkBoundary = {
  phase: DynamicGridWindowSource
  chunkId: number
  startAudioSec: number
  requestedDurationSec: number
  decodedDurationSec: number
  windowCount: number
}

export type DynamicGridScanCoverage = {
  /** 真实扫描范围；refine-only 不能冒充全曲覆盖。 */
  scope?: DynamicGridScanScope
  durationAudioSec: number
  coarseWindows: number
  refinedWindows: number
  analyzedWindows: number
  noBeatsWindows: number
  decodedAudioSec: number
  /** 本次实际分析到的区间并集；D 用它和原 coarse 结果合并。 */
  analyzedRanges?: Array<{ startAudioSec: number; endAudioSec: number }>
  gaps: Array<{ startAudioSec: number; endAudioSec: number }>
  noBeatsRanges: Array<{ startAudioSec: number; endAudioSec: number; windowId: string }>
  timing: {
    decodeApi: 'decodeAudioFileNativePcm'
    decodeStartBasis: 'audible-origin-verified' | 'requested-start-unverified'
    sampleAccurateSeek: false
    seekAlignmentToleranceSec?: number
    chunkSec: number
    chunkOverlapSec: number
    coarseWindowSec: number
    coarseStepSec: number
    refineWindowSec: number
    refineStepSec: number
  }
}

export type DynamicGridScanResult = {
  windows: DynamicBeatWindowEvidence[]
  coverage: DynamicGridScanCoverage
  chunkBoundaries: DynamicGridChunkBoundary[]
  policyVersion: string
  /** 完整扫描或仅精扫；refine-only 时 windows/coverage 只描述局部范围。 */
  scanScope?: DynamicGridScanScope
  runtime?: {
    sidecarPid: number | null
  }
}

export type DynamicGridScanOptions = {
  filePath: string
  durationAudioSec: number
  refineRegions?: DynamicGridRefineRegion[]
  /** 只解码/推理 refineRegions 覆盖的窗口，不重做 coarse。 */
  onlyRefine?: boolean
  sampleRate?: number
  channels?: number
  maxTotalMs?: number
  maxNoProgressMs?: number
  onProgress?: (progress: DynamicGridScanProgress) => void
  /** 自有 sidecar 的早期 PID 生命周期；null 仅在该进程真实退出后出现。 */
  onSidecarChange?: (pid: number | null) => void
  signal?: AbortSignal
  deps?: Partial<DynamicGridDecodeDeps>
}

export type DynamicGridScanErrorCode =
  | 'invalid-duration'
  | 'unsupported-short-duration'
  | 'unsupported-window-budget'
  | 'invalid-plan'
  | 'decode-failed'
  | 'decode-truncated'
  | 'decode-range-mismatch'
  | 'decode-inconsistent'
  | 'evidence-mismatch'
  | 'invalid-budget'
  | 'timeout'
  | 'cancelled'

export class DynamicGridScanError extends Error {
  readonly code: DynamicGridScanErrorCode

  constructor(code: DynamicGridScanErrorCode, message: string) {
    super(message)
    this.name = 'DynamicGridScanError'
    this.code = code
  }
}

export const DYNAMIC_GRID_SCAN_POLICY_VERSION = `${DYNAMIC_BEAT_GRID_POLICY_VERSION}:scan-v1`
export const DYNAMIC_GRID_SAMPLE_RATE = 44100
export const DYNAMIC_GRID_CHANNELS = 2
export const DYNAMIC_GRID_CHUNK_SEC = DYNAMIC_BEAT_GRID_POLICY.blockDurationSec
export const DYNAMIC_GRID_CHUNK_OVERLAP_SEC = DYNAMIC_BEAT_GRID_POLICY.blockOverlapSec
export const DYNAMIC_GRID_COARSE_WINDOW_SEC = DYNAMIC_BEAT_GRID_POLICY.windowDurationSec
export const DYNAMIC_GRID_COARSE_STEP_SEC = DYNAMIC_BEAT_GRID_POLICY.windowStepSec
export const DYNAMIC_GRID_REFINE_WINDOW_SEC = 10
export const DYNAMIC_GRID_REFINE_STEP_SEC = 5
export const DYNAMIC_GRID_REFINE_CONTEXT_SEC = 5
export const DYNAMIC_GRID_MIN_WINDOW_SEC = DYNAMIC_BEAT_GRID_POLICY.minInferenceWindowSec
export const DYNAMIC_GRID_MAX_TRACK_SEC = 6 * 60 * 60
export const DYNAMIC_GRID_MAX_REFINED_WINDOWS = DYNAMIC_BEAT_GRID_POLICY.maxWindows
const DECODE_TRUNCATION_TOLERANCE_SEC = 0.1
const DECODE_OVERSHOOT_TOLERANCE_SEC = 0.25
const DECODE_START_TOLERANCE_SEC = 0.005
const WINDOW_START_TOLERANCE_SEC = 0.05
const PLAN_EPSILON_SEC = 1e-6
const DEFAULT_MAX_TOTAL_MS = 30 * 60_000
const DEFAULT_MAX_NO_PROGRESS_MS = 10 * 60_000

const roundSec = (value: number) => Number(value.toFixed(6))

const assertFiniteDuration = (durationAudioSec: number) => {
  if (!Number.isFinite(durationAudioSec) || durationAudioSec <= 0) {
    throw new DynamicGridScanError(
      'invalid-duration',
      'durationAudioSec must be a finite positive number probed from the audio file'
    )
  }
  if (durationAudioSec > DYNAMIC_GRID_MAX_TRACK_SEC) {
    throw new DynamicGridScanError(
      'invalid-duration',
      `durationAudioSec exceeds the ${DYNAMIC_GRID_MAX_TRACK_SEC}s scan ceiling`
    )
  }
}

export const planCoarseBeatWindows = (durationAudioSec: number): DynamicGridWindowPlan[] => {
  assertFiniteDuration(durationAudioSec)
  const entries = createDynamicBeatGridWindowPlan(durationAudioSec)
  if (entries.length === 0) {
    throw new DynamicGridScanError(
      'unsupported-short-duration',
      `track is shorter than the ${DYNAMIC_GRID_MIN_WINDOW_SEC}s inference floor`
    )
  }

  const windows: DynamicGridWindowPlan[] = entries.map((entry) => ({
    windowId: entry.windowId,
    startAudioSec: entry.startAudioSec,
    durationSec: entry.durationSec,
    source: 'coarse'
  }))
  const seenIds = new Set<string>()
  for (const window of windows) {
    if (seenIds.has(window.windowId)) {
      throw new DynamicGridScanError('invalid-plan', `duplicate coarse window ${window.windowId}`)
    }
    seenIds.add(window.windowId)
    if (!Number.isFinite(window.durationSec) || window.durationSec < DYNAMIC_GRID_MIN_WINDOW_SEC) {
      throw new DynamicGridScanError(
        'invalid-plan',
        `coarse window ${window.windowId} is below the inference floor`
      )
    }
    if (
      window.startAudioSec < -PLAN_EPSILON_SEC ||
      window.startAudioSec + window.durationSec > durationAudioSec + PLAN_EPSILON_SEC
    ) {
      throw new DynamicGridScanError(
        'invalid-plan',
        `coarse window ${window.windowId} lies outside the track`
      )
    }
  }
  const first = windows[0]
  const last = windows[windows.length - 1]
  if (Math.abs(first.startAudioSec) > PLAN_EPSILON_SEC) {
    throw new DynamicGridScanError('invalid-plan', 'coarse window plan must start at 0')
  }
  if (Math.abs(last.startAudioSec + last.durationSec - durationAudioSec) > PLAN_EPSILON_SEC) {
    throw new DynamicGridScanError(
      'invalid-plan',
      'coarse window plan does not reach the track end'
    )
  }
  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1]
    const current = windows[index]
    if (current.startAudioSec > previous.startAudioSec + previous.durationSec + PLAN_EPSILON_SEC) {
      throw new DynamicGridScanError('invalid-plan', 'coarse window plan leaves a coverage gap')
    }
  }
  return windows
}

export const planRefinedBeatWindows = (
  regions: DynamicGridRefineRegion[],
  durationAudioSec: number
): DynamicGridWindowPlan[] => {
  assertFiniteDuration(durationAudioSec)
  if (!Array.isArray(regions) || regions.length === 0) return []

  const normalizedRegions = regions
    .map((region) => {
      const startAudioSec = Number(region.startAudioSec)
      const endAudioSec = Number(region.endAudioSec)
      if (!Number.isFinite(startAudioSec) || !Number.isFinite(endAudioSec)) {
        throw new DynamicGridScanError('invalid-plan', 'refine region must be finite')
      }
      return {
        startAudioSec: Math.max(0, Math.min(startAudioSec, endAudioSec)),
        endAudioSec: Math.min(durationAudioSec, Math.max(startAudioSec, endAudioSec))
      }
    })
    .sort((left, right) => left.startAudioSec - right.startAudioSec)

  const windows: DynamicGridWindowPlan[] = []
  let regionIndex = 0
  for (const region of normalizedRegions) {
    const expandedStart = Math.max(0, region.startAudioSec - DYNAMIC_GRID_REFINE_CONTEXT_SEC)
    const expandedEnd = Math.min(
      durationAudioSec,
      region.endAudioSec + DYNAMIC_GRID_REFINE_CONTEXT_SEC
    )
    if (expandedEnd - expandedStart < DYNAMIC_GRID_MIN_WINDOW_SEC - PLAN_EPSILON_SEC) {
      regionIndex += 1
      continue
    }
    const alignedStart =
      Math.floor(expandedStart / DYNAMIC_GRID_REFINE_STEP_SEC) * DYNAMIC_GRID_REFINE_STEP_SEC
    let windowIndex = 0
    for (
      let startSec = alignedStart;
      startSec + DYNAMIC_GRID_MIN_WINDOW_SEC - PLAN_EPSILON_SEC <= expandedEnd;
      startSec += DYNAMIC_GRID_REFINE_STEP_SEC
    ) {
      const endSec = Math.min(startSec + DYNAMIC_GRID_REFINE_WINDOW_SEC, expandedEnd)
      if (endSec - startSec < DYNAMIC_GRID_MIN_WINDOW_SEC - PLAN_EPSILON_SEC) break
      windows.push({
        windowId: `r${regionIndex}-${String(windowIndex).padStart(3, '0')}`,
        startAudioSec: roundSec(startSec),
        durationSec: roundSec(endSec - startSec),
        source: 'refined'
      })
      windowIndex += 1
    }
    regionIndex += 1
  }

  if (windows.length > DYNAMIC_GRID_MAX_REFINED_WINDOWS) {
    throw new DynamicGridScanError(
      'unsupported-window-budget',
      `refined window budget ${DYNAMIC_GRID_MAX_REFINED_WINDOWS} exceeded (${windows.length})`
    )
  }
  return windows
}

export type DynamicGridChunkPlan = {
  phase: DynamicGridWindowSource
  chunkId: number
  startAudioSec: number
  durationSec: number
  windows: DynamicGridWindowPlan[]
}

export const planDecodeChunks = (
  durationAudioSec: number,
  windows: DynamicGridWindowPlan[]
): DynamicGridChunkPlan[] => {
  if (windows.length === 0) return []
  const sorted = [...windows].sort((left, right) => {
    if (left.startAudioSec !== right.startAudioSec) {
      return left.startAudioSec - right.startAudioSec
    }
    return left.durationSec - right.durationSec
  })
  const chunks: DynamicGridChunkPlan[] = []
  let current: DynamicGridChunkPlan | null = null

  const createChunk = (window: DynamicGridWindowPlan): DynamicGridChunkPlan => {
    const previousStart = chunks.length ? chunks[chunks.length - 1].startAudioSec : null
    const overlapAlignedStart =
      previousStart === null
        ? window.startAudioSec
        : Math.min(
            window.startAudioSec,
            previousStart + DYNAMIC_GRID_CHUNK_SEC - DYNAMIC_GRID_CHUNK_OVERLAP_SEC
          )
    return {
      phase: window.source,
      chunkId: chunks.length,
      startAudioSec: roundSec(Math.max(0, overlapAlignedStart)),
      durationSec: 0,
      windows: [window]
    }
  }

  const flush = () => {
    if (!current) return
    chunks.push(current)
    current = null
  }

  for (const window of sorted) {
    if (window.durationSec > DYNAMIC_GRID_CHUNK_SEC + PLAN_EPSILON_SEC) {
      throw new DynamicGridScanError(
        'invalid-plan',
        `window ${window.windowId} is longer than the decode chunk`
      )
    }
    if (
      window.startAudioSec < -PLAN_EPSILON_SEC ||
      window.startAudioSec + window.durationSec > durationAudioSec + PLAN_EPSILON_SEC
    ) {
      throw new DynamicGridScanError(
        'invalid-plan',
        `window ${window.windowId} lies outside the track`
      )
    }
    if (!current) {
      current = createChunk(window)
      continue
    }
    const chunkLimit = current.startAudioSec + DYNAMIC_GRID_CHUNK_SEC + PLAN_EPSILON_SEC
    if (window.startAudioSec + window.durationSec <= chunkLimit) {
      current.windows.push(window)
      continue
    }
    flush()
    current = createChunk(window)
  }
  flush()

  for (const chunk of chunks) {
    const maxWindowEnd = chunk.windows.reduce(
      (end, window) => Math.max(end, window.startAudioSec + window.durationSec),
      0
    )
    const requiredDurationSec = maxWindowEnd - chunk.startAudioSec
    if (requiredDurationSec > DYNAMIC_GRID_CHUNK_SEC + PLAN_EPSILON_SEC) {
      throw new DynamicGridScanError('invalid-plan', 'decode chunk cannot contain its windows')
    }
    chunk.durationSec = roundSec(
      Math.min(DYNAMIC_GRID_CHUNK_SEC, durationAudioSec - chunk.startAudioSec)
    )
    if (chunk.durationSec + PLAN_EPSILON_SEC < requiredDurationSec) {
      throw new DynamicGridScanError('invalid-plan', 'decode chunk is shorter than its windows')
    }
  }
  return chunks
}

const assertNotAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new DynamicGridScanError('cancelled', 'dynamic grid scan was cancelled')
  }
}

const assertWithinBudget = (params: {
  signal?: AbortSignal
  now: () => number
  deadlineAt: number
  lastProgressAt: number
  maxNoProgressMs: number
}) => {
  const { signal, now, deadlineAt, lastProgressAt, maxNoProgressMs } = params
  assertNotAborted(signal)
  const currentMs = now()
  if (currentMs >= deadlineAt) {
    throw new DynamicGridScanError('timeout', 'dynamic grid scan exceeded its total time budget')
  }
  if (currentMs - lastProgressAt > maxNoProgressMs) {
    throw new DynamicGridScanError(
      'timeout',
      'dynamic grid scan made no progress within its budget'
    )
  }
}

const loadDefaultDecodeDeps = (): DynamicGridDecodeDeps => ({
  decodeChunk: (request) => {
    const binding = require('rust_package') as {
      decodeAudioFileNativePcm?: (
        filePath: string,
        startSec: number | null,
        maxDurationSec: number | null,
        sampleRate: number,
        channels: number
      ) => DynamicGridDecodedPcm
    }
    const decodeNative = binding.decodeAudioFileNativePcm
    if (typeof decodeNative !== 'function') {
      throw new DynamicGridScanError(
        'decode-failed',
        'decodeAudioFileNativePcm is unavailable in the native binding'
      )
    }
    return decodeNative(
      request.filePath,
      request.startSec,
      request.maxDurationSec,
      request.sampleRate,
      request.channels
    )
  },
  createSession: (options?: BeatThisWindowSessionOptions) => {
    const analyzer = require('./beatThisAnalyzer') as typeof import('./beatThisAnalyzer')
    return analyzer.createBeatThisWindowSession(options)
  }
})

const validateDecodedChunk = (params: {
  decoded: DynamicGridDecodedPcm
  chunk: DynamicGridChunkPlan
  sampleRate: number
  channels: number
}): number => {
  const { decoded, chunk, sampleRate, channels } = params
  if (decoded.error) {
    throw new DynamicGridScanError('decode-failed', decoded.error)
  }
  if (!decoded.pcmData || decoded.pcmData.byteLength <= 0) {
    throw new DynamicGridScanError('decode-failed', 'native decode returned empty PCM')
  }
  if (decoded.sampleRate !== sampleRate || decoded.channels !== channels) {
    throw new DynamicGridScanError(
      'decode-inconsistent',
      `native decode returned ${decoded.sampleRate}Hz/${decoded.channels}ch, ` +
        `expected ${sampleRate}Hz/${channels}ch`
    )
  }
  const framesFromPcm = Math.floor(decoded.pcmData.byteLength / 4 / channels)
  if (Math.abs(framesFromPcm - decoded.totalFrames) > 1) {
    throw new DynamicGridScanError(
      'decode-inconsistent',
      `native decode frame count mismatch (${decoded.totalFrames} vs ${framesFromPcm})`
    )
  }
  const decodedDurationSec = decoded.totalFrames / sampleRate
  const requestedStartSec = chunk.startAudioSec
  const actualStartSec = Number(decoded.actualStartSec)
  if (!Number.isFinite(actualStartSec)) {
    throw new DynamicGridScanError(
      'decode-inconsistent',
      'native decode did not report actualStartSec; rebuild rust_package with the audible-origin contract'
    )
  }
  if (Math.abs(actualStartSec - requestedStartSec) > DECODE_START_TOLERANCE_SEC) {
    throw new DynamicGridScanError(
      'decode-range-mismatch',
      `native decode started at ${actualStartSec.toFixed(6)}s but ${requestedStartSec.toFixed(6)}s ` +
        `was requested (tolerance ${DECODE_START_TOLERANCE_SEC}s)`
    )
  }
  const requiredEndAudioSec = chunk.windows.reduce(
    (end, window) => Math.max(end, window.startAudioSec + window.durationSec),
    chunk.startAudioSec
  )
  const requiredDurationSec = requiredEndAudioSec - chunk.startAudioSec
  if (decodedDurationSec <= 0) {
    throw new DynamicGridScanError('decode-failed', 'native decode returned zero duration')
  }
  if (decodedDurationSec < requiredDurationSec - DECODE_TRUNCATION_TOLERANCE_SEC) {
    throw new DynamicGridScanError(
      'decode-truncated',
      `decoded ${decodedDurationSec.toFixed(3)}s at ${chunk.startAudioSec.toFixed(3)}s ` +
        `but windows require ${requiredDurationSec.toFixed(3)}s`
    )
  }
  if (decodedDurationSec > chunk.durationSec + DECODE_OVERSHOOT_TOLERANCE_SEC) {
    throw new DynamicGridScanError(
      'decode-range-mismatch',
      `decoded more audio than requested at ${chunk.startAudioSec.toFixed(3)}s`
    )
  }
  return decodedDurationSec
}

const assertEvidenceMatchesPlan = (params: {
  evidence: DynamicBeatWindowEvidence[]
  chunk: DynamicGridChunkPlan
}) => {
  const { evidence, chunk } = params
  const byId = new Map(evidence.map((item) => [item.windowId, item]))
  if (byId.size !== evidence.length || evidence.length !== chunk.windows.length) {
    throw new DynamicGridScanError('evidence-mismatch', 'bridge returned a different window set')
  }
  for (const planned of chunk.windows) {
    const item = byId.get(planned.windowId)
    if (!item) {
      throw new DynamicGridScanError(
        'evidence-mismatch',
        `bridge response is missing window ${planned.windowId}`
      )
    }
    if (Math.abs(item.startAudioSec - planned.startAudioSec) > WINDOW_START_TOLERANCE_SEC) {
      throw new DynamicGridScanError(
        'evidence-mismatch',
        `window ${planned.windowId} absolute start drifted ` +
          `(${item.startAudioSec.toFixed(3)} vs ${planned.startAudioSec.toFixed(3)})`
      )
    }
    if (Math.abs(item.analyzedDurationSec - planned.durationSec) > WINDOW_START_TOLERANCE_SEC) {
      throw new DynamicGridScanError(
        'evidence-mismatch',
        `window ${planned.windowId} analyzed duration drifted`
      )
    }
  }
}

const buildCoverage = (params: {
  durationAudioSec: number
  scope: DynamicGridScanScope
  coarseWindows: DynamicGridWindowPlan[]
  refinedWindows: DynamicGridWindowPlan[]
  evidence: DynamicBeatWindowEvidence[]
  decodedAudioSec: number
}): DynamicGridScanCoverage => {
  const { durationAudioSec, scope, coarseWindows, refinedWindows, evidence, decodedAudioSec } =
    params
  const allWindows = [...coarseWindows, ...refinedWindows].sort(
    (left, right) => left.startAudioSec - right.startAudioSec
  )
  const merged: Array<{ startAudioSec: number; endAudioSec: number }> = []
  for (const window of allWindows) {
    const startAudioSec = window.startAudioSec
    const endAudioSec = Math.min(durationAudioSec, window.startAudioSec + window.durationSec)
    const previous = merged[merged.length - 1]
    if (previous && startAudioSec <= previous.endAudioSec + PLAN_EPSILON_SEC) {
      previous.endAudioSec = Math.max(previous.endAudioSec, endAudioSec)
    } else {
      merged.push({ startAudioSec, endAudioSec })
    }
  }
  const gaps: Array<{ startAudioSec: number; endAudioSec: number }> = []
  if (merged.length === 0) {
    gaps.push({ startAudioSec: 0, endAudioSec: durationAudioSec })
  } else {
    if (merged[0].startAudioSec > PLAN_EPSILON_SEC) {
      gaps.push({ startAudioSec: 0, endAudioSec: merged[0].startAudioSec })
    }
    for (let index = 1; index < merged.length; index += 1) {
      if (merged[index].startAudioSec > merged[index - 1].endAudioSec + PLAN_EPSILON_SEC) {
        gaps.push({
          startAudioSec: merged[index - 1].endAudioSec,
          endAudioSec: merged[index].startAudioSec
        })
      }
    }
    const tailStart = merged[merged.length - 1].endAudioSec
    if (tailStart < durationAudioSec - PLAN_EPSILON_SEC) {
      gaps.push({ startAudioSec: tailStart, endAudioSec: durationAudioSec })
    }
  }
  const noBeatsRanges = evidence
    .filter((item) => item.status === 'no-beats')
    .map((item) => ({
      startAudioSec: item.startAudioSec,
      endAudioSec: roundSec(item.startAudioSec + item.analyzedDurationSec),
      windowId: item.windowId
    }))

  return {
    scope,
    durationAudioSec: roundSec(durationAudioSec),
    coarseWindows: coarseWindows.length,
    refinedWindows: refinedWindows.length,
    analyzedWindows: evidence.length,
    noBeatsWindows: noBeatsRanges.length,
    decodedAudioSec: roundSec(decodedAudioSec),
    analyzedRanges: merged.map((range) => ({
      startAudioSec: roundSec(range.startAudioSec),
      endAudioSec: roundSec(range.endAudioSec)
    })),
    gaps,
    noBeatsRanges,
    timing: {
      decodeApi: 'decodeAudioFileNativePcm',
      decodeStartBasis: 'audible-origin-verified',
      sampleAccurateSeek: false,
      seekAlignmentToleranceSec: DECODE_START_TOLERANCE_SEC,
      chunkSec: DYNAMIC_GRID_CHUNK_SEC,
      chunkOverlapSec: DYNAMIC_GRID_CHUNK_OVERLAP_SEC,
      coarseWindowSec: DYNAMIC_GRID_COARSE_WINDOW_SEC,
      coarseStepSec: DYNAMIC_GRID_COARSE_STEP_SEC,
      refineWindowSec: DYNAMIC_GRID_REFINE_WINDOW_SEC,
      refineStepSec: DYNAMIC_GRID_REFINE_STEP_SEC
    }
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const toScanError = (error: unknown): DynamicGridScanError => {
  if (error instanceof DynamicGridScanError) return error
  const code = (error as { code?: string } | null)?.code
  const message = errorMessage(error)
  if (code === 'request-timeout' || code === 'bridge-ready-timeout') {
    return new DynamicGridScanError('timeout', message)
  }
  if (code === 'request-cancelled') {
    return new DynamicGridScanError('cancelled', message)
  }
  return new DynamicGridScanError('evidence-mismatch', message)
}

export const scanDynamicBeatGrid = async (
  options: DynamicGridScanOptions
): Promise<DynamicGridScanResult> => {
  assertFiniteDuration(options.durationAudioSec)
  if (!options.filePath || !String(options.filePath).trim()) {
    throw new DynamicGridScanError('invalid-duration', 'filePath must not be empty')
  }
  const sampleRate = Math.max(1, Math.floor(options.sampleRate ?? DYNAMIC_GRID_SAMPLE_RATE))
  const channels = Math.max(1, Math.floor(options.channels ?? DYNAMIC_GRID_CHANNELS))
  const onlyRefine = Boolean(options.onlyRefine)
  const refineRegions = options.refineRegions ?? []
  if (onlyRefine && refineRegions.length === 0) {
    throw new DynamicGridScanError('invalid-plan', 'onlyRefine requires at least one refineRegion')
  }
  const scope: DynamicGridScanScope = onlyRefine ? 'refine-only' : 'full'
  const coarseWindows = onlyRefine ? [] : planCoarseBeatWindows(options.durationAudioSec)
  const refinedWindows = planRefinedBeatWindows(refineRegions, options.durationAudioSec)
  if (onlyRefine && refinedWindows.length === 0) {
    throw new DynamicGridScanError(
      'invalid-plan',
      'refineRegions did not produce any analyzable windows'
    )
  }
  if (coarseWindows.length + refinedWindows.length > DYNAMIC_BEAT_GRID_POLICY.maxWindows) {
    throw new DynamicGridScanError(
      'unsupported-window-budget',
      `planned ${coarseWindows.length + refinedWindows.length} windows exceeds ` +
        `policy maxWindows ${DYNAMIC_BEAT_GRID_POLICY.maxWindows}`
    )
  }
  const totalWindows = coarseWindows.length + refinedWindows.length
  const maxTotalMs = Number(options.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS)
  const maxNoProgressMs = Number(options.maxNoProgressMs ?? DEFAULT_MAX_NO_PROGRESS_MS)
  if (!Number.isFinite(maxTotalMs) || maxTotalMs <= 0) {
    throw new DynamicGridScanError('invalid-budget', 'maxTotalMs must be a finite positive number')
  }
  if (!Number.isFinite(maxNoProgressMs) || maxNoProgressMs <= 0) {
    throw new DynamicGridScanError(
      'invalid-budget',
      'maxNoProgressMs must be a finite positive number'
    )
  }
  assertNotAborted(options.signal)
  const defaults = loadDefaultDecodeDeps()
  const decodeChunk = options.deps?.decodeChunk ?? defaults.decodeChunk
  const createSession = options.deps?.createSession ?? defaults.createSession
  const now = options.deps?.now ?? Date.now
  const deadlineAt = now() + maxTotalMs
  let lastProgressAt = now()
  const session = createSession({ onProcessChange: options.onSidecarChange })
  const phases: ReadonlyArray<'scan' | 'refine'> = onlyRefine ? ['refine'] : ['scan', 'refine']

  const evidenceById = new Map<string, DynamicBeatWindowEvidence>()
  const chunkBoundaries: DynamicGridChunkBoundary[] = []
  let decodedAudioSec = 0
  let completedWindows = 0
  let coveredAudioSec = 0
  let sidecarPid: number | null = null

  try {
    for (const phase of phases) {
      const phaseWindows = phase === 'scan' ? coarseWindows : refinedWindows
      if (phaseWindows.length === 0) continue
      const chunks = planDecodeChunks(options.durationAudioSec, phaseWindows)
      for (const chunk of chunks) {
        assertWithinBudget({
          signal: options.signal,
          now,
          deadlineAt,
          lastProgressAt,
          maxNoProgressMs
        })
        let decoded: DynamicGridDecodedPcm
        try {
          decoded = decodeChunk({
            filePath: options.filePath,
            startSec: chunk.startAudioSec,
            maxDurationSec: chunk.durationSec,
            sampleRate,
            channels
          })
        } catch (error) {
          throw new DynamicGridScanError('decode-failed', errorMessage(error))
        }
        assertWithinBudget({
          signal: options.signal,
          now,
          deadlineAt,
          lastProgressAt,
          maxNoProgressMs
        })
        const decodedDurationSec = validateDecodedChunk({
          decoded,
          chunk,
          sampleRate,
          channels
        })
        decodedAudioSec += decodedDurationSec
        chunkBoundaries.push({
          phase: chunk.phase,
          chunkId: chunk.chunkId,
          startAudioSec: chunk.startAudioSec,
          requestedDurationSec: chunk.durationSec,
          decodedDurationSec: roundSec(decodedDurationSec),
          windowCount: chunk.windows.length
        })

        const remainingMs = Math.max(1, deadlineAt - now())
        const evidence = await session.analyzeWindows({
          pcmData: decoded.pcmData,
          sampleRate,
          channels,
          chunkStartAudioSec: chunk.startAudioSec,
          windows: chunk.windows.map((window) => ({
            windowId: window.windowId,
            localStartSec: roundSec(window.startAudioSec - chunk.startAudioSec),
            durationSec: window.durationSec
          })),
          timeoutMs: Math.min(resolveWindowRequestTimeoutMs(chunk.windows.length), remainingMs),
          signal: options.signal
        })
        assertWithinBudget({
          signal: options.signal,
          now,
          deadlineAt,
          lastProgressAt,
          maxNoProgressMs
        })
        assertEvidenceMatchesPlan({ evidence, chunk })
        sidecarPid = session.pid ?? sidecarPid
        for (const item of evidence) {
          evidenceById.set(item.windowId, item)
        }
        completedWindows += chunk.windows.length
        lastProgressAt = now()
        coveredAudioSec = Math.max(
          coveredAudioSec,
          chunk.windows.reduce(
            (end, window) => Math.max(end, window.startAudioSec + window.durationSec),
            0
          )
        )
        options.onProgress?.({
          phase,
          completedWindows,
          totalWindows,
          coveredAudioSec: roundSec(Math.min(coveredAudioSec, options.durationAudioSec)),
          sidecarPid: session.pid ?? sidecarPid
        })
      }
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw new DynamicGridScanError('cancelled', 'dynamic grid scan was cancelled')
    }
    throw toScanError(error)
  } finally {
    await session.close()
  }

  const orderedEvidence = [...coarseWindows, ...refinedWindows].map((window) => {
    const item = evidenceById.get(window.windowId)
    if (!item) {
      throw new DynamicGridScanError(
        'evidence-mismatch',
        `missing evidence for window ${window.windowId}`
      )
    }
    return item
  })
  options.onProgress?.({
    phase: 'complete',
    completedWindows,
    totalWindows,
    coveredAudioSec: roundSec(Math.min(coveredAudioSec, options.durationAudioSec)),
    // The sidecar has already been closed by the finally block above.
    sidecarPid: null
  })

  return {
    windows: orderedEvidence,
    // The owned sidecar is already closed here. A PID snapshot would be stale
    // and could be reused by the OS; lifecycle belongs to onSidecarChange.
    runtime: { sidecarPid: null },
    scanScope: scope,
    coverage: buildCoverage({
      durationAudioSec: options.durationAudioSec,
      scope,
      coarseWindows,
      refinedWindows,
      evidence: orderedEvidence,
      decodedAudioSec
    }),
    chunkBoundaries,
    policyVersion: DYNAMIC_GRID_SCAN_POLICY_VERSION
  }
}

export { probeDynamicGridAudioDuration } from './dynamicGridDurationProbe'
