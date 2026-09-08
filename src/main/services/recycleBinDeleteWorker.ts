import { Worker } from 'node:worker_threads'
import { resolveMainWorkerPath } from '../workerPath'
import { runPlaybackAwareBackgroundFileIo } from './playbackForegroundActivity'

export type RecycleBinDeleteEntry = {
  filePath: string
  listRoot: string
  originalPath?: string | null
  originalListRoot?: string | null
}

export type RecycleBinDeleteResult = {
  filePath: string
  success: boolean
  error?: string
}

type ScanResult = {
  rootExists: boolean
  filePaths: string[]
  directories: string[]
}

type WorkerResponse = {
  id?: unknown
  result?: unknown
  error?: unknown
}

const DELETE_BATCH_SIZE = 8
const WORKER_REQUEST_TIMEOUT_MS = 120_000

const createWorker = () => new Worker(resolveMainWorkerPath(__dirname, 'recycleBinDeleteWorker.js'))

const requestWorker = <T>(worker: Worker, id: number, payload: object): Promise<T> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('recycle bin worker request timed out'))
    }, WORKER_REQUEST_TIMEOUT_MS)
    const onMessage = (response: WorkerResponse) => {
      if (response?.id !== id) return
      cleanup()
      if (response.error) {
        reject(new Error(String(response.error)))
        return
      }
      resolve(response.result as T)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number) => {
      cleanup()
      reject(new Error(`recycle bin worker exited: ${code}`))
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
    worker.postMessage({ id, ...payload })
  })

export async function scanRecycleBinOffMainThread(rootPath: string): Promise<ScanResult> {
  const worker = createWorker()
  try {
    return await runPlaybackAwareBackgroundFileIo(
      'recycle-bin:scan',
      { rootPath },
      () => requestWorker<ScanResult>(worker, 1, { type: 'scan', rootPath }),
      { priority: 'maintenance' }
    )
  } finally {
    worker.removeAllListeners()
    await worker.terminate()
  }
}

export async function deleteRecycleBinEntriesOffMainThread(
  databaseDir: string,
  entries: RecycleBinDeleteEntry[],
  onProgress?: (completed: number) => void
): Promise<RecycleBinDeleteResult[]> {
  if (entries.length === 0) return []
  const worker = createWorker()
  const results: RecycleBinDeleteResult[] = []
  let requestId = 1
  try {
    for (let offset = 0; offset < entries.length; offset += DELETE_BATCH_SIZE) {
      const batch = entries.slice(offset, offset + DELETE_BATCH_SIZE)
      try {
        const batchResults = await runPlaybackAwareBackgroundFileIo(
          'recycle-bin:delete-batch',
          { count: batch.length },
          () =>
            requestWorker<RecycleBinDeleteResult[]>(worker, requestId++, {
              type: 'delete',
              databaseDir,
              entries: batch
            }),
          { priority: 'maintenance' }
        )
        results.push(...batchResults)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || 'delete failed')
        for (const pendingEntry of entries.slice(offset)) {
          results.push({ filePath: pendingEntry.filePath, success: false, error: message })
        }
        onProgress?.(results.length)
        break
      }
      onProgress?.(results.length)
    }
    return results
  } finally {
    worker.removeAllListeners()
    await worker.terminate()
  }
}

export async function removeRecycleBinDirectoriesOffMainThread(
  directories: string[]
): Promise<void> {
  if (directories.length === 0) return
  const worker = createWorker()
  try {
    await runPlaybackAwareBackgroundFileIo(
      'recycle-bin:remove-directories',
      { count: directories.length },
      () => requestWorker(worker, 1, { type: 'remove-directories', directories }),
      { priority: 'maintenance' }
    )
  } finally {
    worker.removeAllListeners()
    await worker.terminate()
  }
}
