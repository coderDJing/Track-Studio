import { describe, expect, it } from 'vitest'
import {
  analyzeBeatWindowsWithBeatThisFromPcm,
  createBeatThisWindowSession
} from './beatThisAnalyzer'
import type { DynamicBeatWindowEvidence } from '../../shared/dynamicBeatGridTypes'
import {
  BEAT_WINDOW_PROTOCOL_VERSION,
  DOWNBEAT_MATCH_TOLERANCE_SEC,
  MAX_BEATS_PER_WINDOW,
  normalizeBeatWindowResponse,
  normalizeWindowRequest,
  resolveWindowRequestTimeoutMs,
  WINDOW_REQUEST_BASE_TIMEOUT_MS,
  WINDOW_REQUEST_MAX_TIMEOUT_MS,
  WINDOW_REQUEST_PER_WINDOW_TIMEOUT_MS,
  type BeatWindowRequestWindow
} from './beatThisWindowProtocol'

const requestedWindows: BeatWindowRequestWindow[] = [
  { windowId: 'w0', localStartSec: 0, durationSec: 30 },
  { windowId: 'w1', localStartSec: 15, durationSec: 30 }
]

const serialize = (windows: DynamicBeatWindowEvidence[]) =>
  windows.map((window) => ({
    windowId: window.windowId,
    startAudioSec: window.startAudioSec,
    analyzedDurationSec: window.analyzedDurationSec,
    status: window.status,
    beatsAudioSec: window.beatsAudioSec,
    downbeatsAudioSec: window.downbeatsAudioSec
  }))

type TestWindowEvidence = {
  windowId: string
  startAudioSec: number
  analyzedDurationSec: number
  status: string
  beatsAudioSec: number[]
  downbeatsAudioSec: number[]
}

type TestResponse = {
  type: string
  protocolVersion: number
  requestId: string
  windows: TestWindowEvidence[]
}

const buildResponse = (overrides: Partial<TestResponse> = {}): TestResponse => ({
  type: 'beat-windows-result',
  protocolVersion: BEAT_WINDOW_PROTOCOL_VERSION,
  requestId: 'req-1',
  windows: [
    {
      windowId: 'w0',
      startAudioSec: 105,
      analyzedDurationSec: 30,
      status: 'ok',
      beatsAudioSec: [105.5, 106],
      downbeatsAudioSec: [105.5]
    },
    {
      windowId: 'w1',
      startAudioSec: 120,
      analyzedDurationSec: 30,
      status: 'ok',
      beatsAudioSec: [120.5, 121],
      downbeatsAudioSec: [120.5]
    }
  ],
  ...overrides
})

const expected = {
  requestId: 'req-1',
  chunkStartAudioSec: 105,
  windows: requestedWindows
}

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error & { code?: string }).code).toBe(code)
    return
  }
  throw new Error(`expected protocol error ${code}`)
}

describe('dynamic beat-window protocol normalization', () => {
  it('exports the one-shot bridge API and session factory', () => {
    expect(typeof analyzeBeatWindowsWithBeatThisFromPcm).toBe('function')
    expect(typeof createBeatThisWindowSession).toBe('function')
  })

  it('accepts a well-formed response and orders windows by request order', () => {
    const response = buildResponse()
    response.windows = [response.windows[1], response.windows[0]]

    const normalized = normalizeBeatWindowResponse(response, expected)

    expect(serialize(normalized)).toEqual([
      {
        windowId: 'w0',
        startAudioSec: 105,
        analyzedDurationSec: 30,
        status: 'ok',
        beatsAudioSec: [105.5, 106],
        downbeatsAudioSec: [105.5]
      },
      {
        windowId: 'w1',
        startAudioSec: 120,
        analyzedDurationSec: 30,
        status: 'ok',
        beatsAudioSec: [120.5, 121],
        downbeatsAudioSec: [120.5]
      }
    ])
  })

  it('rejects a protocol version mismatch instead of accepting legacy payloads', () => {
    expectCode(
      () => normalizeBeatWindowResponse(buildResponse({ protocolVersion: 2 }), expected),
      'protocol-version-mismatch'
    )
  })

  it('rejects a request id mismatch', () => {
    expectCode(
      () => normalizeBeatWindowResponse(buildResponse({ requestId: 'other' }), expected),
      'request-mismatch'
    )
  })

  it('rejects an unexpected response type', () => {
    expectCode(
      () => normalizeBeatWindowResponse(buildResponse({ type: 'result' }), expected),
      'malformed-response'
    )
  })

  it('rejects duplicate window ids', () => {
    const response = buildResponse()
    response.windows = [response.windows[0], response.windows[0]]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'malformed-response')
  })

  it('rejects unknown window ids and count mismatches', () => {
    const unknown = buildResponse()
    unknown.windows = [unknown.windows[0], { ...unknown.windows[1], windowId: 'nope' }]
    expectCode(() => normalizeBeatWindowResponse(unknown, expected), 'request-mismatch')

    expectCode(
      () => normalizeBeatWindowResponse(buildResponse({ windows: [] }), expected),
      'request-mismatch'
    )
  })

  it('rejects a double-applied absolute offset', () => {
    const response = buildResponse()
    response.windows = [{ ...response.windows[0], startAudioSec: 120 }, response.windows[1]]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'request-mismatch')
  })

  it('rejects non-monotonic beats', () => {
    const response = buildResponse()
    response.windows = [
      { ...response.windows[0], beatsAudioSec: [106, 105.5], downbeatsAudioSec: [] },
      response.windows[1]
    ]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'malformed-response')
  })

  it('rejects beats that collapse after microsecond rounding', () => {
    const response = buildResponse()
    response.windows = [
      {
        ...response.windows[0],
        beatsAudioSec: [105.5000001, 105.5000002],
        downbeatsAudioSec: []
      },
      response.windows[1]
    ]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'malformed-response')
  })

  it('rejects two downbeats matching the same beat', () => {
    const response = buildResponse()
    response.windows = [
      {
        ...response.windows[0],
        beatsAudioSec: [105.5, 106.5],
        downbeatsAudioSec: [105.5, 105.51]
      },
      response.windows[1]
    ]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'malformed-response')
  })

  it('uses the task A policy downbeat tolerance as the single source', () => {
    expect(DOWNBEAT_MATCH_TOLERANCE_SEC).toBe(0.03)
  })

  it('rejects beats outside the analyzed window', () => {
    const response = buildResponse()
    response.windows = [
      { ...response.windows[0], beatsAudioSec: [140], downbeatsAudioSec: [] },
      response.windows[1]
    ]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'malformed-response')
  })

  it('rejects no-beats windows that carry beats', () => {
    const response = buildResponse()
    response.windows = [{ ...response.windows[0], status: 'no-beats' }, response.windows[1]]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'malformed-response')
  })

  it('rejects ok windows without beats', () => {
    const response = buildResponse()
    response.windows = [
      { ...response.windows[0], beatsAudioSec: [], downbeatsAudioSec: [] },
      response.windows[1]
    ]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'malformed-response')
  })

  it('rejects downbeats that do not match any beat', () => {
    const response = buildResponse()
    response.windows = [{ ...response.windows[0], downbeatsAudioSec: [107] }, response.windows[1]]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'malformed-response')
  })

  it('rejects arrays beyond the protocol limit', () => {
    const response = buildResponse()
    response.windows = [
      {
        ...response.windows[0],
        beatsAudioSec: Array.from(
          { length: MAX_BEATS_PER_WINDOW + 1 },
          (_, index) => 105 + index * 0.01
        ),
        downbeatsAudioSec: []
      },
      response.windows[1]
    ]
    expectCode(() => normalizeBeatWindowResponse(response, expected), 'malformed-response')
  })
})

