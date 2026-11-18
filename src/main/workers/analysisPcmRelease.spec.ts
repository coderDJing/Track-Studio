import { describe, expect, it, vi } from 'vitest'
import {
  BEAT_GRID_ANALYSIS_CHANNELS,
  BEAT_GRID_ANALYSIS_MAX_SCAN_SEC,
  BEAT_GRID_ANALYSIS_SAMPLE_RATE,
  canReuseDecodedPcmForBeatGrid,
  releaseAnalysisPcm,
  requestAnalysisMemoryReclaim,
  sliceBeatGridPcmFromDecoded
} from './analysisPcmRelease'

describe('analysisPcmRelease', () => {
  it('drops the holder reference without mutating an unrelated buffer', () => {
    const pcmData = Buffer.alloc(1024, 7)
    const holder = { pcmData }
    expect(releaseAnalysisPcm(holder)).toBeNull()
    expect(holder.pcmData.byteLength).toBe(0)
    expect(pcmData.byteLength).toBe(1024)
    expect(pcmData[0]).toBe(7)
    expect(releaseAnalysisPcm(null)).toBeNull()
    expect(releaseAnalysisPcm(undefined)).toBeNull()
  })

  it('can release a beat-grid slice without clearing the parent full-track buffer', () => {
    const frameStride = BEAT_GRID_ANALYSIS_CHANNELS * 4
    const fullBytes =
      (BEAT_GRID_ANALYSIS_MAX_SCAN_SEC + 30) * BEAT_GRID_ANALYSIS_SAMPLE_RATE * frameStride
    const pcmData = Buffer.alloc(fullBytes, 3)
    const decoded = {
      pcmData,
      sampleRate: BEAT_GRID_ANALYSIS_SAMPLE_RATE,
      channels: BEAT_GRID_ANALYSIS_CHANNELS,
      decoderBackend: 'rust'
    }
    const sliced = sliceBeatGridPcmFromDecoded(decoded)
    expect(sliced).not.toBeNull()
    expect(sliced?.pcmData.byteLength).toBe(
      BEAT_GRID_ANALYSIS_MAX_SCAN_SEC * BEAT_GRID_ANALYSIS_SAMPLE_RATE * frameStride
    )
    expect(sliced?.pcmData.buffer).toBe(pcmData.buffer)
    expect(releaseAnalysisPcm(sliced)).toBeNull()
    expect(sliced?.pcmData.byteLength).toBe(0)
    expect(decoded.pcmData.byteLength).toBe(fullBytes)
    expect(decoded.pcmData[0]).toBe(3)
  })

  it('does not reuse decoded PCM at a different rate or channel count', () => {
    expect(
      canReuseDecodedPcmForBeatGrid({
        pcmData: Buffer.alloc(16),
        sampleRate: 48000,
        channels: 2
      })
    ).toBe(false)
    expect(
      canReuseDecodedPcmForBeatGrid({
        pcmData: Buffer.alloc(16),
        sampleRate: BEAT_GRID_ANALYSIS_SAMPLE_RATE,
        channels: 1
      })
    ).toBe(false)
    expect(
      sliceBeatGridPcmFromDecoded({
        pcmData: Buffer.alloc(16),
        sampleRate: 48000,
        channels: 2
      })
    ).toBeNull()
  })

  it('invokes an available global gc hook when reclaiming', () => {
    const gc = vi.fn()
    const previous = (globalThis as { gc?: () => void }).gc
    ;(globalThis as { gc?: () => void }).gc = gc
    try {
      requestAnalysisMemoryReclaim()
      expect(gc).toHaveBeenCalledTimes(1)
    } finally {
      if (previous) {
        ;(globalThis as { gc?: () => void }).gc = previous
      } else {
        delete (globalThis as { gc?: () => void }).gc
      }
    }
  })
})
