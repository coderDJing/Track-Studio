import {
  createTransportBufferSource,
  type TransportPlayableAudioContext,
  type TransportPlayableSource
} from '@renderer/composables/mixtape/timelineTransportPlayableSource'
import { createTransportR3Source } from '@renderer/composables/mixtape/timelineTransportR3Source'
import {
  isTrivialTempoCurve,
  renderMixtapeTempoCurves
} from '@renderer/composables/mixtape/mixtapeTempoCurve'
import {
  runMixtapeStretchTasks,
  type MixtapeStretchTask
} from '@renderer/composables/mixtape/mixtapeStretchPool'
import type { MixtapeTempoProbe } from '@renderer/composables/mixtape/mixtapeTempoProbe'
import type { TrackGraphNode } from '@renderer/composables/mixtape/timelineTransportPlaybackNodes'
import type {
  MixtapeOutputProgressPayload,
  RenderTransportEntry
} from '@renderer/composables/mixtape/timelineTransportRenderWav'

/**
 * 一条被延后到 Worker 池里做变速拉伸的音源。
 *
 * 导出时 master-tempo 轨道不再用 AudioWorklet 实时拉伸，而是先记下调度阶段算出来的
 * tempo 目标值，等 Worker 池把整段拉伸结果算出来之后，再用普通 buffer 源（rate = 1）
 * 接回原来的 EQ / 包络链路。
 */
export type DeferredOutputSource = {
  key: string
  entry: RenderTransportEntry
  planBuffer: AudioBuffer
  startTimeSec: number
  stopTimeSec: number
  offsetSec: number
  initialTempo: number
  probe: MixtapeTempoProbe
  /** 拉伸完成后真实源要接入的位置（EQ 链入口或 stem 增益）。 */
  destination: AudioNode
  /** 把真实源回填到图里，替换掉调度阶段用的记录桩。 */
  attach: (source: TransportPlayableSource) => void
}

const throwIfAborted = (shouldAbort?: () => boolean) => {
  if (shouldAbort?.()) throw new Error('mixtape.outputCancelled')
}

/**
 * 第二阶段：把 master-tempo 轨道的整段变速拉伸丢进 Worker 池并行跑，再按 rate = 1
 * 的普通 buffer 源接回 EQ / 包络链路。任何一条失败都回落到原来的 AudioWorklet 路径
 * （同一份 wasm、同一组参数、同一串 tempo 事件），保证不会因为并发出问题而降级音质。
 */
