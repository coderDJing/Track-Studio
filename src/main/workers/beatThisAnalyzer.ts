import fs from 'node:fs'
import path from 'node:path'
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  buildBeatThisChildEnv,
  normalizeBeatThisFsPath,
  resetBeatThisRuntimeResolution,
  resolveBeatThisProjectRoot,
  resolveBeatThisRuntime
} from './beatThisRuntime'
import { lowerAnalysisProcessPriority } from './analysisRuntimeTuning'
import { registerChildProcess, terminateChildProcess } from '../services/childProcessRegistry'
import {
  BEAT_WINDOW_PROTOCOL_VERSION,
  DOWNBEAT_MATCH_TOLERANCE_SEC,
  MAX_WINDOW_RESPONSE_JSON_CHARS,
  beatThisWindowProtocolError,
  normalizeBeatWindowResponse,
  normalizeWindowRequest,
  resolveWindowRequestTimeoutMs,
  type BeatWindowRequestWindow,
  type DynamicBeatWindowEvidence
} from './beatThisWindowProtocol'

type BeatThisAnalyzeResult = {
  bpm: number
  firstBeatMs: number
  rawBpm?: number
  downbeatBeatOffset: number
  beatCount: number
  downbeatCount: number
  durationSec: number
  beatIntervalSec: number
  beatCoverageScore: number
  beatStabilityScore: number
  downbeatCoverageScore: number
  downbeatStabilityScore: number
  qualityScore: number
  rawFirstBeatMs?: number
  anchorCorrectionMs?: number
  anchorConfidenceScore?: number
  anchorMatchedBeatCount?: number
  anchorStrategy?: string
  beatThisEstimatedDrift128Ms?: number
  beatThisWindowCount?: number
  windowStartSec?: number
  windowDurationSec?: number
  windowIndex?: number
}

type BeatThisBridgeAnalyzeResult = Omit<BeatThisAnalyzeResult, 'downbeatBeatOffset'> & {
  downbeatBeatOffset?: number
  // 仅兼容尚未随应用更新的 bundled Python bridge；不会再向业务结果透传。
  barBeatOffset?: number
}

type BeatThisBridgeMessage =
  | {
      type: 'ready'
    }
  | {
      type: 'result'
      requestId: string
      result: BeatThisBridgeAnalyzeResult
    }
  | {
      type: 'error' | 'fatal'
      requestId?: string
      error?: string
    }
  | {
      type: 'shutdown'
      requestId?: string
    }

export type BeatWindowAnalyzeParams = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  chunkStartAudioSec: number
  windows: BeatWindowRequestWindow[]
  timeoutMs?: number
  signal?: AbortSignal
  onDiagnosticPhase?: (phase: string) => void
}

export type BeatThisWindowSession = {
  readonly pid: number | null
  analyzeWindows: (params: BeatWindowAnalyzeParams) => Promise<DynamicBeatWindowEvidence[]>
  close: () => Promise<void>
}

export type BeatThisWindowSessionOptions = {
  /**
   * Called synchronously right after spawn with the owned PID, and with null
   * only after that exact child process has really exited/closed. A newer
   * spawn is never cleared by an older child's late exit event.
   */
  onProcessChange?: (pid: number | null) => void
}

type BeatWindowsBridgeMessage =
  | {
      type: 'ready'
    }
  | {
      type: 'beat-windows-result'
      protocolVersion?: number
      requestId?: string
      windows?: unknown
    }
  | {
      type: 'error' | 'fatal'
      requestId?: string
      error?: string
    }
  | {
      type: 'shutdown'
      requestId?: string
    }

type PendingWindowRequest = {
  resolve: (value: DynamicBeatWindowEvidence[]) => void
  reject: (error: Error) => void
  cleanup: () => void
  expected: {
    requestId: string
    chunkStartAudioSec: number
    windows: BeatWindowRequestWindow[]
  }
}

const WINDOW_READY_TIMEOUT_MS = 120_000
const WINDOW_SESSION_CLOSE_TIMEOUT_MS = 1_500

type PendingRequest = {
  resolve: (value: BeatThisAnalyzeResult) => void
  reject: (error: Error) => void
}

const ENV_BEAT_THIS_BRIDGE = 'FRKB_BEAT_THIS_BRIDGE'
const ENV_BEAT_THIS_DBN = 'FRKB_BEAT_THIS_DBN'
const LOCAL_BRIDGE_PATH = 'scripts/beat_this_bridge.py'
const PACKAGED_BRIDGE_RELATIVE_PATH = 'demucs/bootstrap/beat_this_bridge.py'
const DEFAULT_WINDOW_SEC = 30
const DEFAULT_MAX_SCAN_SEC = 120
const WINDOW_MIN_DURATION_SEC = 8

