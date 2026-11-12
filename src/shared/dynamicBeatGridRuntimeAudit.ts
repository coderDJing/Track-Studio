import type { SongBeatGridLineV2 } from './songBeatGridMapV2'
import type { DynamicBeatGridPolicy } from './dynamicBeatGridTypes'
import type { DynamicFitPoint } from './dynamicBeatGridFit'

export type DynamicRuntimeMatchedPair = {
  lineIndex: number
  pointIndex: number
  residualMs: number
}

export type DynamicRuntimeAudit = {
  runtimeLineCount: number
  matchedPairs: DynamicRuntimeMatchedPair[]
  unmatchedLineIndices: number[]
  unmatchedPointIndices: number[]
  unmatchedHeadLineCount: number
  unmatchedTailLineCount: number
  unmatchedMiddleLineCount: number
  headTailInvalidCount: number
  ordinalMismatchCount: number
  downbeatMismatchCount: number
  boundaryMismatchCount: number
  boundaryErrorMaxMs: number
  residualP50Ms: number
  residualP95Ms: number
  residualMaxMs: number
  tailErrorMs: number
  lastPointMatched: boolean
}

export type DynamicRuntimeAuditResult =
  { status: 'ok'; audit: DynamicRuntimeAudit } | { status: 'error'; reason: string }

const nearestRankPercentile = (values: readonly number[], percentile: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1))
  return sorted[index]
}

