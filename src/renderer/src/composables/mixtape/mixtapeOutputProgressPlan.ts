/**
 * 导出各阶段在 0–100 进度条上各占多宽，由「预估耗时」按比例分配，而不是拍几个常数。
 *
 * 之所以要算：各阶段的耗时不随时长等比变化，一份写死的区间在 10 分钟的工程上和在
 * 71 分钟的工程上会完全错位。实测（`tmp/r3-parity/timing-scale.html`，14 核 / 48000Hz）
 * 三个尺度下的耗时占比就差得很远：渲染在 600 秒时占 26%，到 2400 秒时已经占 35%。
 *
 * 下面的速率全部来自实测，单位见注释；`durationSec` 指时间线总长，`curveCount` 指需要
 * 采样 tempo 曲线的轨道数，`workerCount` 与 `mixtapeStretchPool` 的取值一致。
 */

export type MixtapeOutputStage = 'decode' | 'schedule' | 'curve' | 'stretch' | 'render' | 'encode'

export type MixtapeOutputProgressBand = { start: number; end: number }

export type MixtapeOutputProgressPlan = Record<MixtapeOutputStage, MixtapeOutputProgressBand>

// 解码：真实 mp3 经 decodeAudioData 实测 3.11ms 音频 / 秒（约 321× 实时）。
const DECODE_MS_PER_AUDIO_SECOND = 3.11
// 自动化调度：实测 0.0614ms 每（时间线秒 × 轨道）。
const SCHEDULE_MS_PER_TRACK_SECOND = 0.0614
// 曲线采样：实测 0.39~0.51ms 每（时间线秒 × 记录节点），取中偏上。
const CURVE_MS_PER_NODE_SECOND = 0.45
// 并行拉伸：单 worker 约 170ms 音频 / 秒（EngineFiner）。实测 139~229 之间波动。
const STRETCH_MS_PER_AUDIO_SECOND_PER_WORKER = 170
// 离线混音：随时长超线性恶化——整段混音、拉伸结果、解码源同时驻留内存，
// 缓冲越大缓存命中率越低。实测 600s→4.85ms/s、1800s→8.60、2400s→16.05。
const RENDER_MS_BASE_PER_SECOND = 2.5
const RENDER_MS_GROWTH_PER_SECOND = 0.0042
// WAV 编码：实测 0.86~0.95ms 每秒（Int16 双声道）。
const ENCODE_MS_PER_SECOND = 0.9

const STAGE_ORDER: MixtapeOutputStage[] = [
  'decode',
  'schedule',
  'curve',
  'stretch',
  'render',
  'encode'
]

export const estimateMixtapeOutputStageMs = (params: {
  durationSec: number
  trackCount: number
  /** 需要采样 tempo 曲线的轨道数；未知时按轨道总数估上界。 */
  curveTrackCount: number
  workerCount: number
}): Record<MixtapeOutputStage, number> => {
  const durationSec = Math.max(1, params.durationSec)
  const trackCount = Math.max(1, params.trackCount)
  const curveTrackCount = Math.max(0, params.curveTrackCount)
  const workerCount = Math.max(1, params.workerCount)
  return {
    decode: durationSec * DECODE_MS_PER_AUDIO_SECOND,
    schedule: durationSec * trackCount * SCHEDULE_MS_PER_TRACK_SECOND,
    curve: durationSec * curveTrackCount * CURVE_MS_PER_NODE_SECOND,
    stretch: (durationSec / workerCount) * STRETCH_MS_PER_AUDIO_SECOND_PER_WORKER,
    render: durationSec * (RENDER_MS_BASE_PER_SECOND + RENDER_MS_GROWTH_PER_SECOND * durationSec),
    encode: durationSec * ENCODE_MS_PER_SECOND
  }
}

/**
 * 把 [start, end] 这段百分比按预估耗时比例切给各阶段。
 *
 * 某一段估计成 0（比如没有任何轨道需要采样曲线）时不会分到百分比，也不会把相邻区间
 * 拉成零宽——它退化成一个点，前后区间在该点相接。
 */
export const buildMixtapeOutputProgressPlan = (
  estimates: Record<MixtapeOutputStage, number>,
  range: MixtapeOutputProgressBand
): MixtapeOutputProgressPlan => {
  const total = STAGE_ORDER.reduce((sum, stage) => sum + Math.max(0, estimates[stage]), 0)
  const span = range.end - range.start
  const plan = {} as MixtapeOutputProgressPlan
  let cursor = range.start
  if (!(total > 0) || !(span > 0)) {
    for (const stage of STAGE_ORDER) {
      plan[stage] = { start: range.start, end: range.start }
    }
    return plan
  }
  for (const stage of STAGE_ORDER) {
    const share = Math.max(0, estimates[stage]) / total
    const end = cursor + span * share
    plan[stage] = { start: cursor, end }
    cursor = end
  }
  // 浮点累加会留一点点残差，把最后一段钉到区间右端，保证进度条能走到 100% 的那条线上。
  plan.encode.end = range.end
  return plan
}
