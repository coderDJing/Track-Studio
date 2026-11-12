/**
 * Bounded, EOF-verified audio duration for the dynamic beat grid.
 *
 * Container metadata may include a non-zero `start_time` (e.g. Matroska
 * `format.duration` includes the offset), so it is only a candidate. We decode
 * a bounded tail window with the native PCM decoder and accept the duration
 * only when the decoder actually reaches EOF inside that window.
 *
 * Cost: at most one 60s stereo decode (~21MB PCM at 44.1kHz). Call from a
 * worker if main-thread blocking is measured to be unacceptable; never decode
 * the whole track here.
 */

export const DURATION_PROBE_LOOKBACK_SEC = 30
export const DURATION_PROBE_MAX_SEC = 60
export const DURATION_PROBE_START_TOLERANCE_SEC = 0.005
export const DURATION_PROBE_EOF_MARGIN_SEC = 0.1

export type DynamicDurationProbeErrorCode =
  'invalid-duration' | 'unsupported-duration' | 'decode-failed' | 'decode-inconsistent'

export class DynamicDurationProbeError extends Error {
  readonly code: DynamicDurationProbeErrorCode

  constructor(code: DynamicDurationProbeErrorCode, message: string) {
    super(message)
    this.name = 'DynamicDurationProbeError'
    this.code = code
  }
}

export type DurationProbeDecodedPcm = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  actualStartSec?: number
  error?: string
}

export type DynamicDurationProbeDeps = {
  decodeChunk: (
    filePath: string,
    startSec: number,
    maxDurationSec: number,
    sampleRate: number,
    channels: number
  ) => DurationProbeDecodedPcm
  probeMetadataDurationSec?: (filePath: string) => Promise<number | undefined>
}

const DURATION_PROBE_SAMPLE_RATE = 44100
const DURATION_PROBE_CHANNELS = 2

const roundSec = (value: number) => Number(value.toFixed(6))

const loadDefaultMetadataProbe = (): ((filePath: string) => Promise<number | undefined>) => {
  return async (filePath) => {
    try {
      const audioProbe = require('../services/keyAnalysis/audioProbe') as {
        probeAudioFile: (input: string) => Promise<{ durationSec?: number; error?: string }>
      }
      const probe = await audioProbe.probeAudioFile(filePath)
      if (probe.error) return undefined
      const durationSec = Number(probe.durationSec)
      return Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined
    } catch {
      return undefined
    }
  }
}

const loadDefaultDecodeChunk = (): DynamicDurationProbeDeps['decodeChunk'] => {
  return (filePath, startSec, maxDurationSec, sampleRate, channels) => {
    const binding = require('rust_package') as {
      decodeAudioFileNativePcm?: (
        filePath: string,
        startSec: number | null,
        maxDurationSec: number | null,
        sampleRate: number,
        channels: number
      ) => DurationProbeDecodedPcm
    }
    const decodeNative = binding.decodeAudioFileNativePcm
    if (typeof decodeNative !== 'function') {
      throw new DynamicDurationProbeError(
        'decode-failed',
        'decodeAudioFileNativePcm is unavailable in the native binding'
      )
    }
    return decodeNative(filePath, startSec, maxDurationSec, sampleRate, channels)
  }
}

const resolveCandidateSec = async (
  filePath: string,
  metadataDurationSec: number | undefined,
  probeMetadataDurationSec: ((filePath: string) => Promise<number | undefined>) | undefined
): Promise<number> => {
  const direct = Number(metadataDurationSec)
  if (Number.isFinite(direct) && direct > 0) return direct
  if (!probeMetadataDurationSec) return 0
  try {
    const probed = Number(await probeMetadataDurationSec(filePath))
    return Number.isFinite(probed) && probed > 0 ? probed : 0
  } catch {
    return 0
  }
}

