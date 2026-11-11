import { clampTempo } from './timelineTransportR3Source'
import type { TransportPlayableSource } from './timelineTransportPlayableSource'

/**
 * tempo 自动化记录桩。
 *
 * 导出时 master-tempo 轨道要把变速拉伸搬到 Worker 池里跑，但拉伸依赖「每个 128 帧块
 * 用多大的 time ratio」——这个值来自调度阶段对 AudioParam 的 setTargetAtTime 自动化，
 * 只存在于音频线程内部，主线程读不到。
 *
 * 所以第一遍调度时先用这个桩顶替真实音源：它长得跟 createTransportR3Source 返回的
 * 源一模一样（playbackRate 的读值语义也一样，返回最近一次的目标值），但只是把事件
 * 记下来。拉伸时 Worker 再按这些事件还原逐块的 tempo；万一并发路径不可用，同一份
 * 事件也能原样重放到真实 AudioWorklet 源上，等于回到改动前的行为。
 */

export type MixtapeTempoTarget = {
  time: number
  value: number
  timeConstant: number
}

export type MixtapeTempoProbe = {
  source: TransportPlayableSource
  /** 记录到的 setTargetAtTime 目标值序列（连续重复项已合并，语义等价）。 */
  readTargets: () => MixtapeTempoTarget[]
  /** 参数被自动化之前的固有值，等于 R3 源上的 tempoRatio（已 clamp）。 */
  intrinsicValue: number
  /** 整条曲线是否恒等于固有值——这种情况下不需要任何目标值序列。 */
  isConstant: () => boolean
}

const DEFAULT_TIME_CONSTANT = 0.04

export const createMixtapeTempoProbe = (params: {
  buffer: AudioBuffer | null
  initialTempo: number
}): MixtapeTempoProbe => {
  const baseValue = clampTempo(params.initialTempo)
  let intrinsicValue = baseValue
  let tempoValue = baseValue
  const targets: MixtapeTempoTarget[] = []
  let lastTargetValue = Number.NaN
  let lastTimeConstant = Number.NaN
  let constant = true

  const playbackRate = {
    get value() {
      return tempoValue
    },
    set value(next: number) {
      tempoValue = clampTempo(next)
      intrinsicValue = tempoValue
      lastTargetValue = Number.NaN
      lastTimeConstant = Number.NaN
      if (tempoValue !== baseValue) constant = false
    },
    setTargetAtTime(next: number, startTime: number, timeConstant: number) {
      tempoValue = clampTempo(next)
      const time = Math.max(0, Number(startTime) || 0)
      const safeTimeConstant =
        Number(timeConstant) > 0 ? Number(timeConstant) : DEFAULT_TIME_CONSTANT
      // 连续两个「同值同时间常数」的 setTargetAtTime 落在同一条指数曲线上，后者可以
      // 安全丢弃：从曲线上的点重新出发会得到同一条曲线。
      if (tempoValue !== lastTargetValue || safeTimeConstant !== lastTimeConstant) {
        targets.push({ time, value: tempoValue, timeConstant: safeTimeConstant })
        lastTargetValue = tempoValue
        lastTimeConstant = safeTimeConstant
      }
      if (tempoValue !== baseValue) constant = false
    }
  }

  const source: TransportPlayableSource = {
    buffer: params.buffer,
    startOffsetKind: 'source',
    resolveLatencySec: () => 0,
    resolvePlaybackPositionSec: () => null,
    playbackRate,
    onended: null,
    connect: () => {},
    disconnect: () => {},
    start: () => {},
    stop: () => {}
  }

  return {
    source,
    readTargets: () => targets,
    get intrinsicValue() {
      return intrinsicValue
    },
    isConstant: () => constant
  }
}