let cachedBridgePath = ''
let bridgeChild: ChildProcessWithoutNullStreams | null = null
let bridgeReadyPromise: Promise<void> | null = null
let bridgeReadyResolve: (() => void) | null = null
let bridgeReadyReject: ((error: Error) => void) | null = null
let bridgeStdoutBuffer = ''
let bridgeStderrBuffer = ''
let bridgeNextRequestId = 0
let bridgeRequestQueue: Promise<unknown> = Promise.resolve()
const bridgePendingRequests = new Map<string, PendingRequest>()
let cleanupHooksRegistered = false
let bridgeStartupFailedAfterSpawn = false

const resolveBridgeScriptPath = () => {
  if (cachedBridgePath) return cachedBridgePath

  const envBridge = normalizeBeatThisFsPath(process.env[ENV_BEAT_THIS_BRIDGE] || '')
  if (envBridge && fs.existsSync(envBridge)) {
    cachedBridgePath = envBridge
    return envBridge
  }

  const packagedBridge = normalizeBeatThisFsPath(
    path.join(normalizeBeatThisFsPath(process.resourcesPath || ''), PACKAGED_BRIDGE_RELATIVE_PATH)
  )
  if (packagedBridge && fs.existsSync(packagedBridge)) {
    cachedBridgePath = packagedBridge
    return packagedBridge
  }

  const unpackedBridge = normalizeBeatThisFsPath(
    path.join(
      normalizeBeatThisFsPath(process.resourcesPath || ''),
      'app.asar.unpacked',
      LOCAL_BRIDGE_PATH
    )
  )
  if (unpackedBridge && fs.existsSync(unpackedBridge)) {
    cachedBridgePath = unpackedBridge
    return unpackedBridge
  }

  const localBridge = path.join(resolveBeatThisProjectRoot(), LOCAL_BRIDGE_PATH)
  cachedBridgePath = localBridge
  return localBridge
}

export const normalizeBeatThisAnalyzeResult = (
  input: BeatThisBridgeAnalyzeResult
): BeatThisAnalyzeResult | null => {
  const bpm = Number(input?.bpm)
  const rawBpm = Number(input?.rawBpm)
  const firstBeatMs = Number(input?.firstBeatMs)
  const rawDownbeatBeatOffset = Number(input?.downbeatBeatOffset ?? input?.barBeatOffset)
  const beatCount = Math.max(0, Math.floor(Number(input?.beatCount) || 0))
  const downbeatCount = Math.max(0, Math.floor(Number(input?.downbeatCount) || 0))
  const durationSec = Math.max(0, Number(input?.durationSec) || 0)
  const beatIntervalSec = Math.max(0, Number(input?.beatIntervalSec) || 0)
  const beatCoverageScore = Math.max(0, Math.min(1, Number(input?.beatCoverageScore) || 0))
  const beatStabilityScore = Math.max(0, Math.min(1, Number(input?.beatStabilityScore) || 0))
  const downbeatCoverageScore = Math.max(0, Math.min(1, Number(input?.downbeatCoverageScore) || 0))
  const downbeatStabilityScore = Math.max(
    0,
    Math.min(1, Number(input?.downbeatStabilityScore) || 0)
  )
  const qualityScore = Math.max(0, Math.min(1, Number(input?.qualityScore) || 0))
  const rawFirstBeatMs = Number(input?.rawFirstBeatMs)
  const anchorCorrectionMs = Number(input?.anchorCorrectionMs)
  const anchorConfidenceScore = Math.max(0, Math.min(1, Number(input?.anchorConfidenceScore) || 0))
  const anchorMatchedBeatCount = Math.max(0, Math.floor(Number(input?.anchorMatchedBeatCount) || 0))
  const anchorStrategy = String(input?.anchorStrategy || '').trim()
  const beatThisEstimatedDrift128Ms = Number(input?.beatThisEstimatedDrift128Ms)
  const beatThisWindowCount = Math.max(0, Math.floor(Number(input?.beatThisWindowCount) || 0))

  if (!Number.isFinite(bpm) || bpm <= 0) return null
  if (!Number.isFinite(firstBeatMs)) return null

  const downbeatBeatOffset = Number.isFinite(rawDownbeatBeatOffset)
    ? ((Math.round(rawDownbeatBeatOffset) % 4) + 4) % 4
    : 0
  return {
    bpm: Number(bpm.toFixed(6)),
    rawBpm: Number.isFinite(rawBpm) && rawBpm > 0 ? Number(rawBpm.toFixed(6)) : undefined,
    firstBeatMs: Number(firstBeatMs.toFixed(3)),
    downbeatBeatOffset,
    beatCount,
    downbeatCount,
    durationSec: Number(durationSec.toFixed(3)),
    beatIntervalSec: Number(beatIntervalSec.toFixed(6)),
    beatCoverageScore: Number(beatCoverageScore.toFixed(6)),
    beatStabilityScore: Number(beatStabilityScore.toFixed(6)),
    downbeatCoverageScore: Number(downbeatCoverageScore.toFixed(6)),
    downbeatStabilityScore: Number(downbeatStabilityScore.toFixed(6)),
    qualityScore: Number(qualityScore.toFixed(6)),
    rawFirstBeatMs: Number.isFinite(rawFirstBeatMs) ? Number(rawFirstBeatMs.toFixed(3)) : undefined,
    anchorCorrectionMs: Number.isFinite(anchorCorrectionMs)
      ? Number(anchorCorrectionMs.toFixed(3))
      : undefined,
    anchorConfidenceScore: Number(anchorConfidenceScore.toFixed(6)),
    anchorMatchedBeatCount,
    anchorStrategy: anchorStrategy || undefined,
    beatThisEstimatedDrift128Ms: Number.isFinite(beatThisEstimatedDrift128Ms)
      ? Number(beatThisEstimatedDrift128Ms.toFixed(3))
      : undefined,
    beatThisWindowCount: beatThisWindowCount > 0 ? beatThisWindowCount : undefined,
    windowStartSec: Number(Number(input?.windowStartSec || 0).toFixed(3)),
    windowDurationSec: Number(Number(input?.windowDurationSec || 0).toFixed(3)),
    windowIndex: Math.max(0, Math.floor(Number(input?.windowIndex) || 0))
  }
}

