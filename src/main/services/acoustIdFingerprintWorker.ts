import { Worker } from 'node:worker_threads'
import { resolveMainWorkerPath } from '../workerPath'
import { log } from '../log'

export type FingerprintResult = { fingerprint: string; duration: number; error?: string }
type PendingRequest = {
  resolve: (result: FingerprintResult) => void
  reject: (error: Error) => void
}
type WorkerState = {
  worker: Worker
  pending: Map<number, PendingRequest>
  idleTimer: NodeJS.Timeout | null
}

let state: WorkerState | null = null
let sequence = 0

const retire = (current: WorkerState, error?: Error) => {
  if (state === current) state = null
  if (current.idleTimer) clearTimeout(current.idleTimer)
  current.idleTimer = null
  for (const request of current.pending.values())
    request.reject(error || new Error('ACOUSTID_ABORTED'))
  current.pending.clear()
  void current.worker.terminate()
}

const release = (current: WorkerState) => {
  if (state !== current || current.pending.size > 0) return
  current.worker.unref()
  current.idleTimer = setTimeout(() => retire(current), 30_000)
  current.idleTimer.unref()
}

const acquire = () => {
  if (!state) {
    const current: WorkerState = {
      worker: new Worker(resolveMainWorkerPath(__dirname, 'acoustIdFingerprintWorker.js')),
      pending: new Map(),
      idleTimer: null
    }
    state = current
    current.worker.on(
      'message',
      (response: { requestId: number; result?: FingerprintResult; error?: string }) => {
        const request = current.pending.get(response.requestId)
        if (!request) return
        current.pending.delete(response.requestId)
        if (response.error) request.reject(new Error(response.error))
        else if (response.result) request.resolve(response.result)
        else request.reject(new Error('ACOUSTID_WORKER_EMPTY_RESULT'))
        release(current)
      }
    )
    const fail = (error: Error) => {
      if (state !== current) return
      log.error('[acoustid-audio] fingerprint worker failed', error)
      retire(current, error)
    }
    current.worker.on('error', (error) =>
      fail(error instanceof Error ? error : new Error(String(error)))
    )
    current.worker.on('exit', (code) => {
      fail(new Error(`ACOUSTID_WORKER_EXIT:${code}`))
    })
  }
  const current = state
  if (current.idleTimer) clearTimeout(current.idleTimer)
  current.idleTimer = null
  current.worker.ref()
  return current
}

/** 同一 worker 串行执行原生解码；主进程只接收小型指纹字符串。 */
export const generateFingerprintOffMainThread = (
  filePath: string,
  maxLengthSeconds: number
): Promise<FingerprintResult> =>
  new Promise((resolve, reject) => {
    const current = acquire()
    const requestId = ++sequence
    current.pending.set(requestId, { resolve, reject })
    try {
      current.worker.postMessage({ requestId, filePath, maxLengthSeconds })
    } catch (error) {
      current.pending.delete(requestId)
      reject(error instanceof Error ? error : new Error(String(error)))
      release(current)
    }
  })

export const cancelFingerprintRequests = () => {
  if (state) retire(state, new Error('ACOUSTID_ABORTED'))
}
