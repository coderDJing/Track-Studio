import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { resolveMainWorkerPath } from '../workerPath'

export type CoverExtractionTiming = {
  metadataImportMs: number
  parseFileMs: number
  fallbackStatMs: number
  fallbackReadMs: number
  fallbackParseMs: number
  copyMs: number
  totalMs: number
  sourceBytes: number
  usedBufferFallback: boolean
}

export type ExtractedCover = {
  format: string
  data: Buffer
  timing?: CoverExtractionTiming
}

type WorkerResponse = {
  result?: {
    format?: unknown
    data?: unknown
  } | null
  error?: unknown
  timing?: CoverExtractionTiming
}

const COVER_EXTRACTION_TIMEOUT_MS = 12_000
const COVER_ABORT_POLL_MS = 80
const RECENT_WORKER_DIAGNOSTIC_TTL_MS = 60_000
const MAX_RECENT_WORKER_DIAGNOSTICS = 20

type CoverWorkerPhase =
  | 'creating-worker'
  | 'waiting-for-online'
  | 'waiting-for-result'
  | 'converting-result'
  | 'terminating'
  | 'completed'

type CoverWorkerDiagnostic = {
  id: number
  fileName: string
  phase: CoverWorkerPhase
  startedAtMs: number
  phaseStartedAtMs: number
  phaseDurationsMs: Partial<Record<CoverWorkerPhase, number>>
  endedAtMs?: number
  onlineAfterMs?: number
  mainConversionMs?: number
  terminationMs?: number
  totalMs?: number
  outcome?: 'success' | 'empty' | 'error' | 'timeout' | 'aborted'
  workerTiming?: CoverExtractionTiming
}

let workerDiagnosticSequence = 0
const activeWorkerDiagnostics = new Map<number, CoverWorkerDiagnostic>()
const recentWorkerDiagnostics: CoverWorkerDiagnostic[] = []

const markWorkerPhase = (diagnostic: CoverWorkerDiagnostic, phase: CoverWorkerPhase) => {
  const nowMs = Date.now()
  diagnostic.phaseDurationsMs[diagnostic.phase] =
    (diagnostic.phaseDurationsMs[diagnostic.phase] || 0) +
    Math.max(0, nowMs - diagnostic.phaseStartedAtMs)
  diagnostic.phase = phase
  diagnostic.phaseStartedAtMs = nowMs
}

const pruneRecentWorkerDiagnostics = (nowMs = Date.now()) => {
  while (
    recentWorkerDiagnostics.length > 0 &&
    nowMs - (recentWorkerDiagnostics[0].endedAtMs ?? recentWorkerDiagnostics[0].startedAtMs) >
      RECENT_WORKER_DIAGNOSTIC_TTL_MS
  ) {
    recentWorkerDiagnostics.shift()
  }
}

const completeWorkerDiagnostic = (
  diagnostic: CoverWorkerDiagnostic,
  outcome: NonNullable<CoverWorkerDiagnostic['outcome']>
) => {
  markWorkerPhase(diagnostic, 'completed')
  diagnostic.endedAtMs = Date.now()
  diagnostic.outcome = outcome
  diagnostic.totalMs = Math.max(0, diagnostic.endedAtMs - diagnostic.startedAtMs)
  activeWorkerDiagnostics.delete(diagnostic.id)
  recentWorkerDiagnostics.push(diagnostic)
  pruneRecentWorkerDiagnostics()
  if (recentWorkerDiagnostics.length > MAX_RECENT_WORKER_DIAGNOSTICS) {
    recentWorkerDiagnostics.splice(
      0,
      recentWorkerDiagnostics.length - MAX_RECENT_WORKER_DIAGNOSTICS
    )
  }
}