const settleBridgeReady = (error?: Error) => {
  if (error) {
    bridgeReadyReject?.(error)
  } else {
    bridgeReadyResolve?.()
  }
  bridgeReadyResolve = null
  bridgeReadyReject = null
}

const rejectAllPendingRequests = (error: Error) => {
  for (const pending of bridgePendingRequests.values()) {
    pending.reject(error)
  }
  bridgePendingRequests.clear()
}

const resetBridgeProcessState = (
  error?: Error,
  options: { resetRuntimeResolution?: boolean } = {}
) => {
  bridgeChild = null
  bridgeStdoutBuffer = ''
  bridgeStderrBuffer = ''
  if (options.resetRuntimeResolution) {
    bridgeStartupFailedAfterSpawn = true
    resetBeatThisRuntimeResolution()
  }
  if (bridgeReadyResolve || bridgeReadyReject) {
    settleBridgeReady(error || new Error('Beat This! bridge terminated before ready'))
  }
  bridgeReadyPromise = null
  rejectAllPendingRequests(error || new Error('Beat This! bridge terminated'))
}

const registerCleanupHooks = () => {
  if (cleanupHooksRegistered) return
  cleanupHooksRegistered = true
  const shutdown = () => {
    if (!bridgeChild) return
    terminateChildProcess(bridgeChild, 'beat-this:bridge')
  }
  process.once('exit', shutdown)
  process.once('SIGINT', () => {
    shutdown()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    shutdown()
    process.exit(143)
  })
}

const handleBridgeMessage = (message: BeatThisBridgeMessage) => {
  if (message.type === 'ready') {
    settleBridgeReady()
    return
  }

  if (message.type === 'fatal') {
    const error = new Error(message.error || 'Beat This! bridge fatal error')
    if (bridgeReadyResolve || bridgeReadyReject) {
      settleBridgeReady(error)
    } else {
      rejectAllPendingRequests(error)
    }
    return
  }

  const requestId = String(message.requestId || '').trim()
  if (!requestId) return
  const pending = bridgePendingRequests.get(requestId)
  if (!pending) return
  bridgePendingRequests.delete(requestId)

  if (message.type === 'result') {
    const normalized = normalizeBeatThisAnalyzeResult(message.result)
    if (!normalized) {
      pending.reject(new Error('Beat This! returned invalid beat grid result'))
      return
    }
    pending.resolve(normalized)
    return
  }

  const errorText = 'error' in message ? message.error : undefined
  pending.reject(new Error(errorText || 'Beat This! bridge request ended unexpectedly'))
}

