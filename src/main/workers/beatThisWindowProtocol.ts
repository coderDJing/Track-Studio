/**
 * Pure protocol boundary for the stateless dynamic beat-window bridge.
 *
 * This module has no Electron, filesystem or child-process dependencies so the
 * protocol can be unit tested without loading the Python sidecar.
 */

import {
  DYNAMIC_BEAT_GRID_POLICY,
  type DynamicBeatWindowEvidence
} from '../../shared/dynamicBeatGridTypes'

export type { DynamicBeatWindowEvidence } from '../../shared/dynamicBeatGridTypes'

export type BeatWindowRequestWindow = {
  windowId: string
  localStartSec: number
  durationSec: number
}

export const BEAT_WINDOW_PROTOCOL_VERSION = 1
export const MAX_WINDOWS_PER_REQUEST = 2048
export const MAX_BEATS_PER_WINDOW = 2048
export const MAX_DOWNBEATS_PER_WINDOW = 512
export const MAX_WINDOW_RESPONSE_JSON_CHARS = 16 * 1024 * 1024
export const MIN_WINDOW_DURATION_SEC = 8
export const MIN_WINDOW_SAMPLE_RATE = 8000
export const MAX_WINDOW_SAMPLE_RATE = 384000
export const MAX_WINDOW_CHANNELS = 8
export const BEAT_EDGE_TOLERANCE_SEC = 0.05
// 单一来源：与任务 A 的 policy 保持一致，并随请求传给 Python。
export const DOWNBEAT_MATCH_TOLERANCE_SEC = DYNAMIC_BEAT_GRID_POLICY.downbeatMatchToleranceSec
export const WINDOW_START_TOLERANCE_SEC = 0.05

export type BeatThisWindowErrorCode =
  | 'invalid-request'
  | 'malformed-response'
  | 'request-mismatch'
  | 'protocol-version-mismatch'
  | 'bridge-unsupported-command'
  | 'bridge-ready-timeout'
  | 'request-timeout'
  | 'request-cancelled'
  | 'session-closed'
  | 'bridge-exited'
  | 'response-too-large'

export const beatThisWindowProtocolError = (
  code: BeatThisWindowErrorCode,
  message: string
): Error => {
  const error = new Error(message) as Error & { code?: BeatThisWindowErrorCode }
  error.name = 'BeatThisWindowProtocolError'
  error.code = code
  return error
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readFiniteNumber = (value: unknown): number | null => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const roundSeconds = (value: number) => Number(value.toFixed(6))

const normalizeTimeArray = (params: {
  value: unknown
  field: string
  limit: number
  lowerBound: number
  upperBound: number
}): number[] => {
  const { value, field, limit, lowerBound, upperBound } = params
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw beatThisWindowProtocolError('malformed-response', `${field} must be an array`)
  }
  if (value.length > limit) {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `${field} exceeds array limit ${limit} (got ${value.length})`
    )
  }
  const result: number[] = []
  let previousRounded = Number.NEGATIVE_INFINITY
  for (let index = 0; index < value.length; index += 1) {
    const numeric = readFiniteNumber(value[index])
    if (numeric === null) {
      throw beatThisWindowProtocolError(
        'malformed-response',
        `${field}[${index}] must be a finite number`
      )
    }
    if (numeric < lowerBound - BEAT_EDGE_TOLERANCE_SEC) {
      throw beatThisWindowProtocolError(
        'malformed-response',
        `${field}[${index}] is before the window start`
      )
    }
    if (numeric > upperBound + BEAT_EDGE_TOLERANCE_SEC) {
      throw beatThisWindowProtocolError(
        'malformed-response',
        `${field}[${index}] is beyond the window end`
      )
    }
    const rounded = roundSeconds(numeric)
    if (rounded <= previousRounded) {
      throw beatThisWindowProtocolError(
        'malformed-response',
        `${field} must be strictly increasing after rounding at index ${index}`
      )
    }
    previousRounded = rounded
    result.push(rounded)
  }
  return result
}

