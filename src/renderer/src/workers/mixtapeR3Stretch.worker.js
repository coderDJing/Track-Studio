/**
 * Mixtape 导出用的 R3（Rubber Band 3 / EngineFiner）预拉伸 worker。
 *
 * 导出时把「变速拉伸」这一步从音频线程搬到 Worker 线程池：AudioWorklet 处理器全部
 * 跑在渲染进程唯一的那条音频线程上，开几个 OfflineAudioContext 也不会并行；Worker
 * 才是真正的 OS 线程。
 *
 * 音质不能变，所以这里不是「另一套算法」，而是把 mixtapeTransportR3.worklet.js
 * 原封不动地跑在 Worker 里：同一个 RubberBandInterface、同一个 wasm 二进制、同一组
 * option（ProcessRealTime | ChannelsTogether | EngineFiner）、同一段 plan buffer、
 * 同样的 seek/play/stop 时序、每 128 帧喂同一个 tempo 值。逐样本等价性已在
 * tmp/r3-parity 里用整段 A/B 验证过（maxAbsDiff = 0）。
 *
 * worklet 源码由主线程以字符串形式传进来（见 mixtapeStretchPool.ts），这样两边永远
 * 是同一份代码，不存在两份实现漂移的问题。
 */

const QUANTUM = 128
const PROGRESS_QUANTUM_INTERVAL = 32
const YIELD_QUANTUM_INTERVAL = 256
// buffer 源一旦播放结束，Chrome 会把下游 EQ / 包络链当作静音直接跳过，滤波器尾音就断了；
// 而原来的 AudioWorklet 节点始终连在图上、继续吐零，尾音会自然衰减完。补一段静音让
// buffer 源多活几十毫秒，两侧的计算路径就完全一致（实测尾音 ~450 帧内收敛到 0）。
const SILENT_TAIL_FRAMES = 4096

let RegisteredProcessor = null
let outputSampleRate = 48000
let frameCursor = 0
let wasmBytes = null
let rubberBandOptions = 0
let abortRequested = false
let readyResolve = null
let readyReject = null

const yieldChannel = typeof MessageChannel === 'function' ? new MessageChannel() : null

// 用 MessageChannel 让出任务队列（setTimeout 在 worker 里会被钳到 4ms，代价太大），
// 只有这样主线程的 abort / progress 请求才能被投递进来。
const yieldToTaskQueue = () =>
  new Promise((resolve) => {
    if (!yieldChannel) {
      setTimeout(resolve, 0)
      return
    }
    yieldChannel.port1.onmessage = () => resolve()
    yieldChannel.port2.postMessage(0)
  })

const defineGlobal = (name, descriptor) => {
  try {
    Object.defineProperty(globalThis, name, descriptor)
  } catch {}
}

// worklet 处理器继承 AudioWorkletProcessor，并从全局读 sampleRate / currentTime，
// 这里按 AudioWorkletGlobalScope 的语义补齐。
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = {
      postMessage: (message) => {
        if (!message) return
        if (message.type === 'ready') {
          const resolve = readyResolve
          readyResolve = null
          readyReject = null
          if (resolve) resolve()
          return
        }
        if (message.type === 'error') {
          const reject = readyReject
          readyResolve = null
          readyReject = null
          if (reject) reject(new Error(String(message.error || 'R3 processor initialise failed')))
        }
      },
      onmessage: null
    }
  }
}

const initialiseWorker = (message) => {
  if (RegisteredProcessor) return
  outputSampleRate = Number(message.outputSampleRate) || 48000
  wasmBytes = message.wasmBytes
  rubberBandOptions = Number(message.options) || 0
  defineGlobal('sampleRate', {
    get: () => outputSampleRate,
    configurable: true
  })
  defineGlobal('currentTime', {
    get: () => frameCursor / outputSampleRate,
    configurable: true
  })
  globalThis.registerProcessor = (_name, processor) => {
    RegisteredProcessor = processor
  }
  // 源码来自主线程的 ?raw 导入，与原 worklet 字节一致；这里只在全局作用域里求值。
  ;(0, eval)(String(message.workletSource || ''))
  if (!RegisteredProcessor) {
    throw new Error('R3 processor registration failed')
  }
}

/**
 * setTargetAtTime 段求值：v(t) = target + (v0 - target) * exp(-(t - t0) / tau)
 */
const evaluateSegment = (target, startValue, time) => {
  const elapsed = time - target.time
  if (!(elapsed > 0)) return startValue
  const timeConstant = target.timeConstant > 0 ? target.timeConstant : 0.04
  return target.value + (startValue - target.value) * Math.exp(-elapsed / timeConstant)
}

