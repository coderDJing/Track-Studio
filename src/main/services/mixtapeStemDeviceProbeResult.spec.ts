// Run: pnpm exec vitest run src/main/services/mixtapeStemDeviceProbeResult.spec.ts
import { describe, expect, it } from 'vitest'
import {
  STEM_DEVICE_PROBE_CACHE_TTL_MS,
  STEM_DEVICE_PROBE_NEGATIVE_CACHE_TTL_MS,
  parseDemucsDeviceProbeOutput,
  resolveStemDeviceProbeCacheTtlMs
} from './mixtapeStemDeviceProbeResult'

describe('parseDemucsDeviceProbeOutput', () => {
  it('keeps the runtime usable when a GPU query throws after a successful torch import', () => {
    const parsed = parseDemucsDeviceProbeOutput(
      {
        status: 0,
        timedOut: false,
        stdout: [
          JSON.stringify({ stage: 'import', import_ok: true, torch_version: '2.10.0+xpu' }),
          JSON.stringify({
            stage: 'final',
            import_ok: true,
            torch_version: '2.10.0+xpu',
            cuda: false,
            xpu: false,
            xpu_error: 'XPU enumeration failed'
          })
        ].join('\n'),
        stderr: ''
      },
      60_000
    )
    expect(parsed).toMatchObject({
      runtimeUsable: true,
      importOk: true,
      probeInconclusive: false,
      xpuAvailable: false,
      deviceError: 'XPU enumeration failed',
      importError: ''
    })
  })

  it('treats a real torch import failure as unusable, not just a missing download target', () => {
    const parsed = parseDemucsDeviceProbeOutput(
      {
        status: 0,
        timedOut: false,
        stdout: [
          JSON.stringify({
            stage: 'import',
            import_ok: false,
            import_error: 'No module named torch'
          }),
          JSON.stringify({
            stage: 'final',
            import_ok: false,
            import_error: 'No module named torch'
          })
        ].join('\n'),
        stderr: ''
      },
      60_000
    )
    expect(parsed).toMatchObject({
      runtimeUsable: false,
      importOk: false,
      probeInconclusive: false,
      importError: 'No module named torch'
    })
  })

  it('uses a flushed import stage when the process times out during GPU enumeration', () => {
    const parsed = parseDemucsDeviceProbeOutput(
      {
        status: null,
        timedOut: true,
        stdout: JSON.stringify({
          stage: 'import',
          import_ok: true,
          torch_version: '2.10.0+xpu'
        }),
        stderr: ''
      },
      60_000
    )
    expect(parsed).toMatchObject({
      runtimeUsable: true,
      importOk: true,
      probeInconclusive: false,
      torchVersion: '2.10.0+xpu',
      probeError: 'probe timed out after 60000ms'
    })
  })

  it('marks a timeout with no import result as inconclusive instead of a definite import failure', () => {
    const parsed = parseDemucsDeviceProbeOutput(
      {
        status: null,
        timedOut: true,
        stdout: '',
        stderr: 'killed'
      },
      60_000
    )
    expect(parsed).toMatchObject({
      runtimeUsable: false,
      importOk: false,
      probeInconclusive: true,
      probeError: 'probe timed out after 60000ms'
    })
  })
})

describe('resolveStemDeviceProbeCacheTtlMs', () => {
  it('caches a healthy runtime, short-caches a definite import failure, and does not cache inconclusive probes', () => {
    expect(resolveStemDeviceProbeCacheTtlMs({ runtimeUsable: true })).toBe(
      STEM_DEVICE_PROBE_CACHE_TTL_MS
    )
    expect(
      resolveStemDeviceProbeCacheTtlMs({ runtimeUsable: false, probeInconclusive: false })
    ).toBe(STEM_DEVICE_PROBE_NEGATIVE_CACHE_TTL_MS)
    expect(
      resolveStemDeviceProbeCacheTtlMs({ runtimeUsable: false, probeInconclusive: true })
    ).toBe(0)
  })
})