const assertDownbeatsMatchBeats = (downbeats: number[], beats: number[]) => {
  if (downbeats.length === 0) return
  let beatIndex = 0
  for (let downbeatIndex = 0; downbeatIndex < downbeats.length; downbeatIndex += 1) {
    const downbeat = downbeats[downbeatIndex]
    while (beatIndex < beats.length && beats[beatIndex] < downbeat - DOWNBEAT_MATCH_TOLERANCE_SEC) {
      beatIndex += 1
    }
    if (beatIndex >= beats.length) {
      throw beatThisWindowProtocolError(
        'malformed-response',
        `downbeats[${downbeatIndex}] does not match any beat`
      )
    }
    if (Math.abs(beats[beatIndex] - downbeat) > DOWNBEAT_MATCH_TOLERANCE_SEC) {
      throw beatThisWindowProtocolError(
        'malformed-response',
        `downbeats[${downbeatIndex}] does not match any beat`
      )
    }
    // One-to-one matching: a beat may back at most one downbeat.
    beatIndex += 1
  }
}

export const normalizeBeatWindowEvidence = (
  raw: unknown,
  request: BeatWindowRequestWindow,
  chunkStartAudioSec: number
): DynamicBeatWindowEvidence => {
  if (!isRecord(raw)) {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `window ${request.windowId} evidence must be an object`
    )
  }
  if (raw.windowId !== request.windowId) {
    throw beatThisWindowProtocolError(
      'request-mismatch',
      `window id mismatch: expected ${request.windowId}, got ${String(raw.windowId)}`
    )
  }

  const expectedStartAudioSec = chunkStartAudioSec + request.localStartSec
  const startAudioSec = readFiniteNumber(raw.startAudioSec)
  if (startAudioSec === null || startAudioSec < 0) {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `window ${request.windowId} startAudioSec must be a finite non-negative number`
    )
  }
  if (Math.abs(startAudioSec - expectedStartAudioSec) > WINDOW_START_TOLERANCE_SEC) {
    throw beatThisWindowProtocolError(
      'request-mismatch',
      `window ${request.windowId} startAudioSec offset mismatch ` +
        `(expected ${expectedStartAudioSec.toFixed(3)}, got ${startAudioSec.toFixed(3)})`
    )
  }

  const analyzedDurationSec = readFiniteNumber(raw.analyzedDurationSec)
  if (analyzedDurationSec === null || analyzedDurationSec <= 0) {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `window ${request.windowId} analyzedDurationSec must be positive`
    )
  }
  if (analyzedDurationSec > request.durationSec + BEAT_EDGE_TOLERANCE_SEC) {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `window ${request.windowId} analyzedDurationSec exceeds the request`
    )
  }
  if (analyzedDurationSec < MIN_WINDOW_DURATION_SEC - BEAT_EDGE_TOLERANCE_SEC) {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `window ${request.windowId} analyzedDurationSec is below the inference floor`
    )
  }

  const status = raw.status
  if (status !== 'ok' && status !== 'no-beats') {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `window ${request.windowId} has an unsupported status`
    )
  }
  const normalizedStatus: DynamicBeatWindowEvidence['status'] =
    status === 'no-beats' ? 'no-beats' : 'ok'

  const windowEndAudioSec = startAudioSec + analyzedDurationSec
  const beatsAudioSec = normalizeTimeArray({
    value: raw.beatsAudioSec,
    field: `windows[${request.windowId}].beatsAudioSec`,
    limit: MAX_BEATS_PER_WINDOW,
    lowerBound: startAudioSec,
    upperBound: windowEndAudioSec
  })
  const downbeatsAudioSec = normalizeTimeArray({
    value: raw.downbeatsAudioSec,
    field: `windows[${request.windowId}].downbeatsAudioSec`,
    limit: MAX_DOWNBEATS_PER_WINDOW,
    lowerBound: startAudioSec,
    upperBound: windowEndAudioSec
  })

  if (normalizedStatus === 'no-beats' && beatsAudioSec.length > 0) {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `window ${request.windowId} is no-beats but returned beats`
    )
  }
  if (normalizedStatus === 'ok' && beatsAudioSec.length === 0) {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `window ${request.windowId} is ok but returned no beats`
    )
  }
  if (downbeatsAudioSec.length > 0 && beatsAudioSec.length === 0) {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `window ${request.windowId} returned downbeats without beats`
    )
  }
  assertDownbeatsMatchBeats(downbeatsAudioSec, beatsAudioSec)

  return {
    windowId: request.windowId,
    startAudioSec: roundSeconds(startAudioSec),
    analyzedDurationSec: roundSeconds(analyzedDurationSec),
    status: normalizedStatus,
    beatsAudioSec,
    downbeatsAudioSec
  }
}