const handleBridgeStdoutChunk = (chunk: Buffer | string) => {
  bridgeStdoutBuffer += chunk.toString()
  while (true) {
    const lineBreakIndex = bridgeStdoutBuffer.indexOf('\n')
    if (lineBreakIndex < 0) return
    const line = bridgeStdoutBuffer.slice(0, lineBreakIndex).trim()
    bridgeStdoutBuffer = bridgeStdoutBuffer.slice(lineBreakIndex + 1)
    if (!line) continue
    try {
      handleBridgeMessage(JSON.parse(line) as BeatThisBridgeMessage)
    } catch (error) {
      const parseError = new Error(
        `Beat This! bridge returned invalid JSON: ${
          error instanceof Error ? error.message : String(error || 'unknown parse error')
        }`
      )
      if (bridgeReadyResolve || bridgeReadyReject) {
        settleBridgeReady(parseError)
      } else {
        rejectAllPendingRequests(parseError)
      }
    }
  }
}

const startBridgeProcess = async () => {
  if (bridgeChild && bridgeReadyPromise) {
    await bridgeReadyPromise
    return bridgeChild
  }

  const resolvedRuntime = resolveBeatThisRuntime()
  if (!resolvedRuntime) {
    throw new Error('Beat This! Python runtime not available')
  }
  const pythonCommand = resolvedRuntime.candidate

  const bridgePath = resolveBridgeScriptPath()
  if (!bridgePath || !fs.existsSync(bridgePath)) {
    throw new Error(`Beat This! bridge missing: ${bridgePath || '<empty>'}`)
  }

  const device = resolvedRuntime.selectedDeviceArg || 'cpu'
  const dbnEnabled = /^(1|true|yes|on)$/i.test(String(process.env[ENV_BEAT_THIS_DBN] || '').trim())
  const child = childProcess.spawn(
    pythonCommand.command,
    [...pythonCommand.args, bridgePath, '--serve', device, dbnEnabled ? 'true' : 'false'],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildBeatThisChildEnv(pythonCommand)
    }
  )
  registerChildProcess(child, 'beat-this:bridge')
  lowerAnalysisProcessPriority(child)

  bridgeChild = child
  registerCleanupHooks()
  bridgeReadyPromise = new Promise<void>((resolve, reject) => {
    bridgeReadyResolve = resolve
    bridgeReadyReject = reject
  })

  child.stdout.on('data', handleBridgeStdoutChunk)
  child.stderr.on('data', (chunk: Buffer | string) => {
    bridgeStderrBuffer += chunk.toString()
    if (bridgeStderrBuffer.length > 4000) {
      bridgeStderrBuffer = bridgeStderrBuffer.slice(-4000)
    }
  })
  child.once('error', (error) => {
    if (bridgeChild !== child) return
    const startupError = new Error(
      `Beat This! bridge process failed: ${error instanceof Error ? error.message : String(error)}`
    )
    resetBridgeProcessState(startupError, { resetRuntimeResolution: true })
  })
  child.once('exit', (code, signal) => {
    if (bridgeChild !== child) return
    const stderrTail = bridgeStderrBuffer.trim()
    const exitError = new Error(
      `Beat This! bridge exited unexpectedly (code=${String(code ?? '')}, signal=${String(signal ?? '')})${
        stderrTail ? ` stderr=${stderrTail}` : ''
      }`
    )
    resetBridgeProcessState(exitError, { resetRuntimeResolution: true })
  })

  await bridgeReadyPromise
  return child
}

const ensureBridgeProcess = async () => {
  if (bridgeChild && bridgeReadyPromise) {
    await bridgeReadyPromise
    return bridgeChild
  }

  try {
    return await startBridgeProcess()
  } catch (error) {
    if (!bridgeStartupFailedAfterSpawn) throw error
    bridgeStartupFailedAfterSpawn = false
    return await startBridgeProcess()
  }
}

const writeToBridge = async (child: ChildProcessWithoutNullStreams, chunk: Buffer | string) => {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      child.stdin.off('error', handleError)
      reject(error)
    }
    child.stdin.once('error', handleError)
    const flushed = child.stdin.write(chunk, (error) => {
      child.stdin.off('error', handleError)
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
    if (!flushed) {
      child.stdin.once('drain', () => {})
    }
  })
}

