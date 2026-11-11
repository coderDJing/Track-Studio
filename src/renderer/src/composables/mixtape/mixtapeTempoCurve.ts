import type { MixtapeTempoTarget } from './mixtapeTempoProbe'

/**
 * 把「按 1/120 秒上报的 setTargetAtTime 目标值序列」还原成浏览器真实的逐块 tempo 曲线。
 *
 * 不做解析求值：那只能逼近到 ±1 ULP，而 Rubber Band 的相位声码器会把这个差别永久
 * 放大成整段相位分叉（实测 SNR 只有 11~23 dB）。这里直接在离线上下文里挂记录器采样
 * AudioParam，拿到的就是 worklet 实际看到的 values（同一个 float32 网格）。
 *
 * 必须是「同一个上下文、事件时间原样不动」：把事件整体平移（哪怕平移整数秒）会让
 * 参数求值产生微小差异，实测会让 ramp 类曲线在 1e-4 量级上偏掉，进而把 RB 的相位
 * 推岔。所以这里一次渲染整条时间线，不做分块重定基准。
 *
 * 内存上只有 1 声道 × 帧数 × 4 字节的输出缓冲，而且采样完立刻释放，不会和后面的
 * 拉伸缓冲叠加。
 */

const QUANTUM = 128

const TEMPO_CURVE_WORKLET_URL = new URL(
  '../../workers/mixtapeTempoCurve.worklet.js',
  import.meta.url
).href

export type MixtapeTempoCurveRequest = {
  key: string
  intrinsicValue: number
  targets: MixtapeTempoTarget[]
}

/** 目标值序列恒等于固有值时曲线就是常量，不需要采样。 */
export const isTrivialTempoCurve = (request: MixtapeTempoCurveRequest) => {
  if (request.targets.length === 0) return true
  if (request.targets.length > 1) return false
  return Math.fround(request.targets[0].value) === Math.fround(request.intrinsicValue)
}

export const renderMixtapeTempoCurves = async (params: {
  requests: MixtapeTempoCurveRequest[]
  sampleRate: number
  frameCount: number
  onProgress?: (doneRatio: number) => void
  shouldAbort?: () => boolean
}): Promise<Map<string, Float32Array>> => {
  const { requests, sampleRate, frameCount, onProgress, shouldAbort } = params
  const curves = new Map<string, Float32Array>()
  if (!requests.length) return curves

  const totalQuanta = Math.max(1, Math.ceil(frameCount / QUANTUM))
  const offlineCtx = new OfflineAudioContext(1, frameCount, sampleRate)
  await offlineCtx.audioWorklet.addModule(TEMPO_CURVE_WORKLET_URL)

  const pending: { key: string; values: Float32Array[]; promise: Promise<void> }[] = []
  const reportProgress = () => {
    if (!onProgress) return
    let received = 0
    for (const item of pending) {
      for (const chunk of item.values) received += chunk.length
    }
    // 记录器是批量回传的，这里只能给个近似进度；渲染结束后统一收到 1。
    onProgress(Math.min(0.99, received / (totalQuanta * Math.max(1, pending.length))))
  }
  for (const request of requests) {
    const node = new AudioWorkletNode(offlineCtx, 'mixtape-tempo-curve-recorder', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { totalQuanta, skipQuanta: 0 }
    })
    const tempoParam = node.parameters.get('tempo')
    if (!tempoParam) continue
    tempoParam.value = request.intrinsicValue
    for (const target of request.targets) {
      tempoParam.setTargetAtTime(target.value, target.time, target.timeConstant)
    }
    node.connect(offlineCtx.destination)

    const values: Float32Array[] = []
    let resolveDone: (() => void) | null = null
    const promise = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    node.port.onmessage = (event: MessageEvent<{ type?: string; values?: Float32Array }>) => {
      const data = event.data
      if (!data) return
      if (data.type === 'curve' && data.values) {
        values.push(data.values)
        reportProgress()
        return
      }
      if (data.type === 'curve-done') {
        node.port.onmessage = null
        resolveDone?.()
      }
    }
    pending.push({ key: request.key, values, promise })
  }

  if (shouldAbort?.()) throw new Error('mixtape.outputCancelled')
  await offlineCtx.startRendering()
  // 渲染结束时最后一批 curve 消息可能还在投递队列里，等记录器自己报告结束。
  await Promise.race([
    Promise.all(pending.map((item) => item.promise)),
    new Promise<void>((resolve) => setTimeout(resolve, 3000))
  ])
  onProgress?.(1)

  for (const item of pending) {
    const total = item.values.reduce((sum, chunk) => sum + chunk.length, 0)
    if (total < totalQuanta) {
      // 数据没拿全就让调用方退回解析求值，别拿半截曲线去拉伸。
      console.warn(
        `[mixtape-output] tempo curve incomplete for ${item.key}: ${total}/${totalQuanta}`
      )
      continue
    }
    const curve = new Float32Array(totalQuanta)
    let offset = 0
    for (const chunk of item.values) {
      const copyLength = Math.min(chunk.length, curve.length - offset)
      if (copyLength <= 0) break
      curve.set(chunk.subarray(0, copyLength), offset)
      offset += copyLength
    }
    curves.set(item.key, curve)
  }

  return curves
}
