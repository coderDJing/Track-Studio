import { analyzeDynamicBeatGridEvidence } from '../../shared/dynamicBeatGridAnalysis'
import { DYNAMIC_BEAT_GRID_POLICY } from '../../shared/dynamicBeatGridTypes'
import type {
  DynamicBeatWindowEvidence,
  DynamicGridOutcome
} from '../../shared/dynamicBeatGridTypes'
import {
  DynamicGridScanError,
  probeDynamicGridAudioDuration,
  scanDynamicBeatGrid,
  type DynamicGridRefineRegion,
  type DynamicGridScanProgress,
  type DynamicGridScanResult
} from './dynamicBeatGridScanner'
import type { DynamicGridProgress } from '../services/keyAnalysis/dynamicGridIntegration'

const MAX_REFINE_ROUNDS = 1
const MAX_REFINE_REGIONS = 6
const COVERAGE_DURATION_TOLERANCE_SEC = 0.05
const REFINE_COVERAGE_TOLERANCE_SEC = 0.1
const MIN_REFINE_BEATS = 4
const REFINE_TEMPO_JUMP_RATIO = 0.02

const toNumber = (value: unknown): number | undefined => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

const errorCode = (error: unknown): string | undefined => {
  if (error instanceof DynamicGridScanError) return error.code
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error || 'dynamic grid scan failed')).slice(
    0,
    300
  )

const mapScanError = (error: unknown): DynamicGridOutcome => {
  const code = errorCode(error)
  const message = errorMessage(error)
  if (code === 'cancelled') return { status: 'cancelled', reason: message }
  if (code === 'unsupported-short-duration' || code === 'unsupported-window-budget') {
    return { status: 'unsupported', reason: `${code}: ${message}` }
  }
  return { status: 'error', reason: `${code ?? 'scan-failed'}: ${message}` }
}

const median = (values: readonly number[]): number | undefined => {
  if (!values.length) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

const estimateWindowBeatIntervalSec = (window: DynamicBeatWindowEvidence): number | undefined => {
  const beats = window.beatsAudioSec
  if (!Array.isArray(beats) || beats.length < MIN_REFINE_BEATS) return undefined
  const intervals: number[] = []
  for (let index = 1; index < beats.length; index += 1) {
    const interval = beats[index] - beats[index - 1]
    if (Number.isFinite(interval) && interval > 0.1 && interval < 2) intervals.push(interval)
  }
  return median(intervals)
}

const mergeRegions = (
  regions: readonly DynamicGridRefineRegion[],
  maxRegions: number
): DynamicGridRefineRegion[] => {
  const sorted = regions
    .filter(
      (region) =>
        Number.isFinite(region.startAudioSec) &&
        Number.isFinite(region.endAudioSec) &&
        region.endAudioSec > region.startAudioSec
    )
    .sort((left, right) => left.startAudioSec - right.startAudioSec)
  const merged: DynamicGridRefineRegion[] = []
  for (const region of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && region.startAudioSec <= previous.endAudioSec) {
      previous.endAudioSec = Math.max(previous.endAudioSec, region.endAudioSec)
    } else {
      merged.push({ startAudioSec: region.startAudioSec, endAudioSec: region.endAudioSec })
    }
  }
  return merged.slice(0, maxRegions)
}

/**
 * 只针对可疑区间提出精扫区域：局部速度跳变、有拍/无拍边界、覆盖缺口。
 * 区域由粗扫证据产生，B 的 planner 会自行加 context 并按预算裁剪。
 */