export const normalizeBeatWindowResponse = (
  message: unknown,
  expected: {
    requestId: string
    chunkStartAudioSec: number
    windows: BeatWindowRequestWindow[]
  }
): DynamicBeatWindowEvidence[] => {
  if (!isRecord(message)) {
    throw beatThisWindowProtocolError('malformed-response', 'response must be a JSON object')
  }
  if (message.type !== 'beat-windows-result') {
    throw beatThisWindowProtocolError(
      'malformed-response',
      `unexpected response type: ${String(message.type)}`
    )
  }
  if (message.protocolVersion !== BEAT_WINDOW_PROTOCOL_VERSION) {
    throw beatThisWindowProtocolError(
      'protocol-version-mismatch',
      `unexpected protocolVersion: ${String(message.protocolVersion)}`
    )
  }
  if (String(message.requestId || '') !== expected.requestId) {
    throw beatThisWindowProtocolError(
      'request-mismatch',
      `response requestId mismatch: expected ${expected.requestId}, got ${String(
        message.requestId
      )}`
    )
  }
  const rawWindows = message.windows
  if (!Array.isArray(rawWindows)) {
    throw beatThisWindowProtocolError('malformed-response', 'response windows must be an array')
  }
  if (rawWindows.length !== expected.windows.length) {
    throw beatThisWindowProtocolError(
      'request-mismatch',
      `response window count mismatch: expected ${expected.windows.length}, got ${rawWindows.length}`
    )
  }

  const rawById = new Map<string, unknown>()
  const requestedIds = new Set(expected.windows.map((window) => window.windowId))
  for (const rawWindow of rawWindows) {
    if (!isRecord(rawWindow)) {
      throw beatThisWindowProtocolError('malformed-response', 'window evidence must be an object')
    }
    const windowId = String(rawWindow.windowId || '')
    if (!windowId) {
      throw beatThisWindowProtocolError(
        'malformed-response',
        'window evidence id must not be empty'
      )
    }
    if (!requestedIds.has(windowId)) {
      throw beatThisWindowProtocolError(
        'request-mismatch',
        `response contains an unknown window id: ${windowId}`
      )
    }
    if (rawById.has(windowId)) {
      throw beatThisWindowProtocolError(
        'malformed-response',
        `response contains a duplicate window id: ${windowId}`
      )
    }
    rawById.set(windowId, rawWindow)
  }

  return expected.windows.map((requestWindow) => {
    const rawWindow = rawById.get(requestWindow.windowId)
    if (rawWindow === undefined) {
      throw beatThisWindowProtocolError(
        'request-mismatch',
        `response is missing window id: ${requestWindow.windowId}`
      )
    }
    return normalizeBeatWindowEvidence(rawWindow, requestWindow, expected.chunkStartAudioSec)
  })
}

export type NormalizedWindowRequest = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  chunkStartAudioSec: number
  chunkDurationSec: number
  windows: BeatWindowRequestWindow[]
}