export const renderMixtapeDeferredSources = async (params: {
  offlineCtx: OfflineAudioContext
  playableCtx: TransportPlayableAudioContext
  frameCount: number
  outputSampleRate: number
  nodes: TrackGraphNode[]
  deferred: DeferredOutputSource[]
  emitProgress: (payload: MixtapeOutputProgressPayload) => void
  shouldAbort?: () => boolean
  clampNumber: (value: number, min: number, max: number) => number
  /** 曲线采样 / 拉伸两段在总进度条上占的区间，由调用方统一编排。 */
  progressBand: { start: number; curveEnd: number; end: number }
}) => {
  const {
    offlineCtx,
    playableCtx,
    frameCount,
    outputSampleRate,
    nodes,
    deferred,
    emitProgress,
    shouldAbort,
    clampNumber,
    progressBand
  } = params
  if (!deferred.length) return

  emitProgress({
    stageKey: 'mixtape.outputProgressStretching',
    done: 0,
    total: Math.max(1, deferred.length),
    percent: progressBand.start
  })

  // 先用记录器把浏览器真实的逐块 tempo 曲线采样回来——这一步决定了拉伸结果能否与
  // 原来的 AudioWorklet 路径逐样本一致。
  //
  // 只采「真的带 tempo 自动化」的轨道：曲线恒等于固有值时，R3 处理器读到的
  // parameters.tempo[0] 就是 Math.fround(固有值)，Worker 侧用同一句表达式能拿到完全
  // 相同的 float32，不需要采样也不可能偏。
  const curveRequests = deferred
    .map((item) => ({
      key: item.key,
      intrinsicValue: item.probe.intrinsicValue,
      targets: item.probe.readTargets()
    }))
    .filter((request) => !isTrivialTempoCurve(request))
  const curveNeeded = new Set(curveRequests.map((request) => request.key))

  let curves = new Map<string, Float32Array>()
  if (curveRequests.length > 0) {
    try {
      curves = await renderMixtapeTempoCurves({
        requests: curveRequests,
        sampleRate: outputSampleRate,
        frameCount,
        onProgress: (ratio) => {
          emitProgress({
            stageKey: 'mixtape.outputProgressStretching',
            done: 0,
            total: Math.max(1, deferred.length),
            percent: Math.round(
              progressBand.start +
                clampNumber(ratio, 0, 1) * (progressBand.curveEnd - progressBand.start)
            )
          })
        },
        shouldAbort
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'mixtape.outputCancelled') throw error
      // 采样失败不让并发路径硬顶：拿解析求值凑出来的曲线会让 RB 相位分叉，属于降音质。
      // 宁可这一整段退回原来的 AudioWorklet 路径。
      console.warn(
        '[mixtape-output] tempo curve sampling failed, falling back to the AudioWorklet path',
        error
      )
      curves = new Map()
    }
  }

  throwIfAborted(shouldAbort)

  const tasks: MixtapeStretchTask[] = []
  const unsafeKeys: string[] = []
  for (const item of deferred) {
    const curve = curves.get(item.key)
    if (curveNeeded.has(item.key) && !curve) {
      // 曲线没采到 → 这条轨道不进并发池，稍后按原路径拉伸。
      unsafeKeys.push(item.key)
      continue
    }
    // 与 createTransportR3Source 一致：最多取前两个通道。
    const channelCount = Math.max(1, Math.min(2, item.planBuffer.numberOfChannels || 1))
    const channels: Float32Array[] = []
    for (let channel = 0; channel < channelCount; channel += 1) {
      channels.push(item.planBuffer.getChannelData(channel))
    }
    tasks.push({
      key: item.key,
      channels,
      sourceSampleRate: item.planBuffer.sampleRate,
      startTimeSec: item.startTimeSec,
      stopTimeSec: item.stopTimeSec,
      offsetSec: item.offsetSec,
      initialTempo: item.initialTempo,
      intrinsicValue: item.probe.intrinsicValue,
      targets: item.probe.readTargets(),
      curve,
      frameCount,
      // worklet 在 startTimeSec 之前只 fill(0) 就返回，RB 真正干活的只有播放窗口
      // 那一段，worker 现在也从 startFrame 起跑，所以开销就是轨道时长本身。
      weight: Math.max(1, Math.round((item.stopTimeSec - item.startTimeSec) * 1000))
    })
  }
  if (unsafeKeys.length > 0) {
    console.warn(
      `[mixtape-output] ${unsafeKeys.length}/${deferred.length} tracks have no tempo curve, using the AudioWorklet path`
    )
  }

  let outcomes: Map<string, { channels: Float32Array[]; startFrame: number; frames: number }> =
    new Map()
  try {
    const result = await runMixtapeStretchTasks({
      tasks,
      outputSampleRate,
      onProgress: ({ doneRatio }) => {
        emitProgress({
          stageKey: 'mixtape.outputProgressStretching',
          done: Math.round(doneRatio * Math.max(1, deferred.length)),
          total: Math.max(1, deferred.length),
          percent: Math.round(
            progressBand.curveEnd +
              clampNumber(doneRatio, 0, 1) * (progressBand.end - progressBand.curveEnd)
          )
        })
      },
      shouldAbort
    })
    outcomes = result.outcomes
    if (result.failedKeys.length > 0) {
      console.warn(
        `[mixtape-output] ${result.failedKeys.length}/${deferred.length} stretch tasks failed, falling back`
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'mixtape.outputCancelled') throw error
    console.error('[mixtape-output] parallel stretch unavailable, falling back', error)
  }

  throwIfAborted(shouldAbort)

  let staged = 0
  for (const item of deferred) {
    const outcome = outcomes.get(item.key)
    if (outcome && outcome.frames > 0 && outcome.channels.length > 0) {
      const channelCount = Math.max(1, Math.min(2, outcome.channels.length))
      const audioBuffer = offlineCtx.createBuffer(channelCount, outcome.frames, outputSampleRate)
      for (let channel = 0; channel < channelCount; channel += 1) {
        const sourceChannel = outcome.channels[Math.min(outcome.channels.length - 1, channel)]
        if (sourceChannel) {
          audioBuffer.getChannelData(channel).set(sourceChannel.subarray(0, outcome.frames))
        }
      }
      const source = createTransportBufferSource(playableCtx, audioBuffer)
      source.connect(item.destination)
      // 拉伸结果的第一帧就对应 startFrame，所以按帧对齐落位，剩下的静音区间与原来一致。
      await source.start(outcome.startFrame / outputSampleRate)
      item.attach(source)
      staged += 1
      continue
    }

    // 回落：完全走原来的 AudioWorklet 拉伸，并把记录下来的 tempo 事件按原顺序重放。
    const source = await createTransportR3Source(playableCtx, item.planBuffer)
    source.playbackRate.value = item.initialTempo
    source.connect(item.destination)
    await source.start(item.startTimeSec, item.offsetSec)
    source.stop(item.stopTimeSec)
    for (const target of item.probe.readTargets()) {
      source.playbackRate.setTargetAtTime(target.value, target.time, target.timeConstant)
    }
    item.attach(source)
  }

  // stem 轨道的图节点 source 只是主 stem 的镜像，全部接完后同步一次。
  for (const node of nodes) {
    if (node.stemNodes.length > 0 && node.stemNodes[0].source) {
      node.source = node.stemNodes[0].source
    }
  }

  if (staged < deferred.length) {
    console.warn(
      `[mixtape-output] ${deferred.length - staged}/${deferred.length} sources fell back to the AudioWorklet stretcher`
    )
  }

  emitProgress({
    stageKey: 'mixtape.outputProgressStretching',
    done: Math.max(1, deferred.length),
    total: Math.max(1, deferred.length),
    percent: progressBand.end
  })
}
