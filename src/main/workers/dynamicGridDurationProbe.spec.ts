import { describe, expect, it, vi } from 'vitest'
import {
  DURATION_PROBE_LOOKBACK_SEC,
  DURATION_PROBE_MAX_SEC,
  DynamicDurationProbeError,
  probeDynamicGridAudioDuration,
  type DurationProbeDecodedPcm
} from './dynamicGridDurationProbe'

const SAMPLE_RATE = 44100
const CHANNELS = 2

const buildDecoded = (params: {
  startSec: number
  durationSec: number
  actualStartSec?: number
  sampleRate?: number
  channels?: number
  error?: string
  emptyPcm?: boolean
}): DurationProbeDecodedPcm => {
  const sampleRate = params.sampleRate ?? SAMPLE_RATE
  const channels = params.channels ?? CHANNELS
  const frames = Math.floor(params.durationSec * sampleRate)
  return {
    pcmData: params.emptyPcm ? Buffer.alloc(0) : Buffer.alloc(frames * channels * 4),
    sampleRate,
    channels,
    totalFrames: frames,
    actualStartSec: params.actualStartSec ?? params.startSec,
    error: params.error
  }
}

const expectProbeCode = async (promise: Promise<number>, code: string) => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(DynamicDurationProbeError)
    expect((error as DynamicDurationProbeError).code).toBe(code)
    return
  }
  throw new Error(`expected probe error ${code}`)
}

describe('probeDynamicGridAudioDuration', () => {
  it('uses a 132s audio duration from a 134s container duration with a 2s start offset', async () => {
    const decodeChunk = vi.fn(() => buildDecoded({ startSec: 104, durationSec: 28 }))
    const probeMetadataDurationSec = vi.fn(async () => 134)

    await expect(
      probeDynamicGridAudioDuration('fixture-offset.mka', 134, {
        decodeChunk,
        probeMetadataDurationSec
      })
    ).resolves.toBe(132)

    expect(decodeChunk).toHaveBeenCalledTimes(1)
    expect(decodeChunk).toHaveBeenCalledWith(
      'fixture-offset.mka',
      134 - DURATION_PROBE_LOOKBACK_SEC,
      DURATION_PROBE_MAX_SEC,
      SAMPLE_RATE,
      CHANNELS
    )
    expect(probeMetadataDurationSec).not.toHaveBeenCalled()
  })

  it('finds EOF for underestimated metadata inside the bounded tail window', async () => {
    const decodeChunk = vi.fn(() => buildDecoded({ startSec: 90, durationSec: 42 }))

    await expect(
      probeDynamicGridAudioDuration('underestimated.mka', 120, { decodeChunk })
    ).resolves.toBe(132)
    expect(decodeChunk).toHaveBeenCalledWith(
      'underestimated.mka',
      90,
      DURATION_PROBE_MAX_SEC,
      SAMPLE_RATE,
      CHANNELS
    )
  })

  it('falls back to metadata probing only when no candidate is supplied', async () => {
    const decodeChunk = vi.fn(() => buildDecoded({ startSec: 0, durationSec: 10 }))
    const probeMetadataDurationSec = vi.fn(async () => 10)

    await expect(
      probeDynamicGridAudioDuration('short.wav', undefined, {
        decodeChunk,
        probeMetadataDurationSec
      })
    ).resolves.toBe(10)
    expect(probeMetadataDurationSec).toHaveBeenCalledWith('short.wav')
  })

  it('rejects a window that hits the 60s cap instead of guessing a duration', async () => {
    const decodeChunk = vi.fn(() =>
      buildDecoded({ startSec: 104, durationSec: DURATION_PROBE_MAX_SEC })
    )

    await expectProbeCode(
      probeDynamicGridAudioDuration('long.mka', 134, { decodeChunk }),
      'unsupported-duration'
    )
  })

  it('rejects native decode errors', async () => {
    const decodeChunk = vi.fn(() =>
      buildDecoded({ startSec: 104, durationSec: 0, error: 'native failed' })
    )

    await expectProbeCode(
      probeDynamicGridAudioDuration('broken.mka', 134, { decodeChunk }),
      'decode-failed'
    )
  })

  it('rejects an empty EOF result', async () => {
    const decodeChunk = vi.fn(() => buildDecoded({ startSec: 104, durationSec: 0, emptyPcm: true }))

    await expectProbeCode(
      probeDynamicGridAudioDuration('empty.mka', 134, { decodeChunk }),
      'invalid-duration'
    )
  })

  it('rejects an old native binding without actualStartSec', async () => {
    const decodeChunk = vi.fn(() => {
      const decoded = buildDecoded({ startSec: 104, durationSec: 28 })
      delete decoded.actualStartSec
      return decoded
    })

    await expectProbeCode(
      probeDynamicGridAudioDuration('old.mka', 134, { decodeChunk }),
      'decode-inconsistent'
    )
  })

  it('rejects a probe whose actual start is not the requested tail window', async () => {
    const decodeChunk = vi.fn(() =>
      buildDecoded({ startSec: 104, actualStartSec: 105, durationSec: 27 })
    )

    await expectProbeCode(
      probeDynamicGridAudioDuration('offset.mka', 134, { decodeChunk }),
      'decode-inconsistent'
    )
  })

  it('performs exactly one bounded tail decode and never decodes the whole track', async () => {
    const decodeChunk = vi.fn(() => buildDecoded({ startSec: 60, durationSec: 12 }))

    await probeDynamicGridAudioDuration('bounded.mka', 90, { decodeChunk })

    expect(decodeChunk).toHaveBeenCalledTimes(1)
    const call = decodeChunk.mock.calls[0] as unknown as [string, number, number, number, number]
    expect(call[1]).toBe(60)
    expect(call[2]).toBe(DURATION_PROBE_MAX_SEC)
    expect(call[2]).not.toBeNull()
  })
})