const median = (values: readonly number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * 最终展开拍线对证据做全曲单调一对一审计。
 *
 * 允许三类未匹配：
 * - runtime line 对应推断出的缺失拍，但必须落在两个已匹配证据拍之间，且两侧 ordinal 差
 *   与 runtime ordinal 差一致；
 * - evidence point 是拟合阶段明确剔除的离群点，数量不得超过 excludedBeatCount；
 * - 首个检测拍之前/最后一个检测拍之后最多各一根合理外推线（首个检测拍可能缺失），
 *   距离必须在一个局部拍间隔内，并单独计数。接缝中间的多拍不会被头尾规则放过。
 *
 * 任何额外/缺失的 runtime line、跨 clip 的异常间隔、ordinal 跳变或 downbeat 错位都会
 * 进入审计计数，由调用方拒绝结果。
 */
export const auditDynamicBeatGridRuntime = (params: {
  lines: readonly SongBeatGridLineV2[]
  points: readonly DynamicFitPoint[]
  policy: DynamicBeatGridPolicy
}): DynamicRuntimeAuditResult => {
  const { lines, points, policy } = params
  if (!lines.length) return { status: 'error', reason: 'runtime-lines-empty' }
  if (!points.length) return { status: 'error', reason: 'evidence-points-empty' }
  const toleranceSec = policy.maxResidualMs / 1000

  const matchedPairs: DynamicRuntimeMatchedPair[] = []
  const unmatchedLineIndices: number[] = []
  const unmatchedPointIndices: number[] = []
  let pointIndex = 0
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    while (pointIndex < points.length && points[pointIndex].timeSec < line.sec - toleranceSec) {
      unmatchedPointIndices.push(pointIndex)
      pointIndex += 1
    }
    if (pointIndex >= points.length) {
      unmatchedLineIndices.push(lineIndex)
      continue
    }
    const point = points[pointIndex]
    const residualSec = point.timeSec - line.sec
    if (Math.abs(residualSec) <= toleranceSec) {
      matchedPairs.push({
        lineIndex,
        pointIndex,
        residualMs: Math.abs(residualSec) * 1000
      })
      pointIndex += 1
    } else {
      unmatchedLineIndices.push(lineIndex)
    }
  }
  while (pointIndex < points.length) {
    unmatchedPointIndices.push(pointIndex)
    pointIndex += 1
  }

  const firstMatchedLineIndex = matchedPairs.length ? matchedPairs[0].lineIndex : -1
  const lastMatchedLineIndex = matchedPairs.length
    ? matchedPairs[matchedPairs.length - 1].lineIndex
    : -1
  let unmatchedHeadLineCount = 0
  let unmatchedTailLineCount = 0
  let unmatchedMiddleLineCount = 0
  let headTailInvalidCount = 0
  const firstMatchedPoint = matchedPairs.length ? points[matchedPairs[0].pointIndex] : null
  const lastMatchedPoint = matchedPairs.length
    ? points[matchedPairs[matchedPairs.length - 1].pointIndex]
    : null
  for (const lineIndex of unmatchedLineIndices) {
    const line = lines[lineIndex]
    if (firstMatchedLineIndex < 0) {
      headTailInvalidCount += 1
      continue
    }
    if (lineIndex < firstMatchedLineIndex) {
      unmatchedHeadLineCount += 1
      const periodSec = 60 / line.bpm
      const distanceSec = firstMatchedPoint
        ? firstMatchedPoint.timeSec - line.sec
        : Number.POSITIVE_INFINITY
      if (
        !firstMatchedPoint ||
        distanceSec <= 0 ||
        distanceSec > periodSec * 1.5 ||
        periodSec <= 0
      ) {
        headTailInvalidCount += 1
      }
      continue
    }
    if (lineIndex > lastMatchedLineIndex) {
      unmatchedTailLineCount += 1
      const periodSec = 60 / line.bpm
      const distanceSec = lastMatchedPoint
        ? line.sec - lastMatchedPoint.timeSec
        : Number.POSITIVE_INFINITY
      if (
        !lastMatchedPoint ||
        distanceSec <= 0 ||
        distanceSec > periodSec * 1.5 ||
        periodSec <= 0
      ) {
        headTailInvalidCount += 1
      }
      continue
    }
    unmatchedMiddleLineCount += 1
  }

  let ordinalMismatchCount = 0
  for (let index = 1; index < matchedPairs.length; index += 1) {
    const previous = matchedPairs[index - 1]
    const current = matchedPairs[index]
    const lineOrdinalGap =
      lines[current.lineIndex].beatOrdinal - lines[previous.lineIndex].beatOrdinal
    const pointOrdinalGap = points[current.pointIndex].ordinal - points[previous.pointIndex].ordinal
    if (lineOrdinalGap !== pointOrdinalGap) ordinalMismatchCount += 1
  }

  let downbeatMismatchCount = 0
  for (const pair of matchedPairs) {
    const lineIsDownbeat = lines[pair.lineIndex].level === 'downbeat'
    if (lineIsDownbeat !== points[pair.pointIndex].isDownbeat) downbeatMismatchCount += 1
  }

  const pairByLineIndex = new Map<number, DynamicRuntimeMatchedPair>()
  for (const pair of matchedPairs) pairByLineIndex.set(pair.lineIndex, pair)
  let boundaryMismatchCount = 0
  let boundaryErrorMaxMs = 0
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].clipIndex === lines[index - 1].clipIndex) continue
    const leftPair = pairByLineIndex.get(index - 1)
    const rightPair = pairByLineIndex.get(index)
    if (!leftPair || !rightPair) {
      boundaryMismatchCount += 1
      continue
    }
    const runtimeDelta = lines[index].sec - lines[index - 1].sec
    const evidenceDelta = points[rightPair.pointIndex].timeSec - points[leftPair.pointIndex].timeSec
    const errorMs = Math.abs(runtimeDelta - evidenceDelta) * 1000
    if (errorMs > boundaryErrorMaxMs) boundaryErrorMaxMs = errorMs
    const localPeriod = Math.min(60 / lines[index].bpm, 60 / lines[index - 1].bpm)
    if (
      runtimeDelta <= 0 ||
      runtimeDelta < localPeriod * 0.5 ||
      runtimeDelta > localPeriod * 2.5 ||
      errorMs > policy.maxResidualMs
    ) {
      boundaryMismatchCount += 1
    }
  }

  const residualsMs = matchedPairs.map((pair) => pair.residualMs)
  const lastPointIndex = points.length - 1
  const lastPair = matchedPairs.find((pair) => pair.pointIndex === lastPointIndex)
  const tailErrorMs = lastPair
    ? lastPair.residualMs
    : Math.abs(lines[lines.length - 1].sec - points[lastPointIndex].timeSec) * 1000

  return {
    status: 'ok',
    audit: {
      runtimeLineCount: lines.length,
      matchedPairs,
      unmatchedLineIndices,
      unmatchedPointIndices,
      unmatchedHeadLineCount,
      unmatchedTailLineCount,
      unmatchedMiddleLineCount,
      headTailInvalidCount,
      ordinalMismatchCount,
      downbeatMismatchCount,
      boundaryMismatchCount,
      boundaryErrorMaxMs,
      residualP50Ms: median(residualsMs),
      residualP95Ms: nearestRankPercentile(residualsMs, 0.95),
      residualMaxMs: residualsMs.length ? Math.max(...residualsMs) : 0,
      tailErrorMs,
      lastPointMatched: Boolean(lastPair)
    }
  }
}
