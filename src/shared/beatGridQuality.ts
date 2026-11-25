/**
 * 网格质量标记：告诉用户「这首的网格需要听一遍」。
 *
 * 只标记有问题的网格，正常的网格不占任何位置。质量判定和网格本身是两件事：
 * 网格 fit 是 fail-closed 的（超阈值直接不落库），能落库的网格已经满足 reject
 * 阈值；这里判断的是它离阈值有多近——近到一定程度就值得让用户复查。
 *
 * 判定版本独立于网格 policy 版本：网格本身没变时不应该触发全量重算。
 */
export const SONG_BEAT_GRID_QUALITY_VERSION = 'beat-grid-quality-2026-11-25.1'

export type SongBeatGridQualityReason = 'drift' | 'degraded'

export type SongBeatGridQuality = {
  status: 'unsure'
  /** drift：某段网格和音乐有偏差；degraded：网格没能精确生成，用的是较粗的网格。 */
  reason: SongBeatGridQualityReason
  version: string
  /** 漂移所在段落的 clip 序号。网格段落顺序在 audio / timeline 之间保持一致。 */
  clipIndex?: number
  /** 漂移开始的秒数（timeline 坐标）。整曲性问题不带这个字段。 */
  sinceSec?: number
}

/**
 * 「勉强通过」阈值：能落库的网格已经满足 reject 阈值，这些比例用来判断它离
 * reject 阈值有多近。near = ratio * reject 阈值。
 *
 * 和网格 policy 一样，这些比例是实验起点，尚未在真实音频上标定；调整它们
 * 只影响标记，不影响网格本身。
 */
export const SONG_BEAT_GRID_QUALITY_THRESHOLDS = {
  /** 分段残差 p95 达到 reject 阈值的这个比例即视为需要复查。 */
  residualP95Ratio: 0.6,
  /** 单拍最大残差达到 reject 阈值的这个比例即视为需要复查。 */
  residualMaxRatio: 0.6,
  /** 无法解释的拍点占比达到 reject 阈值的这个比例即视为需要复查。 */
  unexplainedRatio: 0.5
} as const

/**
 * 固定网格（Normal 路径）的漂移上限，单位 ms。
 *
 * 复用仓库既有的刻度：beat_this 的 beatThisEstimatedDrift128Ms（各滑窗 BPM
 * 的加权离散度换算成拍间隔误差、按 128 BPM 归一）超过 10ms 时，仓库自己就把它
 * 当作「速度会飘」，固定网格撑不住（scripts/beat_this_full_logit_rescue.py）。
 * 这里沿用同一个刻度，不另造数字。
 */
export const SONG_BEAT_GRID_FIXED_DRIFT_LIMIT_MS = 10

export type SongBeatGridQualitySegment = {
  clipIndex: number
  residualP95Ms: number
  residualMaxMs: number
}

const EPSILON = 1e-9

export const normalizeSongBeatGridQuality = (value: unknown): SongBeatGridQuality | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const carrier = value as Partial<SongBeatGridQuality>
  if (carrier.status !== 'unsure') return undefined
  if (carrier.reason !== 'drift' && carrier.reason !== 'degraded') return undefined
  const version =
    typeof carrier.version === 'string' && carrier.version.trim()
      ? carrier.version.trim()
      : SONG_BEAT_GRID_QUALITY_VERSION
  const clipIndex =
    typeof carrier.clipIndex === 'number' &&
    Number.isInteger(carrier.clipIndex) &&
    carrier.clipIndex >= 0
      ? carrier.clipIndex
      : undefined
  const sinceSec =
    typeof carrier.sinceSec === 'number' &&
    Number.isFinite(carrier.sinceSec) &&
    carrier.sinceSec >= 0
      ? Number(carrier.sinceSec.toFixed(3))
      : undefined
  return {
    status: 'unsure',
    reason: carrier.reason,
    version,
    ...(clipIndex === undefined ? {} : { clipIndex }),
    ...(sinceSec === undefined ? {} : { sinceSec })
  }
}

