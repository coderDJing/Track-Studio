import r3WorkletSource from '../../workers/mixtapeTransportR3.worklet.js?raw'
import { R3_MW_OPTIONS, loadR3WasmBinary } from './timelineTransportR3Source'

/**
 * Mixtape 导出的并行预拉伸任务池。
 *
 * R3（Rubber Band 3 / EngineFiner）的变速拉伸本来跑在 AudioWorklet 里，而一个渲染
 * 进程里所有 AudioWorklet 处理器共用同一条音频线程——多开 OfflineAudioContext 一点
 * 都不会变快（实测 1 个 ctx 3778ms / 4 个并行 4385ms）。这里改成 Worker 池：每个
 * worker 内部跑的是同一份 worklet 处理器源码、同一份 wasm、同一组 option，所以算法与
 * 音质与原来的导出完全一致，只是把工作摊到多个 CPU 核上。
 */

export type MixtapeStretchTempoTarget = {
  time: number
  value: number
  timeConstant: number
}

export type MixtapeStretchTask = {
  /** 调用方用来把结果对回具体轨道（trackId 或 trackId::stemId）。 */
  key: string
  /** plan buffer 的通道数据，postMessage 时转移所有权，建任务时传入副本。 */
  channels: Float32Array[]
  sourceSampleRate: number
  startTimeSec: number
  stopTimeSec: number
  offsetSec: number
  /** R3 源在 start() 时的 speed（= 轨道 tempoRatio，已 clamp）。 */
  initialTempo: number
  /** tempo 参数在被自动化之前的固有值，通常等于 initialTempo。 */
  intrinsicValue: number
  /** 按时间升序的 setTargetAtTime 目标值序列，已去掉连续重复项。 */
  targets: MixtapeStretchTempoTarget[]
  /** 浏览器真实逐块（128 帧）tempo 值；缺省时 worker 用 targets 解析求值兜底。 */
  curve?: Float32Array
  frameCount: number
  /** 进度加权用的相对开销，取输出帧数。 */
  weight: number
}

export type MixtapeStretchOutcome = {
  key: string
  channels: Float32Array[]
  startFrame: number
  frames: number
}

export type MixtapeStretchRunResult = {
  outcomes: Map<string, MixtapeStretchOutcome>
  /** 拉伸失败的 key，调用方需要对它们回落到原来的 AudioWorklet 路径。 */
  failedKeys: string[]
}

type StretchWorkerHandle = {
  worker: Worker
  currentKey: string
  currentWeight: number
  currentRatio: number
  busy: boolean
}

type PendingTask = {
  key: string
  weight: number
  handle: StretchWorkerHandle
  timer: ReturnType<typeof setTimeout>
  resolve: (outcome: MixtapeStretchOutcome) => void
  reject: (error: Error) => void
}

const WORKER_INIT_TIMEOUT_MS = 20000
const TASK_TIMEOUT_MS = 15 * 60 * 1000
const ABORT_POLL_INTERVAL_MS = 200

export const resolveStretchWorkerCount = (taskCount: number) => {
  const logicalCpuCount =
    typeof navigator !== 'undefined' ? Math.max(1, Number(navigator.hardwareConcurrency) || 4) : 4
  // 实测（14 物理核、1200 秒 / 16 轨，R3 EngineFiner）：6 个 24.8s、8 个 19.1s、
  // 9 个 19.6s、10 个 18.4s、13 个 19.9s。聚合吞吐在 8~10 之间封顶，再多就是超订
  // 反而变慢（每个 worker 都要自己一份 wasm 实例和环形缓冲，抢内存带宽）。
  // 所以按「核数 - 3」给到 10 个封顶，既留出主线程/音频线程的余量，也不超订。
  const capacity = Math.min(10, Math.max(2, logicalCpuCount - 3))
  return Math.max(1, Math.min(capacity, taskCount))
}