/**
 * 把「按 1/120 秒上报的目标值序列」还原成逐 128 帧的 tempo 值。
 *
 * 逐段预计算每段起点的值，之后随着时间单调前进线性推进游标，整体 O(目标数 + 帧数)。
 * 返回的采样值再做一次 float32 取整——worklet 拿到的 parameters.tempo 本来就是
 * Float32Array，取整后才和它完全对齐。
 */
const createTempoCurveSampler = (intrinsicValue, targets) => {
  const list = Array.isArray(targets) ? targets : []
  const count = list.length
  if (count === 0) {
    const constant = Math.fround(intrinsicValue)
    return () => constant
  }
  const startValues = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    if (index === 0) {
      startValues[index] = intrinsicValue
      continue
    }
    startValues[index] = evaluateSegment(list[index - 1], startValues[index - 1], list[index].time)
  }
  let cursor = 0
  let lastTime = Number.NEGATIVE_INFINITY
  return (time) => {
    if (time < lastTime) cursor = 0
    lastTime = time
    while (cursor + 1 < count && list[cursor + 1].time <= time) cursor += 1
    if (list[cursor].time > time) return Math.fround(intrinsicValue)
    return Math.fround(evaluateSegment(list[cursor], startValues[cursor], time))
  }
}

const runStretchTask = async (id, payload) => {
  const channels = Array.isArray(payload.channels) ? payload.channels : []
  const channelCount = Math.max(1, channels.length)
  const sampleRate = outputSampleRate
  const renderFrames = Math.max(0, Number(payload.frameCount) || 0)
  const stopFrame = Math.ceil(Number(payload.stopTimeSec) * sampleRate)
  // worklet 是在每个 128 帧块内部用 ceil((startTimeSec - currentTime) * sampleRate) /
  // ceil((stopTimeSec - currentTime) * sampleRate) 做 start/stop 门控的。这个浮点结果
  // 和全局的 ceil(startTimeSec * sampleRate) 可能差 1 ULP —— 实测 96.02s 会得到
  // 64.00000000007822，ceil 成 65，于是 worklet 在结束块多吐一帧。
  // 所以这里不自己裁边界，而是把整块 process() 的输出原样搬过来，起止都对齐到量子边界，
  // 多出来的前后零点落在正确的绝对帧上，混音结果自然一致。
  const startFrame = Math.max(
    0,
    Math.floor((Number(payload.startTimeSec) * sampleRate) / QUANTUM) * QUANTUM
  )
  const hardEndFrame = Math.max(startFrame + QUANTUM, Math.min(renderFrames, stopFrame))
  const endFrame = Math.ceil(hardEndFrame / QUANTUM) * QUANTUM
  // 尾部静音不参与拉伸，只是让 buffer 源在 EQ 链上多保持一小段活跃状态。
  const frames = Math.max(0, endFrame - startFrame + SILENT_TAIL_FRAMES)

  const outputs = []
  for (let channel = 0; channel < channelCount; channel += 1) {
    outputs.push(new Float32Array(frames))
  }
  if (frames <= 0) {
    return { channels: outputs, startFrame, frames: 0 }
  }

  // 直接从 startFrame 起跑，不空转前面那段。
  //
  // worklet 的 process() 开头就是 `quantumEndSec <= startTimeSec` 就 fill(0) 返回，
  // 根本不碰 RB —— 所以 startFrame 之前的每一个块对处理器状态都没有任何副作用。
  // 而当前实现是按「停止时刻」决定循环终点的，那么一条 00:00 之后才进场的轨道也要从
  // 第 0 帧开始走：71 分钟 / 20 轨的工程里 Σ stopTime 约 4.5 万秒，去掉的正是这段空转
  // （实测每一秒空转约 1.2ms，累计在一个 worker 上就是好几秒）。
  //
  // 起跑点改成 startFrame 后，currentTime 仍然是绝对时间，所以 play 里的
  // `Math.max(currentTime, startTimeSec)`、stop 里的 `stopTimeSec > currentTime` 判定
  // 结果都不变；preroll() 只做 pump(BUFFER_TARGET)，不读 currentTime。
  frameCursor = startFrame
  const processor = new RegisteredProcessor()
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  processor.port.onmessage({
    data: {
      type: 'initialise',
      channels: channelCount,
      options: rubberBandOptions,
      wasm: wasmBytes
    }
  })
  await Promise.race([
    readyPromise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('R3 processor initialise timed out')), 15000)
    })
  ])

  try {
    // 下面这段消息序列必须与 timelineTransportR3Source.ts 里 start()/stop() 发出的
    // 完全一致，顺序也不能变：buffer → pitch → speed → seek → play → stop。
    processor.port.onmessage({
      data: { type: 'buffer', channels, sampleRate: payload.sourceSampleRate }
    })
    processor.port.onmessage({ data: { type: 'pitch', value: 1 } })
    processor.port.onmessage({ data: { type: 'speed', value: payload.initialTempo } })
    processor.port.onmessage({ data: { type: 'seek', seconds: payload.offsetSec } })
    processor.port.onmessage({
      data: { type: 'play', startTimeSec: Math.max(0, Number(payload.startTimeSec) || 0) }
    })
    processor.port.onmessage({
      data: { type: 'stop', stopTimeSec: Math.max(0, Number(payload.stopTimeSec) || 0) }
    })

    const sampler = createTempoCurveSampler(payload.intrinsicValue, payload.targets)
    // 主线程会用记录器把浏览器真实的逐块 tempo 曲线采样回来；拿不到时才退回解析求值。
    const curve =
      payload.curve instanceof Float32Array && payload.curve.length > 0 ? payload.curve : null
    // 但解析求值只对「恒定 tempo」是精确的：带自动化的曲线差 1 ULP 就会让 RB 相位永久
    // 分叉。这类任务必须直接失败，让调用方回落到原 AudioWorklet 路径，不许硬顶。
    const targets = Array.isArray(payload.targets) ? payload.targets : []
    const needsSampledCurve = targets.some(
      (target) => Math.fround(target.value) !== Math.fround(payload.intrinsicValue)
    )
    if (!curve && needsSampledCurve) {
      throw new Error('mixtape.tempoCurveMissing')
    }
    const scratch = []
    for (let channel = 0; channel < channelCount; channel += 1) {
      scratch.push(new Float32Array(QUANTUM))
    }
    const tempoParam = new Float32Array(1)

    // startFrame 已经对齐到 128 帧边界，所以曲线下标可以直接从对应量子开始。
    let quantumIndex = startFrame / QUANTUM
    while (frameCursor < endFrame) {
      tempoParam[0] = curve
        ? (curve[quantumIndex] ?? Math.fround(payload.intrinsicValue))
        : sampler(frameCursor / sampleRate)
      processor.process([], [scratch], { tempo: tempoParam })

      // 整块原样搬运：块内的 start/stop 门控（以及那多出来的一帧）由 worklet 自己决定，
      // 这里再裁一次边界就会把 1 ULP 的差别放大成可听的边界爆音。
      if (frameCursor >= startFrame && frameCursor + QUANTUM <= endFrame) {
        const destinationOffset = frameCursor - startFrame
        for (let channel = 0; channel < channelCount; channel += 1) {
          outputs[channel].set(scratch[channel], destinationOffset)
        }
      }

      frameCursor += QUANTUM
      quantumIndex += 1

      if (quantumIndex % PROGRESS_QUANTUM_INTERVAL === 0) {
        self.postMessage({
          type: 'task-progress',
          id,
          ratio: Math.min(1, frameCursor / Math.max(1, endFrame))
        })
      }
      if (quantumIndex % YIELD_QUANTUM_INTERVAL === 0) {
        await yieldToTaskQueue()
        if (abortRequested) throw new Error('mixtape.outputCancelled')
      }
    }

    return { channels: outputs, startFrame, frames }
  } finally {
    try {
      processor.port.onmessage({ data: { type: 'close' } })
    } catch {}
  }
}

self.onmessage = (event) => {
  const message = event.data
  if (!message) return
  if (message.type === 'init') {
    try {
      initialiseWorker(message)
      self.postMessage({ type: 'ready' })
    } catch (error) {
      self.postMessage({
        type: 'init-error',
        message: String((error && error.message) || error)
      })
    }
    return
  }
  if (message.type === 'abort') {
    abortRequested = true
    return
  }
  if (message.type !== 'stretch') return
  abortRequested = false
  runStretchTask(message.id, message.payload).then(
    (result) => {
      const transfers = result.channels.map((channel) => channel.buffer)
      self.postMessage(
        {
          type: 'stretched',
          id: message.id,
          channels: result.channels,
          startFrame: result.startFrame,
          frames: result.frames
        },
        transfers
      )
    },
    (error) => {
      self.postMessage({
        type: 'task-error',
        id: message.id,
        message: String((error && error.message) || error)
      })
    }
  )
}