export const planDynamicGridRefineRegions = (params: {
  windows: readonly DynamicBeatWindowEvidence[]
  gaps?: readonly { startAudioSec: number; endAudioSec: number }[]
  durationAudioSec: number
  maxRegions?: number
}): DynamicGridRefineRegion[] => {
  const maxRegions = Math.max(1, params.maxRegions ?? MAX_REFINE_REGIONS)
  const duration = toNumber(params.durationAudioSec)
  if (duration === undefined || duration <= 0) return []
  const windows = params.windows
    .filter(
      (window) =>
        Number.isFinite(window.startAudioSec) &&
        Number.isFinite(window.analyzedDurationSec) &&
        window.analyzedDurationSec > 0
    )
    .sort((left, right) => left.startAudioSec - right.startAudioSec)
  const regions: DynamicGridRefineRegion[] = []
  const clampStart = (value: number) => Math.max(0, Math.min(duration, value))
  const clampEnd = (value: number) => Math.max(0, Math.min(duration, value))

  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1]
    const current = windows[index]
    const previousEnd = previous.startAudioSec + previous.analyzedDurationSec
    const overlaps = current.startAudioSec <= previousEnd + 1e-6
    const previousInterval = estimateWindowBeatIntervalSec(previous)
    const currentInterval = estimateWindowBeatIntervalSec(current)
    if (previous.status === 'ok' && current.status === 'ok') {
      if (!overlaps || previousInterval === undefined || currentInterval === undefined) continue
      const ratio =
        Math.abs(previousInterval - currentInterval) / Math.max(previousInterval, currentInterval)
      if (ratio < REFINE_TEMPO_JUMP_RATIO) continue
      regions.push({
        startAudioSec: clampStart(previous.startAudioSec),
        endAudioSec: clampEnd(current.startAudioSec + current.analyzedDurationSec)
      })
      continue
    }
    if (previous.status !== current.status) {
      // 有拍 / 无拍切换边界需要更小窗口确认相位，而不是整段重扫。
      const boundary =
        previous.status === 'ok' ? previousEnd : current.startAudioSec + current.analyzedDurationSec
      regions.push({
        startAudioSec: clampStart(boundary - previous.analyzedDurationSec),
        endAudioSec: clampEnd(boundary + current.analyzedDurationSec)
      })
    }
  }
  for (const gap of params.gaps ?? []) {
    const startAudioSec = toNumber(gap.startAudioSec)
    const endAudioSec = toNumber(gap.endAudioSec)
    if (startAudioSec === undefined || endAudioSec === undefined) continue
    if (endAudioSec <= startAudioSec) continue
    if (endAudioSec - startAudioSec > DYNAMIC_BEAT_GRID_POLICY.windowDurationSec * 2) continue
    regions.push({
      startAudioSec: clampStart(startAudioSec),
      endAudioSec: clampEnd(endAudioSec)
    })
  }
  return mergeRegions(regions, maxRegions)
}

type CoverageValidation = { ok: true } | { ok: false; outcome: DynamicGridOutcome }

const validateFullCoverage = (
  result: DynamicGridScanResult,
  expectedDurationSec: number
): CoverageValidation => {
  const coverage = result.coverage
  if (!coverage || !Array.isArray(coverage.gaps) || !coverage.timing) {
    return { ok: false, outcome: { status: 'error', reason: 'scan-coverage-missing' } }
  }
  const coverageDuration = toNumber(coverage.durationAudioSec)
  if (
    coverageDuration === undefined ||
    Math.abs(coverageDuration - expectedDurationSec) > COVERAGE_DURATION_TOLERANCE_SEC
  ) {
    return { ok: false, outcome: { status: 'error', reason: 'coverage-duration-mismatch' } }
  }
  if (typeof coverage.timing.sampleAccurateSeek !== 'boolean') {
    return { ok: false, outcome: { status: 'error', reason: 'coverage-timing-missing' } }
  }
  const gapSec = coverage.gaps.reduce(
    (sum, gap) => sum + Math.max(0, Number(gap.endAudioSec) - Number(gap.startAudioSec)),
    0
  )
  const coveredRatio = (expectedDurationSec - gapSec) / expectedDurationSec
  if (!Number.isFinite(coveredRatio) || coveredRatio > 1 + 1e-6) {
    return { ok: false, outcome: { status: 'error', reason: 'coverage-gap-invalid' } }
  }
  if (coveredRatio + 1e-6 < DYNAMIC_BEAT_GRID_POLICY.minScannedCoverageRatio) {
    return {
      ok: false,
      outcome: { status: 'unresolved', reason: `insufficient-coverage:${coveredRatio.toFixed(4)}` }
    }
  }
  return { ok: true }
}