export const runMixtapeStretchTasks = async (params: {
  tasks: MixtapeStretchTask[]
  outputSampleRate: number
  onProgress?: (payload: { doneRatio: number }) => void
  shouldAbort?: () => boolean
}): Promise<MixtapeStretchRunResult> => {
  const { tasks, outputSampleRate, onProgress, shouldAbort } = params
  const outcomes = new Map<string, MixtapeStretchOutcome>()
  const failedKeys: string[] = []
  if (!tasks.length) return { outcomes, failedKeys }

  const wasmBinary = await loadR3WasmBinary()
  const workerCount = resolveStretchWorkerCount(tasks.length)
  const handles: StretchWorkerHandle[] = []

  const disposeHandles = () => {
    for (const handle of handles) {
      try {
        handle.worker.terminate()
      } catch {}
    }
  }

  const totalWeight = tasks.reduce((sum, task) => sum + Math.max(1, task.weight), 0)
  let completedWeight = 0

  const emitProgress = () => {
    if (!onProgress) return
    let activeWeight = 0
    for (const handle of handles) {
      if (!handle.busy) continue
      activeWeight += handle.currentRatio * handle.currentWeight
    }
    onProgress({ doneRatio: Math.min(1, (completedWeight + activeWeight) / totalWeight) })
  }

  const createHandle = async (): Promise<StretchWorkerHandle> => {
    const worker = new Worker(
      new URL('../../workers/mixtapeR3Stretch.worker.js', import.meta.url),
      {
        type: 'module'
      }
    )
    const handle: StretchWorkerHandle = {
      worker,
      currentKey: '',
      currentWeight: 1,
      currentRatio: 0,
      busy: false
    }
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('mixtape.stretchWorkerInitTimeout'))
      }, WORKER_INIT_TIMEOUT_MS)
      const onMessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
        const data = event.data
        if (!data) return
        if (data.type === 'ready') {
          clearTimeout(timeout)
          worker.removeEventListener('message', onMessage)
          resolve()
          return
        }
        if (data.type === 'init-error') {
          clearTimeout(timeout)
          worker.removeEventListener('message', onMessage)
          reject(new Error(data.message || 'mixtape.stretchWorkerInitFailed'))
        }
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', (event) => {
        clearTimeout(timeout)
        reject(new Error(event.message || 'mixtape.stretchWorkerInitFailed'))
      })
    })
    const wasmCopy = new Uint8Array(wasmBinary.length)
    wasmCopy.set(wasmBinary)
    worker.postMessage(
      {
        type: 'init',
        workletSource: r3WorkletSource,
        wasmBytes: wasmCopy.buffer,
        outputSampleRate,
        options: R3_MW_OPTIONS
      },
      [wasmCopy.buffer]
    )
    await ready
    return handle
  }

  try {
    for (let index = 0; index < workerCount; index += 1) {
      handles.push(await createHandle())
    }
  } catch (error) {
    disposeHandles()
    throw error
  }

  const queue = [...tasks].sort((a, b) => Math.max(1, b.weight) - Math.max(1, a.weight))
  const pending = new Map<string, PendingTask>()
  let requestSeq = 0
  let aborted = false

  const handleWorkerMessage = (
    handle: StretchWorkerHandle,
    event: MessageEvent<{
      type?: string
      id?: string
      channels?: Float32Array[]
      startFrame?: number
      frames?: number
      ratio?: number
      message?: string
    }>
  ) => {
    const data = event.data
    if (!data || !data.id) return
    const entry = pending.get(data.id)
    if (!entry) return
    if (data.type === 'task-progress') {
      handle.currentRatio = Math.max(0, Math.min(1, Number(data.ratio) || 0))
      emitProgress()
      return
    }
    pending.delete(data.id)
    clearTimeout(entry.timer)
    if (data.type === 'stretched') {
      entry.resolve({
        key: entry.key,
        channels: data.channels || [],
        startFrame: Number(data.startFrame) || 0,
        frames: Number(data.frames) || 0
      })
      return
    }
    entry.reject(new Error(data.message || 'mixtape.stretchFailed'))
  }

  for (const handle of handles) {
    handle.worker.addEventListener('message', (event) => handleWorkerMessage(handle, event))
  }

  const abortPoll =
    typeof window !== 'undefined' && shouldAbort
      ? window.setInterval(() => {
          if (aborted) return
          if (!shouldAbort()) return
          aborted = true
          for (const entry of pending.values()) {
            clearTimeout(entry.timer)
            entry.reject(new Error('mixtape.outputCancelled'))
          }
          pending.clear()
          disposeHandles()
        }, ABORT_POLL_INTERVAL_MS)
      : null

  const runWorkerLoop = async (handle: StretchWorkerHandle) => {
    while (!aborted) {
      const task = queue.shift()
      if (!task) return
      requestSeq += 1
      const id = `stretch_${requestSeq}`
      handle.busy = true
      handle.currentKey = task.key
      handle.currentWeight = Math.max(1, task.weight)
      handle.currentRatio = 0
      try {
        const outcome = await new Promise<MixtapeStretchOutcome>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('mixtape.stretchTimeout'))
          }, TASK_TIMEOUT_MS)
          pending.set(id, {
            key: task.key,
            weight: handle.currentWeight,
            handle,
            timer,
            resolve,
            reject
          })
          try {
            // 不能把通道数据放进 transfer list：plan buffer 常常就是解码缓存里那个
            // AudioBuffer 本身，转移所有权会 detach 掉它的底层 ArrayBuffer。
            handle.worker.postMessage({
              type: 'stretch',
              id,
              payload: {
                channels: task.channels,
                sourceSampleRate: task.sourceSampleRate,
                startTimeSec: task.startTimeSec,
                stopTimeSec: task.stopTimeSec,
                offsetSec: task.offsetSec,
                initialTempo: task.initialTempo,
                intrinsicValue: task.intrinsicValue,
                targets: task.targets,
                curve: task.curve,
                frameCount: task.frameCount
              }
            })
          } catch (error) {
            clearTimeout(timer)
            pending.delete(id)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
        outcomes.set(task.key, outcome)
      } catch (error) {
        if (aborted) return
        console.error('[mixtape-output] stretch task failed', task.key, error)
        failedKeys.push(task.key)
      } finally {
        handle.busy = false
        handle.currentKey = ''
        handle.currentRatio = 0
        completedWeight += handle.currentWeight
        emitProgress()
      }
    }
  }

  try {
    await Promise.all(handles.map((handle) => runWorkerLoop(handle)))
  } finally {
    if (abortPoll !== null) window.clearInterval(abortPoll)
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
    disposeHandles()
  }

  if (aborted) throw new Error('mixtape.outputCancelled')
  return { outcomes, failedKeys }
}