describe('dynamic beat-window request normalization', () => {
  const base = {
    pcmData: Buffer.alloc(120 * 8000 * 2 * 4),
    sampleRate: 8000,
    channels: 2,
    chunkStartAudioSec: 0,
    windows: [{ windowId: 'w0', localStartSec: 0, durationSec: 30 }]
  }

  it('accepts a bounded request and reports the decoded chunk duration', () => {
    const normalized = normalizeWindowRequest(base)
    expect(normalized.chunkDurationSec).toBeCloseTo(120, 6)
    expect(normalized.windows).toEqual(base.windows)
  })

  it('rejects windows shorter than the inference floor', () => {
    expectCode(
      () =>
        normalizeWindowRequest({
          ...base,
          windows: [{ windowId: 'w0', localStartSec: 0, durationSec: 7.9 }]
        }),
      'invalid-request'
    )
  })

  it('rejects windows that exceed the decoded chunk', () => {
    expectCode(
      () =>
        normalizeWindowRequest({
          ...base,
          windows: [{ windowId: 'w0', localStartSec: 100, durationSec: 30 }]
        }),
      'invalid-request'
    )
  })

  it('rejects duplicate window ids', () => {
    expectCode(
      () =>
        normalizeWindowRequest({
          ...base,
          windows: [
            { windowId: 'w0', localStartSec: 0, durationSec: 10 },
            { windowId: 'w0', localStartSec: 10, durationSec: 10 }
          ]
        }),
      'invalid-request'
    )
  })

  it('rejects misaligned PCM buffers', () => {
    expectCode(
      () =>
        normalizeWindowRequest({
          ...base,
          pcmData: Buffer.alloc(base.pcmData.byteLength + 1)
        }),
      'invalid-request'
    )
  })

  it('rejects empty PCM and non-finite offsets', () => {
    expectCode(
      () => normalizeWindowRequest({ ...base, pcmData: Buffer.alloc(0) }),
      'invalid-request'
    )
    expectCode(
      () => normalizeWindowRequest({ ...base, chunkStartAudioSec: Number.NaN }),
      'invalid-request'
    )
  })
})

describe('dynamic beat-window request timeout budget', () => {
  it('scales with window count and stays bounded', () => {
    expect(resolveWindowRequestTimeoutMs(0)).toBe(WINDOW_REQUEST_BASE_TIMEOUT_MS)
    expect(resolveWindowRequestTimeoutMs(2)).toBe(
      WINDOW_REQUEST_BASE_TIMEOUT_MS + 2 * WINDOW_REQUEST_PER_WINDOW_TIMEOUT_MS
    )
    expect(resolveWindowRequestTimeoutMs(10_000)).toBe(WINDOW_REQUEST_MAX_TIMEOUT_MS)
  })

  it('clamps an explicit timeout to the configured ceiling', () => {
    expect(resolveWindowRequestTimeoutMs(1, 1_000)).toBe(1_000)
    expect(resolveWindowRequestTimeoutMs(1, WINDOW_REQUEST_MAX_TIMEOUT_MS * 10)).toBe(
      WINDOW_REQUEST_MAX_TIMEOUT_MS
    )
  })
})
