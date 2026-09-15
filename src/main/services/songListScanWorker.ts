import { Worker } from 'node:worker_threads'
import type { scanSongList } from './scanSongs'
import { resolveMainWorkerPath } from '../workerPath'

type ScanSongListResult = Awaited<ReturnType<typeof scanSongList>>

type WorkerRequest = {
  requestId: number
  mode?: 'scan' | 'verify'
  deferCacheWrite?: boolean
  deferWaveformAvailability?: boolean
  scanPath: string | string[]
  audioExt: string[]
  songListUUID: string
  databaseDir: string
}

type WorkerResponse = {
  type?: 'scan-result' | 'cache-write-complete' | 'waveform-availability-complete'
  requestId?: number
  result?: ScanSongListResult
  error?: string
  cacheWritePending?: boolean
  waveformAvailabilityPending?: boolean
  waveformAvailability?: DeferredWaveformAvailabilityResult
}

export type DeferredWaveformAvailabilityResult = {
  songListUUID: string
  identityDigest: string
  listRoot: string
  missingWaveformFilePaths: string[]
}

type PendingScan = {
  requestId: number
  resolve: (value: ScanSongListResult) => void
  reject: (error: Error) => void
}

type ScanWorkerState = {
  worker: Worker
  pending: PendingScan | null
  cacheWriteRequestId: number | null
  waveformAvailabilityRequestId: number | null
  idleTimer: NodeJS.Timeout | null
  terminating: boolean
}

const MAX_IDLE_WORKERS = 2
const IDLE_WORKER_TTL_MS = 30_000
const idleWorkers: ScanWorkerState[] = []
const workerStates = new Set<ScanWorkerState>()
let nextRequestId = 0
const waveformAvailabilityListeners = new Set<
  (result: DeferredWaveformAvailabilityResult) => void
>()

export const onDeferredWaveformAvailability = (
  listener: (result: DeferredWaveformAvailabilityResult) => void
) => {
  waveformAvailabilityListeners.add(listener)
  return () => waveformAvailabilityListeners.delete(listener)
}

const removeIdleWorker = (state: ScanWorkerState) => {
  const index = idleWorkers.indexOf(state)
  if (index >= 0) idleWorkers.splice(index, 1)
  if (state.idleTimer) {
    clearTimeout(state.idleTimer)
    state.idleTimer = null
  }
}

const retireWorker = (state: ScanWorkerState) => {
  removeIdleWorker(state)
  workerStates.delete(state)
  state.terminating = true
  void state.worker.terminate()
}

const releaseWorker = (state: ScanWorkerState) => {
  if (
    !workerStates.has(state) ||
    state.terminating ||
    state.pending ||
    state.cacheWriteRequestId ||
    state.waveformAvailabilityRequestId
  ) {
    return
  }
  if (idleWorkers.length >= MAX_IDLE_WORKERS) {
    retireWorker(state)
    return
  }
  idleWorkers.push(state)
  state.worker.unref()
  state.idleTimer = setTimeout(() => retireWorker(state), IDLE_WORKER_TTL_MS)
  state.idleTimer.unref()
}

const rejectPending = (state: ScanWorkerState, error: Error) => {
  const pending = state.pending
  state.pending = null
  if (pending) pending.reject(error)
}

const createWorkerState = (): ScanWorkerState => {
  const workerPath = resolveMainWorkerPath(__dirname, 'songListScanWorker.js')
  const state: ScanWorkerState = {
    worker: new Worker(workerPath),
    pending: null,
    cacheWriteRequestId: null,
    waveformAvailabilityRequestId: null,
    idleTimer: null,
    terminating: false
  }
  workerStates.add(state)
  state.worker.on('message', (payload: WorkerResponse) => {
    if (payload?.type === 'cache-write-complete') {
      if (state.cacheWriteRequestId !== payload.requestId) return
      state.cacheWriteRequestId = null
      releaseWorker(state)
      return
    }
    if (payload?.type === 'waveform-availability-complete') {
      if (state.waveformAvailabilityRequestId !== payload.requestId) return
      state.waveformAvailabilityRequestId = null
      const result = payload.waveformAvailability
      if (result) {
        for (const listener of waveformAvailabilityListeners) {
          try {
            listener(result)
          } catch {}
        }
      }
      releaseWorker(state)
      return
    }
    const pending = state.pending
    if (!pending || payload?.requestId !== pending.requestId) return
    state.pending = null
    if (payload.error) pending.reject(new Error(payload.error))
    else if (payload.result) pending.resolve(payload.result)
    else pending.reject(new Error('scanSongList worker returned empty result'))
    if (payload.cacheWritePending) {
      state.cacheWriteRequestId = pending.requestId
    }
    if (payload.waveformAvailabilityPending) {
      state.waveformAvailabilityRequestId = pending.requestId
    }
    releaseWorker(state)
  })
  state.worker.on('error', (error) => {
    workerStates.delete(state)
    removeIdleWorker(state)
    rejectPending(
      state,
      error instanceof Error ? error : new Error(String(error || 'unknown worker error'))
    )
  })
  state.worker.on('exit', (code) => {
    workerStates.delete(state)
    removeIdleWorker(state)
    if (!state.terminating) {
      rejectPending(state, new Error(`scanSongList worker exited: ${String(code ?? '')}`))
    }
  })
  return state
}

const acquireWorker = () => {
  const state = idleWorkers.pop() || createWorkerState()
  state.worker.ref()
  if (state.idleTimer) {
    clearTimeout(state.idleTimer)
    state.idleTimer = null
  }
  return state
}

const runSongListScanWorker = (
  request: Omit<WorkerRequest, 'requestId'>
): Promise<ScanSongListResult> =>
  new Promise((resolve, reject) => {
    const state = acquireWorker()
    nextRequestId += 1
    const requestId = nextRequestId
    state.pending = { requestId, resolve, reject }
    try {
      state.worker.postMessage({ ...request, requestId } satisfies WorkerRequest)
    } catch (error) {
      state.pending = null
      retireWorker(state)
      reject(error instanceof Error ? error : new Error(String(error || 'worker post failed')))
    }
  })

export const scanSongListOffMainThread = (
  request: Omit<WorkerRequest, 'mode' | 'requestId'>
): Promise<ScanSongListResult> => runSongListScanWorker({ ...request, mode: 'scan' })

export const verifyPlaylistCacheOffMainThread = (
  request: Omit<WorkerRequest, 'mode' | 'requestId'>
): Promise<ScanSongListResult> => runSongListScanWorker({ ...request, mode: 'verify' })