const mergeWindowRanges = (
  windows: readonly DynamicBeatWindowEvidence[]
): Array<{ startAudioSec: number; endAudioSec: number }> => {
  const ranges = windows
    .map((window) => ({
      startAudioSec: window.startAudioSec,
      endAudioSec: window.startAudioSec + window.analyzedDurationSec
    }))
    .sort((left, right) => left.startAudioSec - right.startAudioSec)
  const merged: Array<{ startAudioSec: number; endAudioSec: number }> = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range.startAudioSec <= previous.endAudioSec + 1e-6) {
      previous.endAudioSec = Math.max(previous.endAudioSec, range.endAudioSec)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * L2 只精扫局部时，coverage 只描述这些区域；全曲覆盖由 L1 的粗扫结果负责，
 * 这里只校验每个请求区域确实拿到了证据，不允许“缺一块也算成功”。
 */
const validateRefineCoverage = (
  windows: readonly DynamicBeatWindowEvidence[],
  regions: readonly DynamicGridRefineRegion[]
): CoverageValidation => {
  if (windows.length === 0) {
    return { ok: false, outcome: { status: 'unresolved', reason: 'refine-no-evidence' } }
  }
  const ranges = mergeWindowRanges(windows)
  for (const region of regions) {
    let coveredSec = 0
    for (const range of ranges) {
      const overlap =
        Math.min(range.endAudioSec, region.endAudioSec) -
        Math.max(range.startAudioSec, region.startAudioSec)
      if (overlap > 0) coveredSec += overlap
    }
    const requiredSec =
      region.endAudioSec - region.startAudioSec - 2 * REFINE_COVERAGE_TOLERANCE_SEC
    if (coveredSec < requiredSec) {
      return {
        ok: false,
        outcome: {
          status: 'unresolved',
          reason: `refine-region-uncovered:${region.startAudioSec.toFixed(3)}-${region.endAudioSec.toFixed(3)}`
        }
      }
    }
  }
  return { ok: true }
}

const regionSignature = (regions: readonly DynamicGridRefineRegion[]) =>
  regions
    .map((region) => `${region.startAudioSec.toFixed(3)}-${region.endAudioSec.toFixed(3)}`)
    .join('|')

const isFullScanResult = (result: DynamicGridScanResult, coarseWindowIds: ReadonlySet<string>) =>
  result.windows.filter((window) => coarseWindowIds.has(window.windowId)).length > 0

export const runDynamicBeatGridAnalysis = async (params: {
  filePath: string
  durationAudioSec?: number
  minBpm?: number
  maxBpm?: number
  onProgress?: (progress: DynamicGridProgress) => void
  signal?: AbortSignal
}): Promise<DynamicGridOutcome> => {
  const providedDurationSec = toNumber(params.durationAudioSec)
  let probedDurationSec: number | null = null
  if (providedDurationSec === undefined || providedDurationSec <= 0) {
    // 时长必须来自可靠音频元数据；绝不回退 Normal，也不用全曲 PCM 现算。
    try {
      probedDurationSec = await probeDynamicGridAudioDuration(params.filePath)
    } catch {
      return { status: 'unsupported', reason: 'audio-duration-unavailable' }
    }
  }
  const durationAudioSec =
    providedDurationSec !== undefined && providedDurationSec > 0
      ? providedDurationSec
      : probedDurationSec
  if (durationAudioSec === null || !Number.isFinite(durationAudioSec) || durationAudioSec <= 0) {
    return { status: 'unsupported', reason: 'audio-duration-unavailable' }
  }

  let sidecarPid: number | null = null
  const emitProgress = (progress: DynamicGridProgress) => {
    if (!params.onProgress) return
    params.onProgress(sidecarPid === null ? progress : { ...progress, sidecarPid })
  }
  const observeSidecar = (pid: number | null | undefined) => {
    if (pid === undefined) return
    if (pid === sidecarPid) return
    sidecarPid = pid
    emitProgress({ phase: 'scan', sidecarPid: pid })
  }

  let scan: DynamicGridScanResult
  try {
    emitProgress({ phase: 'scan', completedWindows: 0, coveredAudioSec: 0 })
    // 非字面量对象：B 增加 onSidecarChange 后无需改这里即可透传。
    const scanOptions = {
      filePath: params.filePath,
      durationAudioSec,
      signal: params.signal,
      onSidecarChange: observeSidecar,
      onProgress: (progress: DynamicGridScanProgress) => {
        emitProgress({
          phase: progress.phase === 'refine' ? 'refine' : 'scan',
          completedWindows: progress.completedWindows,
          totalWindows: progress.totalWindows,
          coveredAudioSec: progress.coveredAudioSec
        })
      }
    }
    scan = await scanDynamicBeatGrid(scanOptions)
  } catch (error) {
    return mapScanError(error)
  }
  const initialCoverage = validateFullCoverage(scan, durationAudioSec)
  if (!initialCoverage.ok) return initialCoverage.outcome

  const coarseWindowIds = new Set(scan.windows.map((window) => window.windowId))
  const windowsById = new Map(scan.windows.map((window) => [window.windowId, window]))
  const fit = () =>
    analyzeDynamicBeatGridEvidence({
      windows: [...windowsById.values()],
      durationAudioSec,
      minBpm: params.minBpm,
      maxBpm: params.maxBpm
    })
  emitProgress({
    phase: 'fit',
    completedWindows: scan.coverage.analyzedWindows,
    totalWindows: scan.coverage.analyzedWindows,
    coveredAudioSec: scan.coverage.decodedAudioSec
  })
  let outcome = fit()
  const attemptedRegions = new Set<string>()

  for (let round = 0; round < MAX_REFINE_ROUNDS && outcome.status === 'unresolved'; round += 1) {
    const regions = planDynamicGridRefineRegions({
      windows: [...windowsById.values()],
      gaps: scan.coverage.gaps,
      durationAudioSec
    })
    if (!regions.length) break
    const signature = regionSignature(regions)
    if (attemptedRegions.has(signature)) break
    attemptedRegions.add(signature)
    emitProgress({
      phase: 'refine',
      completedWindows: 0,
      totalWindows: regions.length,
      coveredAudioSec: scan.coverage.decodedAudioSec
    })
    try {
      // onlyRefine 让 B 只解码局部 regions；B 若尚未支持该选项会退化为整体重扫，
      // 下面的 isFullScanResult 分支同时兼容两种返回形态。
      const refineOptions = {
        filePath: params.filePath,
        durationAudioSec,
        refineRegions: regions,
        onlyRefine: true,
        signal: params.signal,
        onSidecarChange: observeSidecar,
        onProgress: (progress: DynamicGridScanProgress) => {
          emitProgress({
            phase: progress.phase === 'complete' ? 'fit' : progress.phase,
            completedWindows: progress.completedWindows,
            totalWindows: progress.totalWindows,
            coveredAudioSec: progress.coveredAudioSec
          })
        }
      }
      scan = await scanDynamicBeatGrid(refineOptions)
    } catch (error) {
      const mapped = mapScanError(error)
      // 精扫失败不覆盖已有粗扫证据：取消/不支持直接返回，其它错误保留 unresolved 原因。
      if (mapped.status === 'cancelled' || mapped.status === 'unsupported') return mapped
      break
    }
    const fullScan = isFullScanResult(scan, coarseWindowIds)
    const coverage = fullScan
      ? validateFullCoverage(scan, durationAudioSec)
      : validateRefineCoverage(scan.windows, regions)
    if (!coverage.ok) {
      if (coverage.outcome.status === 'unresolved') {
        outcome = coverage.outcome
        continue
      }
      return coverage.outcome
    }
    for (const window of scan.windows) windowsById.set(window.windowId, window)
    emitProgress({
      phase: 'fit',
      completedWindows: windowsById.size,
      totalWindows: windowsById.size,
      coveredAudioSec: scan.coverage.decodedAudioSec
    })
    outcome = fit()
  }

  return outcome
}