export const probeDynamicGridAudioDuration = async (
  filePath: string,
  metadataDurationSec?: number,
  deps: Partial<DynamicDurationProbeDeps> = {}
): Promise<number> => {
  if (!filePath || !String(filePath).trim()) {
    throw new DynamicDurationProbeError('invalid-duration', 'filePath must not be empty')
  }
  const decodeChunk = deps.decodeChunk ?? loadDefaultDecodeChunk()
  const probeMetadataDurationSec = deps.probeMetadataDurationSec ?? loadDefaultMetadataProbe()

  const candidateSec = await resolveCandidateSec(
    filePath,
    metadataDurationSec,
    probeMetadataDurationSec
  )
  const probeStartSec = roundSec(Math.max(0, candidateSec - DURATION_PROBE_LOOKBACK_SEC))

  let decoded: DurationProbeDecodedPcm
  try {
    decoded = decodeChunk(
      filePath,
      probeStartSec,
      DURATION_PROBE_MAX_SEC,
      DURATION_PROBE_SAMPLE_RATE,
      DURATION_PROBE_CHANNELS
    )
  } catch (error) {
    if (error instanceof DynamicDurationProbeError) throw error
    throw new DynamicDurationProbeError(
      'decode-failed',
      error instanceof Error ? error.message : String(error)
    )
  }

  if (decoded.error) {
    throw new DynamicDurationProbeError('decode-failed', decoded.error)
  }
  if (!decoded.pcmData || decoded.pcmData.byteLength <= 0) {
    throw new DynamicDurationProbeError('invalid-duration', 'duration probe returned empty PCM')
  }
  if (
    decoded.sampleRate !== DURATION_PROBE_SAMPLE_RATE ||
    decoded.channels !== DURATION_PROBE_CHANNELS
  ) {
    throw new DynamicDurationProbeError(
      'decode-inconsistent',
      `duration probe returned ${decoded.sampleRate}Hz/${decoded.channels}ch`
    )
  }

  const totalFrames = Number(decoded.totalFrames)
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    throw new DynamicDurationProbeError('invalid-duration', 'duration probe returned no audio')
  }
  const framesFromPcm = decoded.pcmData.byteLength / 4 / DURATION_PROBE_CHANNELS
  if (Math.abs(framesFromPcm - totalFrames) > 1) {
    throw new DynamicDurationProbeError(
      'decode-inconsistent',
      `duration probe frame count mismatch (${totalFrames} vs ${framesFromPcm})`
    )
  }

  const actualStartSec = Number(decoded.actualStartSec)
  if (!Number.isFinite(actualStartSec)) {
    throw new DynamicDurationProbeError(
      'decode-inconsistent',
      'duration probe did not report actualStartSec; rebuild rust_package'
    )
  }
  if (Math.abs(actualStartSec - probeStartSec) > DURATION_PROBE_START_TOLERANCE_SEC) {
    throw new DynamicDurationProbeError(
      'decode-inconsistent',
      `duration probe started at ${actualStartSec.toFixed(6)}s, expected ${probeStartSec.toFixed(6)}s`
    )
  }

  const requestedFrames = Math.floor(DURATION_PROBE_MAX_SEC * DURATION_PROBE_SAMPLE_RATE)
  const eofMarginFrames = Math.ceil(DURATION_PROBE_EOF_MARGIN_SEC * DURATION_PROBE_SAMPLE_RATE)
  if (totalFrames >= requestedFrames - eofMarginFrames) {
    throw new DynamicDurationProbeError(
      'unsupported-duration',
      `duration probe hit the ${DURATION_PROBE_MAX_SEC}s cap; EOF was not observed`
    )
  }

  const durationSec = actualStartSec + totalFrames / DURATION_PROBE_SAMPLE_RATE
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new DynamicDurationProbeError(
      'invalid-duration',
      'duration probe resolved an invalid time'
    )
  }
  if (durationSec > probeStartSec + DURATION_PROBE_MAX_SEC + DURATION_PROBE_EOF_MARGIN_SEC) {
    throw new DynamicDurationProbeError(
      'decode-inconsistent',
      'duration probe resolved beyond its decoded window'
    )
  }
  return roundSec(durationSec)
}
