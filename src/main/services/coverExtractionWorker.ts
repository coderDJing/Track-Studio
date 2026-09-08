import { Worker } from 'node:worker_threads'
import { resolveMainWorkerPath } from '../workerPath'

export type ExtractedCover = {
  format: string
  data: Buffer
}

type WorkerResponse = {
  result?: {
    format?: unknown
    data?: unknown
  } | null
  error?: unknown
}

const COVER_EXTRACTION_TIMEOUT_MS = 12_000
const COVER_ABORT_POLL_MS = 80

const toBuffer = (value: unknown): Buffer | null => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  return null
}

export const extractCoverOffMainThread = (
  filePath: string,
  shouldAbort?: () => boolean,
  allowBufferFallback = false
): Promise<ExtractedCover | null> =>
  new Promise((resolve) => {
    const isAborted = () => {
      try {
        return shouldAbort?.() === true
      } catch {
        return true
      }
    }
    if (!filePath || isAborted()) {
      resolve(null)
      return
    }

    const worker = new Worker(resolveMainWorkerPath(__dirname, 'coverExtractionWorker.js'))
    let settled = false
    const finish = (value: ExtractedCover | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(abortPoll)
      worker.removeAllListeners()
      void worker.terminate()
      resolve(value)
    }
    const timeout = setTimeout(() => finish(null), COVER_EXTRACTION_TIMEOUT_MS)
    const abortPoll = setInterval(() => {
      if (isAborted()) finish(null)
    }, COVER_ABORT_POLL_MS)

    worker.once('message', (payload: WorkerResponse) => {
      if (payload?.error || payload?.result === null) {
        finish(null)
        return
      }
      const data = toBuffer(payload?.result?.data)
      if (!data?.length) {
        finish(null)
        return
      }
      finish({
        format: typeof payload?.result?.format === 'string' ? payload.result.format : 'image/jpeg',
        data
      })
    })
    worker.once('error', () => finish(null))
    worker.once('exit', () => finish(null))
    worker.postMessage({ filePath, allowBufferFallback })
  })