export const normalizeWindowRequest = (params: {
  pcmData: Buffer
  sampleRate: number
  channels: number
  chunkStartAudioSec: number
  windows: BeatWindowRequestWindow[]
}): NormalizedWindowRequest => {
  const pcmData = Buffer.isBuffer(params.pcmData) ? params.pcmData : Buffer.from(params.pcmData)
  const sampleRate = Math.floor(Number(params.sampleRate) || 0)
  const channels = Math.floor(Number(params.channels) || 0)
  const chunkStartAudioSec = Number(params.chunkStartAudioSec)
  if (!Number.isFinite(chunkStartAudioSec) || chunkStartAudioSec < 0) {
    throw beatThisWindowProtocolError(
      'invalid-request',
      'chunkStartAudioSec must be a finite non-negative number'
    )
  }
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate < MIN_WINDOW_SAMPLE_RATE ||
    sampleRate > MAX_WINDOW_SAMPLE_RATE
  ) {
    throw beatThisWindowProtocolError(
      'invalid-request',
      `sampleRate must be within ${MIN_WINDOW_SAMPLE_RATE}-${MAX_WINDOW_SAMPLE_RATE}`
    )
  }
  if (!Number.isFinite(channels) || channels < 1 || channels > MAX_WINDOW_CHANNELS) {
    throw beatThisWindowProtocolError(
      'invalid-request',
      `channels must be within 1-${MAX_WINDOW_CHANNELS}`
    )
  }
  const totalSamples = Math.floor(pcmData.byteLength / 4)
  const frameBytes = channels * 4
  if (pcmData.byteLength % frameBytes !== 0) {
    throw beatThisWindowProtocolError(
      'invalid-request',
      `PCM must be frame-aligned to channels*4 bytes (got ${pcmData.byteLength})`
    )
  }
  const usableSamples = totalSamples - (totalSamples % channels)
  if (usableSamples <= 0) {
    throw beatThisWindowProtocolError('invalid-request', 'decoded PCM is empty')
  }
  const pcmSlice =
    usableSamples * 4 === pcmData.byteLength ? pcmData : pcmData.subarray(0, usableSamples * 4)
  const chunkDurationSec = usableSamples / channels / sampleRate

  if (!Array.isArray(params.windows) || params.windows.length === 0) {
    throw beatThisWindowProtocolError('invalid-request', 'windows must be a non-empty array')
  }
  if (params.windows.length > MAX_WINDOWS_PER_REQUEST) {
    throw beatThisWindowProtocolError(
      'invalid-request',
      `windows exceeds limit ${MAX_WINDOWS_PER_REQUEST}`
    )
  }
  const seenIds = new Set<string>()
  const windows = params.windows.map((window, index) => {
    const windowId = String(window?.windowId || '').trim()
    if (!windowId) {
      throw beatThisWindowProtocolError(
        'invalid-request',
        `windows[${index}].windowId must not be empty`
      )
    }
    if (seenIds.has(windowId)) {
      throw beatThisWindowProtocolError('invalid-request', `duplicate windowId: ${windowId}`)
    }
    seenIds.add(windowId)
    const localStartSec = Number(window.localStartSec)
    const durationSec = Number(window.durationSec)
    if (!Number.isFinite(localStartSec) || localStartSec < 0) {
      throw beatThisWindowProtocolError(
        'invalid-request',
        `windows[${index}].localStartSec must be a finite non-negative number`
      )
    }
    if (!Number.isFinite(durationSec) || durationSec < MIN_WINDOW_DURATION_SEC) {
      throw beatThisWindowProtocolError(
        'invalid-request',
        `windows[${index}].durationSec must be >= ${MIN_WINDOW_DURATION_SEC}`
      )
    }
    if (localStartSec + durationSec > chunkDurationSec + BEAT_EDGE_TOLERANCE_SEC) {
      throw beatThisWindowProtocolError(
        'invalid-request',
        `windows[${index}] exceeds the decoded chunk duration`
      )
    }
    return { windowId, localStartSec, durationSec }
  })

  return { pcmData: pcmSlice, sampleRate, channels, chunkStartAudioSec, chunkDurationSec, windows }
}

export const WINDOW_REQUEST_BASE_TIMEOUT_MS = 60_000
export const WINDOW_REQUEST_PER_WINDOW_TIMEOUT_MS = 20_000
export const WINDOW_REQUEST_MAX_TIMEOUT_MS = 600_000

export const resolveWindowRequestTimeoutMs = (windows: number, requestedTimeoutMs?: number) => {
  if (Number.isFinite(requestedTimeoutMs) && Number(requestedTimeoutMs) > 0) {
    return Math.min(WINDOW_REQUEST_MAX_TIMEOUT_MS, Math.floor(Number(requestedTimeoutMs)))
  }
  return Math.min(
    WINDOW_REQUEST_MAX_TIMEOUT_MS,
    WINDOW_REQUEST_BASE_TIMEOUT_MS + windows * WINDOW_REQUEST_PER_WINDOW_TIMEOUT_MS
  )
}