const analyzeBeatGridWithBeatThisFromPcm = async (params: {
  pcmData: Buffer
  sampleRate: number
  channels: number
  sourceFilePath?: string
  windowSec?: number
  maxScanSec?: number
  minBpm?: number
  maxBpm?: number
  onDiagnosticPhase?: (phase: string) => void
}) => {
  const pcmData = Buffer.isBuffer(params.pcmData) ? params.pcmData : Buffer.from(params.pcmData)
  const totalSamples = Math.floor(pcmData.byteLength / 4)
  const channels = Math.max(1, Math.floor(Number(params.channels) || 0))
  const usableSamples = totalSamples - (totalSamples % channels)
  if (usableSamples <= 0) {
    throw new Error('decoded PCM is empty')
  }

  params.onDiagnosticPhase?.('bpm:bridge-queue')
  const runRequest = bridgeRequestQueue
    .catch(() => undefined)
    .then(async () => {
      params.onDiagnosticPhase?.('bpm:bridge-ready')
      const child = await ensureBridgeProcess()
      const requestId = `req-${Date.now()}-${++bridgeNextRequestId}`
      const pcmSlice =
        usableSamples * 4 === pcmData.byteLength ? pcmData : pcmData.subarray(0, usableSamples * 4)
      const header = JSON.stringify({
        type: 'analyze_pcm',
        requestId,
        sampleRate: Math.max(1, Math.floor(Number(params.sampleRate) || 0)),
        channels,
        byteLength: pcmSlice.byteLength,
        sourceFilePath: params.sourceFilePath || '',
        windowSec: Math.max(1, Number(params.windowSec) || DEFAULT_WINDOW_SEC),
        maxScanSec: Math.max(
          Math.max(1, Number(params.windowSec) || DEFAULT_WINDOW_SEC),
          Number(params.maxScanSec) || DEFAULT_MAX_SCAN_SEC
        ),
        minBpm: Number(params.minBpm),
        maxBpm: Number(params.maxBpm)
      })

      const response = new Promise<BeatThisAnalyzeResult>((resolve, reject) => {
        bridgePendingRequests.set(requestId, { resolve, reject })
      })

      try {
        params.onDiagnosticPhase?.('bpm:bridge-write')
        await writeToBridge(child, `${header}\n`)
        await writeToBridge(child, pcmSlice)
        params.onDiagnosticPhase?.('bpm:bridge-inference-wait')
        const result = await response
        params.onDiagnosticPhase?.('bpm:bridge-result')
        return result
      } catch (error) {
        bridgePendingRequests.delete(requestId)
        throw error
      }
    })
  bridgeRequestQueue = runRequest.catch(() => undefined)
  return runRequest
}

export const analyzeBeatGridWithBeatThisSlidingWindowsFromPcm = async (params: {
  pcmData: Buffer
  sampleRate: number
  channels: number
  sourceFilePath?: string
  windowSec?: number
  maxScanSec?: number
  minBpm?: number
  maxBpm?: number
  onDiagnosticPhase?: (phase: string) => void
}) => {
  const pcmData = Buffer.isBuffer(params.pcmData) ? params.pcmData : Buffer.from(params.pcmData)
  const sampleRate = Math.max(1, Math.floor(Number(params.sampleRate) || 0))
  const channels = Math.max(1, Math.floor(Number(params.channels) || 0))
  const totalSamples = Math.floor(pcmData.byteLength / 4)
  const totalFrames = Math.floor(totalSamples / channels)
  const totalDurationSec = totalFrames / sampleRate
  const windowSec = Math.max(1, Number(params.windowSec) || DEFAULT_WINDOW_SEC)
  const maxScanSec = Math.max(windowSec, Number(params.maxScanSec) || DEFAULT_MAX_SCAN_SEC)
  if (Math.min(totalDurationSec, maxScanSec) < WINDOW_MIN_DURATION_SEC) {
    throw new Error('Beat This! sliding-window analysis failed')
  }
  return analyzeBeatGridWithBeatThisFromPcm({
    pcmData,
    sampleRate,
    channels,
    sourceFilePath: params.sourceFilePath,
    windowSec,
    maxScanSec,
    minBpm: params.minBpm,
    maxBpm: params.maxBpm,
    onDiagnosticPhase: params.onDiagnosticPhase
  })
}

// ---------------------------------------------------------------------------
// Dynamic beat-window bridge (protocolVersion 1)
// ---------------------------------------------------------------------------

const ownedWindowSessionTerminators = new Set<() => void>()
let ownedWindowCleanupRegistered = false