const summarizeWorkerDiagnostic = (diagnostic: CoverWorkerDiagnostic, nowMs: number) => ({
  fileName: diagnostic.fileName,
  phase: diagnostic.phase,
  durationMs: Math.max(
    0,
    (diagnostic.totalMs ? diagnostic.startedAtMs + diagnostic.totalMs : nowMs) -
      diagnostic.startedAtMs
  ),
  currentPhaseDurationMs:
    diagnostic.phase === 'completed' ? 0 : Math.max(0, nowMs - diagnostic.phaseStartedAtMs),
  phaseDurationsMs: diagnostic.phaseDurationsMs,
  onlineAfterMs: diagnostic.onlineAfterMs,
  mainConversionMs: diagnostic.mainConversionMs,
  terminationMs: diagnostic.terminationMs,
  outcome: diagnostic.outcome,
  workerTiming: diagnostic.workerTiming
})

export const getCoverExtractionWorkerDiagnosticSnapshot = (nowMs = Date.now()) => {
  pruneRecentWorkerDiagnostics(nowMs)
  return {
    active: [...activeWorkerDiagnostics.values()].map((diagnostic) =>
      summarizeWorkerDiagnostic(diagnostic, nowMs)
    ),
    recent: recentWorkerDiagnostics.map((diagnostic) =>
      summarizeWorkerDiagnostic(diagnostic, nowMs)
    )
  }
}

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

    const diagnostic: CoverWorkerDiagnostic = {
      id: ++workerDiagnosticSequence,
      fileName: path.basename(filePath),
      phase: 'creating-worker',
      startedAtMs: Date.now(),
      phaseStartedAtMs: Date.now(),
      phaseDurationsMs: {}
    }
    activeWorkerDiagnostics.set(diagnostic.id, diagnostic)
    let worker: Worker
    try {
      worker = new Worker(resolveMainWorkerPath(__dirname, 'coverExtractionWorker.js'))
    } catch {
      completeWorkerDiagnostic(diagnostic, 'error')
      resolve(null)
      return
    }
    let settled = false
    markWorkerPhase(diagnostic, 'waiting-for-online')
    const finish = (
      value: ExtractedCover | null,
      outcome: NonNullable<CoverWorkerDiagnostic['outcome']>
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(abortPoll)
      worker.removeAllListeners()
      markWorkerPhase(diagnostic, 'terminating')
      const terminationStartedAtMs = Date.now()
      void worker.terminate().then(
        () => {
          diagnostic.terminationMs = Math.max(0, Date.now() - terminationStartedAtMs)
        },
        () => {
          diagnostic.terminationMs = Math.max(0, Date.now() - terminationStartedAtMs)
        }
      )
      completeWorkerDiagnostic(diagnostic, outcome)
      resolve(value)
    }
    const timeout = setTimeout(() => finish(null, 'timeout'), COVER_EXTRACTION_TIMEOUT_MS)
    const abortPoll = setInterval(() => {
      if (isAborted()) finish(null, 'aborted')
    }, COVER_ABORT_POLL_MS)

    worker.once('online', () => {
      diagnostic.onlineAfterMs = Math.max(0, Date.now() - diagnostic.startedAtMs)
      markWorkerPhase(diagnostic, 'waiting-for-result')
    })
    worker.once('message', (payload: WorkerResponse) => {
      diagnostic.workerTiming = payload?.timing
      if (payload?.error || payload?.result === null) {
        finish(null, payload?.error ? 'error' : 'empty')
        return
      }
      markWorkerPhase(diagnostic, 'converting-result')
      const conversionStartedAtMs = Date.now()
      const data = toBuffer(payload?.result?.data)
      diagnostic.mainConversionMs = Math.max(0, Date.now() - conversionStartedAtMs)
      if (!data?.length) {
        finish(null, 'empty')
        return
      }
      finish(
        {
          format:
            typeof payload?.result?.format === 'string' ? payload.result.format : 'image/jpeg',
          data,
          timing: payload?.timing
        },
        'success'
      )
    })
    worker.once('error', () => finish(null, 'error'))
    worker.once('exit', () => finish(null, 'error'))
    worker.postMessage({ filePath, allowBufferFallback })
  })