/**
 * 判定网格是否「勉强通过」。
 *
 * segments 按 clip 顺序给出每段的残差；返回最靠前的那段漂移（用户要听的第一个
 * 出问题的位置），而不是残差最大的那段——残差最大处未必是最早出问题的位置。
 * clipIndex 为 0 表示第一段就漂了，等同整曲都值得复查，因此不返回 clipIndex。
 */
export const resolveSongBeatGridDriftQuality = (params: {
  unexplainedBeatRatio: number
  segments: readonly SongBeatGridQualitySegment[]
  rejectThresholds: {
    p95ResidualMs: number
    maxResidualMs: number
    maxUnexplainedBeatRatio: number
  }
}): SongBeatGridQuality | undefined => {
  const { unexplainedBeatRatio, segments, rejectThresholds } = params
  const p95Limit =
    rejectThresholds.p95ResidualMs * SONG_BEAT_GRID_QUALITY_THRESHOLDS.residualP95Ratio
  const maxLimit =
    rejectThresholds.maxResidualMs * SONG_BEAT_GRID_QUALITY_THRESHOLDS.residualMaxRatio
  const unexplainedLimit =
    rejectThresholds.maxUnexplainedBeatRatio * SONG_BEAT_GRID_QUALITY_THRESHOLDS.unexplainedRatio

  const drifted = segments.find(
    (segment) =>
      segment.residualP95Ms >= p95Limit - EPSILON || segment.residualMaxMs >= maxLimit - EPSILON
  )
  const globalDrift = unexplainedBeatRatio >= unexplainedLimit - EPSILON
  if (!drifted && !globalDrift) return undefined

  return {
    status: 'unsure',
    reason: 'drift',
    version: SONG_BEAT_GRID_QUALITY_VERSION,
    ...(drifted && drifted.clipIndex > 0 ? { clipIndex: drifted.clipIndex } : {})
  }
}

/**
 * 动态网格拟合失败时使用：网格没能精确生成，退回较粗的网格。
 * 没有具体位置，所以不带 clipIndex / sinceSec。
 */
export const createSongBeatGridDegradedQuality = (): SongBeatGridQuality => ({
  status: 'unsure',
  reason: 'degraded',
  version: SONG_BEAT_GRID_QUALITY_VERSION
})

/**
 * 固定网格（Normal 路径）的漂移判定。
 *
 * estimatedDrift128Ms 来自 beat_this 的滑窗结果：各窗口 BPM 的加权离散度换算
 * 成拍间隔误差后按 128 BPM 归一。超过上限说明这首歌的速度本身会飘，用单一速度
 * 的固定网格必然在某些位置对不齐。
 *
 * 整曲性问题，所以不带 clipIndex / sinceSec。
 */
export const resolveSongBeatGridFixedDriftQuality = (params: {
  estimatedDrift128Ms: number | undefined
}): SongBeatGridQuality | undefined => {
  const drift = params.estimatedDrift128Ms
  if (typeof drift !== 'number' || !Number.isFinite(drift)) return undefined
  if (drift <= SONG_BEAT_GRID_FIXED_DRIFT_LIMIT_MS) return undefined
  return {
    status: 'unsure',
    reason: 'drift',
    version: SONG_BEAT_GRID_QUALITY_VERSION
  }
}

/**
 * 比较两个质量标记是否等价（用于列表合并时的等价判定，避免无意义的重建）。
 */
export const isSameSongBeatGridQuality = (
  left: SongBeatGridQuality | undefined,
  right: SongBeatGridQuality | undefined
): boolean => {
  if (!left && !right) return true
  if (!left || !right) return false
  return (
    left.status === right.status &&
    left.reason === right.reason &&
    left.version === right.version &&
    left.clipIndex === right.clipIndex &&
    left.sinceSec === right.sinceSec
  )
}