const registerOwnedWindowTerminator = (terminate: () => void) => {
  ownedWindowSessionTerminators.add(terminate)
  if (!ownedWindowCleanupRegistered) {
    ownedWindowCleanupRegistered = true
    process.once('exit', () => {
      for (const cleanup of Array.from(ownedWindowSessionTerminators)) {
        try {
          cleanup()
        } catch {}
      }
      ownedWindowSessionTerminators.clear()
    })
  }
  return () => {
    ownedWindowSessionTerminators.delete(terminate)
  }
}

export const createBeatThisWindowSession = (
  options: BeatThisWindowSessionOptions = {}
): BeatThisWindowSession => {
  let child: ChildProcessWithoutNullStreams | null = null
  let readyPromise: Promise<void> | null = null
  let settleReady: ((error?: Error) => void) | null = null
  let ready = false
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let requestCounter = 0
  let queue: Promise<unknown> = Promise.resolve()
  let closing = false
  let unregisterOwned: (() => void) | null = null
  let processGeneration = 0
  let announcedPid: number | null = null
  const pendingRequests = new Map<string, PendingWindowRequest>()

  const emitProcessChange = (pid: number | null) => {
    try {
      options.onProcessChange?.(pid)
    } catch {}
  }

  const clearReadyTimer = () => {
    if (!readyTimer) return
    clearTimeout(readyTimer)
    readyTimer = null
  }

  const rejectAllPending = (error: Error) => {
    for (const request of Array.from(pendingRequests.values())) {
      request.cleanup()
      request.reject(error)
    }
    pendingRequests.clear()
  }

  const detachOwned = () => {
    unregisterOwned?.()
    unregisterOwned = null
  }

  const abandonOwnedProcess = (error: Error) => {
    const current = child
    const pendingReady = settleReady
    child = null
    ready = false
    readyPromise = null
    settleReady = null
    clearReadyTimer()
    stdoutBuffer = ''
    stderrBuffer = ''
    detachOwned()
    if (current) {
      terminateChildProcess(current, 'beat-this:dynamic-windows')
    }
    pendingReady?.(error)
    rejectAllPending(error)
  }

  const handleMessage = (message: BeatWindowsBridgeMessage) => {
    if (message.type === 'ready') {
      ready = true
      clearReadyTimer()
      settleReady?.()
      settleReady = null
      return
    }

    if (message.type === 'fatal') {
      abandonOwnedProcess(
        beatThisWindowProtocolError(
          'bridge-exited',
          message.error || 'Beat This! dynamic window bridge fatal error'
        )
      )
      return
    }

    const requestId = String(message.requestId || '').trim()
    if (!requestId) return
    const pending = pendingRequests.get(requestId)
    if (!pending) return
    pendingRequests.delete(requestId)
    pending.cleanup()

    if (message.type === 'beat-windows-result') {
      try {
        pending.resolve(normalizeBeatWindowResponse(message, pending.expected))
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }

    if (message.type === 'error') {
      const errorText = message.error || 'Beat This! dynamic window request failed'
      if (/unsupported command/i.test(errorText)) {
        pending.reject(
          beatThisWindowProtocolError(
            'bridge-unsupported-command',
            'Beat This! runtime does not support analyze_beat_windows (protocolVersion 1); ' +
              'update the bundled runtime instead of falling back to Normal analysis'
          )
        )
        return
      }
      pending.reject(beatThisWindowProtocolError('bridge-exited', errorText))
    }
  }

  const handleStdoutChunk = (chunk: Buffer | string) => {
    const text = chunk.toString()
    if (stdoutBuffer.length + text.length > MAX_WINDOW_RESPONSE_JSON_CHARS) {
      abandonOwnedProcess(
        beatThisWindowProtocolError('response-too-large', 'dynamic window response is too large')
      )
      return
    }
    stdoutBuffer += text
    while (true) {
      const lineBreakIndex = stdoutBuffer.indexOf('\n')
      if (lineBreakIndex < 0) return
      const line = stdoutBuffer.slice(0, lineBreakIndex).trim()
      stdoutBuffer = stdoutBuffer.slice(lineBreakIndex + 1)
      if (!line) continue
      if (line.length > MAX_WINDOW_RESPONSE_JSON_CHARS) {
        abandonOwnedProcess(
          beatThisWindowProtocolError('response-too-large', 'dynamic window response is too large')
        )
        return
      }
      try {
        handleMessage(JSON.parse(line) as BeatWindowsBridgeMessage)
      } catch (error) {
        abandonOwnedProcess(
          beatThisWindowProtocolError(
            'malformed-response',
            `Beat This! dynamic window bridge returned invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
        return
      }
    }
  }

  const spawnOwnedBridge = () => {
    const resolvedRuntime = resolveBeatThisRuntime()
    if (!resolvedRuntime) {
      throw beatThisWindowProtocolError('bridge-exited', 'Beat This! Python runtime not available')
    }
    const bridgePath = resolveBridgeScriptPath()
    if (!bridgePath || !fs.existsSync(bridgePath)) {
      throw beatThisWindowProtocolError(
        'bridge-exited',
        `Beat This! bridge missing: ${bridgePath || '<empty>'}`
      )
    }
    const device = resolvedRuntime.selectedDeviceArg || 'cpu'
    const dbnEnabled = /^(1|true|yes|on)$/i.test(
      String(process.env[ENV_BEAT_THIS_DBN] || '').trim()
    )
    const spawned = childProcess.spawn(
      resolvedRuntime.candidate.command,
      [
        ...resolvedRuntime.candidate.args,
        bridgePath,
        '--serve',
        device,
        dbnEnabled ? 'true' : 'false'
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildBeatThisChildEnv(resolvedRuntime.candidate)
      }
    )

    child = spawned
    // Announce synchronously, before the model load/ready handshake begins.
    // The generation guard keeps a late exit of an older child from clearing a
    // newer PID (which may even have been reused by the OS).
    const generation = ++processGeneration
    announcedPid = spawned.pid ?? null
    emitProcessChange(announcedPid)
    let processGoneNotified = false
    const notifyProcessGone = () => {
      if (processGoneNotified) return
      processGoneNotified = true
      if (generation !== processGeneration) return
      if (announcedPid === null) return
      announcedPid = null
      emitProcessChange(null)
    }
    spawned.once('exit', notifyProcessGone)
    spawned.once('close', notifyProcessGone)
    registerChildProcess(spawned, 'beat-this:dynamic-windows')
    lowerAnalysisProcessPriority(spawned)

    readyPromise = new Promise<void>((resolve, reject) => {
      settleReady = (error?: Error) => {
        if (error) reject(error)
        else resolve()
      }
    })
    readyTimer = setTimeout(() => {
      abandonOwnedProcess(
        beatThisWindowProtocolError(
          'bridge-ready-timeout',
          `Beat This! dynamic window bridge did not become ready within ${WINDOW_READY_TIMEOUT_MS}ms`
        )
      )
    }, WINDOW_READY_TIMEOUT_MS)
    unregisterOwned = registerOwnedWindowTerminator(() => {
      if (child === spawned) {
        terminateChildProcess(spawned, 'beat-this:dynamic-windows')
      }
    })

    spawned.stdout.on('data', handleStdoutChunk)
    spawned.stderr.on('data', (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString()
      if (stderrBuffer.length > 4000) {
        stderrBuffer = stderrBuffer.slice(-4000)
      }
    })
    spawned.once('error', (error: Error) => {
      if (child !== spawned) return
      abandonOwnedProcess(
        beatThisWindowProtocolError(
          'bridge-exited',
          `Beat This! dynamic window bridge failed: ${error.message}`
        )
      )
    })
    spawned.once('exit', (code, signal) => {
      if (child !== spawned) return
      const stderrTail = stderrBuffer.trim()
      abandonOwnedProcess(
        beatThisWindowProtocolError(
          'bridge-exited',
          `Beat This! dynamic window bridge exited unexpectedly ` +
            `(code=${String(code ?? '')}, signal=${String(signal ?? '')})` +
            (stderrTail ? ` stderr=${stderrTail}` : '')
        )
      )
    })
  }

  const ensureProcess = async () => {
    if (child && ready) return child
    if (!child) spawnOwnedBridge()
    if (readyPromise) await readyPromise
    if (!child) {
      throw beatThisWindowProtocolError(
        'bridge-exited',
        'Beat This! dynamic window bridge unavailable'
      )
    }
    return child
  }

  const runRequest = async (
    params: BeatWindowAnalyzeParams
  ): Promise<DynamicBeatWindowEvidence[]> => {
    if (closing) {
      throw beatThisWindowProtocolError('session-closed', 'dynamic window session is closed')
    }
    const normalized = normalizeWindowRequest(params)
    // Queued requests that were cancelled while waiting must not spawn a sidecar.
    if (params.signal?.aborted) {
      throw beatThisWindowProtocolError('request-cancelled', 'dynamic window request was cancelled')
    }

    params.onDiagnosticPhase?.('dynamic-windows:bridge-ready')
    const spawned = await ensureProcess()
    const requestId = `dyn-${Date.now()}-${++requestCounter}`
    const header = JSON.stringify({
      type: 'analyze_beat_windows',
      protocolVersion: BEAT_WINDOW_PROTOCOL_VERSION,
      requestId,
      chunkStartAudioSec: normalized.chunkStartAudioSec,
      sampleRate: normalized.sampleRate,
      channels: normalized.channels,
      byteLength: normalized.pcmData.byteLength,
      downbeatMatchToleranceSec: DOWNBEAT_MATCH_TOLERANCE_SEC,
      windows: normalized.windows
    })
    const expected = {
      requestId,
      chunkStartAudioSec: normalized.chunkStartAudioSec,
      windows: normalized.windows
    }
    const timeoutMs = resolveWindowRequestTimeoutMs(normalized.windows.length, params.timeoutMs)

    const response = new Promise<DynamicBeatWindowEvidence[]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let request: PendingWindowRequest | null = null
      const failAndAbandon = (error: Error) => {
        pendingRequests.delete(requestId)
        request?.cleanup()
        request?.reject(error)
        abandonOwnedProcess(error)
      }
      const abortHandler = () => {
        failAndAbandon(
          beatThisWindowProtocolError('request-cancelled', 'dynamic window request was cancelled')
        )
      }
      request = {
        resolve: (value) => {
          clearTimeout(timer ?? undefined)
          params.signal?.removeEventListener('abort', abortHandler)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer ?? undefined)
          params.signal?.removeEventListener('abort', abortHandler)
          reject(error)
        },
        cleanup: () => {
          clearTimeout(timer ?? undefined)
          params.signal?.removeEventListener('abort', abortHandler)
        },
        expected
      }
      pendingRequests.set(requestId, request)
      timer = setTimeout(() => {
        failAndAbandon(
          beatThisWindowProtocolError(
            'request-timeout',
            `dynamic window request timed out after ${timeoutMs}ms`
          )
        )
      }, timeoutMs)
      params.signal?.addEventListener('abort', abortHandler, { once: true })
    })

    try {
      params.onDiagnosticPhase?.('dynamic-windows:write')
      await writeToBridge(spawned, `${header}\n`)
      await writeToBridge(spawned, normalized.pcmData)
      params.onDiagnosticPhase?.('dynamic-windows:inference-wait')
      const evidence = await response
      params.onDiagnosticPhase?.('dynamic-windows:result')
      return evidence
    } catch (error) {
      const pending = pendingRequests.get(requestId)
      if (pending) {
        pendingRequests.delete(requestId)
        pending.cleanup()
      }
      if (child) {
        abandonOwnedProcess(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    }
  }

  const analyzeWindows = (params: BeatWindowAnalyzeParams) => {
    const run = queue.catch(() => undefined).then(() => runRequest(params))
    queue = run.catch(() => undefined)
    return run
  }

  const close = async () => {
    if (closing) return
    closing = true
    const current = child
    if (!current) {
      detachOwned()
      closing = false
      return
    }
    if (pendingRequests.size > 0) {
      abandonOwnedProcess(
        beatThisWindowProtocolError(
          'session-closed',
          'dynamic window session closed with a pending request'
        )
      )
      closing = false
      return
    }
    try {
      await writeToBridge(
        current,
        `${JSON.stringify({ type: 'shutdown', requestId: `dyn-close-${Date.now()}` })}\n`
      )
    } catch {}
    try {
      current.stdin.end()
    } catch {}
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child === current) {
          abandonOwnedProcess(
            beatThisWindowProtocolError(
              'session-closed',
              'dynamic window bridge did not exit during shutdown'
            )
          )
        }
        resolve()
      }, WINDOW_SESSION_CLOSE_TIMEOUT_MS)
      current.once('exit', () => {
        clearTimeout(timer)
        if (child === current) {
          child = null
          ready = false
          readyPromise = null
          detachOwned()
        }
        resolve()
      })
    })
    closing = false
  }

  return {
    get pid() {
      return child?.pid ?? null
    },
    analyzeWindows,
    close
  }
}

export const analyzeBeatWindowsWithBeatThisFromPcm = async (
  params: BeatWindowAnalyzeParams
): Promise<DynamicBeatWindowEvidence[]> => {
  const session = createBeatThisWindowSession()
  try {
    return await session.analyzeWindows(params)
  } finally {
    await session.close()
  }
}
