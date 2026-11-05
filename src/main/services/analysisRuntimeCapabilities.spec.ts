// Run: pnpm exec vitest run src/main/services/analysisRuntimeCapabilities.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ probe: vi.fn(), bpmWorker: vi.fn() }))
vi.mock('../ffmpeg', () => ({ resolveBundledFfmpegPath: () => 'ffmpeg' }))
vi.mock('./mixtapeStemSeparationShared', () => ({
  buildStemProcessEnv: () => ({}),
  runProbeProcess: mocks.probe
}))
vi.mock('./bpmFixProcess', () => ({ resolveBpmFixRuntime: mocks.bpmWorker }))
import {
  clearAnalysisRuntimeCapabilityCache,
  hasAnalysisRuntimeFeatureSupport
} from './analysisRuntimeCapabilities'

beforeEach(() => {
  vi.clearAllMocks()
  clearAnalysisRuntimeCapabilityCache()
  mocks.probe.mockResolvedValue({ timedOut: false, status: 0 })
  mocks.bpmWorker.mockResolvedValue({ command: 'selected-runtime' })
})

describe('feature-specific runtime probes', () => {
  it('shares the common analysis probe and separately checks Stem dependencies', async () => {
    expect(await hasAnalysisRuntimeFeatureSupport('analysis', 'python', 'runtime')).toBe(true)
    expect(await hasAnalysisRuntimeFeatureSupport('horizontal', 'python', 'runtime')).toBe(true)
    expect(mocks.probe).toHaveBeenCalledTimes(1)
    expect(await hasAnalysisRuntimeFeatureSupport('stem', 'python', 'runtime')).toBe(true)
    expect(mocks.probe).toHaveBeenCalledTimes(2)
    expect(mocks.probe.mock.calls[1][0].args[1]).toContain('import demucs')
  })

  it('uses the actual BPM worker resolution, including its full bootstrap check', async () => {
    mocks.bpmWorker.mockRejectedValue(new Error('BPM_FIX_LIBROSA_UNAVAILABLE'))
    expect(await hasAnalysisRuntimeFeatureSupport('bpm-fix', 'python', 'runtime')).toBe(false)
    expect(mocks.bpmWorker).toHaveBeenCalledOnce()
    expect(mocks.probe).not.toHaveBeenCalled()
    clearAnalysisRuntimeCapabilityCache()
    mocks.bpmWorker.mockResolvedValue({ command: 'selected-runtime' })
    expect(await hasAnalysisRuntimeFeatureSupport('bpm-fix', 'python', 'runtime')).toBe(true)
  })
})
