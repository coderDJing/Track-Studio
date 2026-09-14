import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { log } from '../log'
import store from '../store'
import { resolveMainWorkerPath } from '../workerPath'
import type { TrackCacheTransferContext, TrackCacheTransferParams } from './trackCacheTransfer'
import { runPlaybackAwareBackgroundFileIo } from './playbackForegroundActivity'

type QueueEntry = {
  id: number
  params: TrackCacheTransferParams
  context: TrackCacheTransferContext
  completion: Promise<void>
  resolve: () => void
}

type WorkerResponse = {
  id?: unknown
  results?: Array<{ id: number; success: boolean; error?: string }>
  error?: unknown
}

// One track per slot keeps visible cover/waveform work from waiting behind an entire delete batch.
const TRANSFER_BATCH_SIZE = 1
// Let a foreground delete batch finish its small core-cache writes before the worker opens the DB.
const QUEUE_SETTLE_DELAY_MS = 750
const WORKER_REQUEST_TIMEOUT_MS = 180_000

const queue: QueueEntry[] = []
const pendingByPath = new Map<string, Set<QueueEntry>>()
let sequence = 0
let pumpTimer: ReturnType<typeof setTimeout> | null = null
let pumpRunning = false
let stopping = false
let activeWorker: Worker | null = null

const normalizePathKey = (value: string): string => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const normalized = path.resolve(raw)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const getEntryPathKeys = (entry: QueueEntry): string[] =>
  Array.from(
    new Set(
      [normalizePathKey(entry.params.fromPath), normalizePathKey(entry.params.toPath)].filter(
        Boolean
      )
    )
  )

const registerEntry = (entry: QueueEntry) => {
  for (const key of getEntryPathKeys(entry)) {
    const entries = pendingByPath.get(key) || new Set<QueueEntry>()
    entries.add(entry)
    pendingByPath.set(key, entries)
  }
}

const settleEntry = (entry: QueueEntry) => {
  for (const key of getEntryPathKeys(entry)) {
    const entries = pendingByPath.get(key)
    if (!entries) continue
    entries.delete(entry)
    if (entries.size === 0) pendingByPath.delete(key)
  }
  entry.resolve()
}

const requestWorker = (
  worker: Worker,
  entries: QueueEntry[]
): Promise<NonNullable<WorkerResponse['results']>> =>
  new Promise((resolve, reject) => {
    const requestId = Date.now()
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('recycle bin cache transfer worker timed out'))
    }, WORKER_REQUEST_TIMEOUT_MS)
    const onMessage = (response: WorkerResponse) => {
      if (response?.id !== requestId) return
      cleanup()
      if (response.error) {
        reject(new Error(String(response.error)))
        return
      }
      resolve(Array.isArray(response.results) ? response.results : [])
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number) => {
      cleanup()
      reject(new Error(`recycle bin cache transfer worker exited: ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
    worker.postMessage({
      id: requestId,
      databaseDir: store.databaseDir,
      entries: entries.map((entry) => ({
        id: entry.id,
        params: entry.params,
        context: entry.context
      }))
    })
  })

const runBatch = async (worker: Worker, entries: QueueEntry[]) => {
  const results = await runPlaybackAwareBackgroundFileIo(
    'recycle-bin:transfer-derived-caches',
    { count: entries.length },
    () => requestWorker(worker, entries),
    { priority: 'maintenance' }
  )
  const failed = results.filter((result) => !result.success)
  if (failed.length > 0) {
    log.error('[recycleBin] derived cache transfer failed', {
      failedCount: failed.length,
      errorSamples: failed.slice(0, 3).map((result) => result.error || 'unknown error')
    })
  }
}

const pumpQueue = async () => {
  if (pumpRunning || stopping || queue.length === 0) return
  pumpRunning = true
  const worker = new Worker(resolveMainWorkerPath(__dirname, 'recycleBinCacheTransferWorker.js'))
  activeWorker = worker
  try {
    while (!stopping && queue.length > 0) {
      const entries = queue.splice(0, TRANSFER_BATCH_SIZE)
      try {
        await runBatch(worker, entries)
      } catch (error) {
        if (!stopping) {
          log.error('[recycleBin] derived cache transfer worker failed', error)
        }
      } finally {
        for (const entry of entries) settleEntry(entry)
      }
    }
  } finally {
    if (activeWorker === worker) activeWorker = null
    worker.removeAllListeners()
    await worker.terminate()
    pumpRunning = false
  }
}

const schedulePump = (delayMs = QUEUE_SETTLE_DELAY_MS) => {
  if (stopping) return
  if (pumpTimer) clearTimeout(pumpTimer)
  pumpTimer = setTimeout(() => {
    pumpTimer = null
    void pumpQueue()
  }, delayMs)
  pumpTimer.unref?.()
}

export const enqueueRecycleBinCacheTransfer = (
  params: TrackCacheTransferParams,
  context: TrackCacheTransferContext
): Promise<void> => {
  let resolveCompletion = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  const entry: QueueEntry = {
    id: ++sequence,
    params,
    context,
    completion,
    resolve: resolveCompletion
  }
  queue.push(entry)
  registerEntry(entry)
  schedulePump()
  return completion
}

export const waitForRecycleBinCacheTransfers = async (filePaths: readonly string[]) => {
  const entries = new Set<QueueEntry>()
  for (const filePath of filePaths) {
    const pathEntries = pendingByPath.get(normalizePathKey(filePath))
    if (!pathEntries) continue
    for (const entry of pathEntries) entries.add(entry)
  }
  if (entries.size === 0) return
  const prioritized = queue.filter((entry) => entries.has(entry))
  if (prioritized.length > 0) {
    const remaining = queue.filter((entry) => !entries.has(entry))
    queue.splice(0, queue.length, ...prioritized, ...remaining)
  }
  schedulePump(0)
  await Promise.all([...entries].map((entry) => entry.completion))
}

export const waitForAllRecycleBinCacheTransfers = async () => {
  while (pendingByPath.size > 0) {
    const entries = new Set<QueueEntry>()
    for (const pathEntries of pendingByPath.values()) {
      for (const entry of pathEntries) entries.add(entry)
    }
    if (entries.size === 0) return
    schedulePump(0)
    await Promise.all([...entries].map((entry) => entry.completion))
  }
}

export const stopRecycleBinCacheTransferQueue = () => {
  stopping = true
  if (pumpTimer) {
    clearTimeout(pumpTimer)
    pumpTimer = null
  }
  for (const entry of queue.splice(0)) settleEntry(entry)
  if (activeWorker) {
    void activeWorker.terminate()
    activeWorker = null
  }
}
