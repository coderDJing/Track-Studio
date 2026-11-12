import { describe, expect, it, vi } from 'vitest'
import { buildKeyAnalysisWorkerMessage } from './workerDispatch'
import { normalizePath, type KeyAnalysisJob } from './types'

vi.mock('../audioTimeBasisOffset', () => ({
  resolveAudioTimeBasisOffsetMsForFile: vi.fn(async () => 37)
}))

vi.mock('./dynamicGridAudioDuration', () => ({
  resolveDynamicGridAudioDurationSec: vi.fn(async (params: { probeDurationSec?: unknown }) => {
    const probed = Number(params.probeDurationSec)
    return Number.isFinite(probed) && probed > 0 ? probed : 240
  })
}))

const createJob = (overrides: Partial<KeyAnalysisJob> = {}): KeyAnalysisJob => ({
  jobId: 1,
  filePath: 'D:/music/track.mp3',
  normalizedPath: normalizePath('D:/music/track.mp3'),
  priority: 'medium',
  fastAnalysis: false,
  source: 'foreground',
  ...overrides
})

describe('buildKeyAnalysisWorkerMessage', () => {
  it('dispatches v23 structure analysis to a worker', async () => {
    const job = createJob({ needsBpm: false, needsStructure: true })

    await expect(buildKeyAnalysisWorkerMessage(job)).resolves.toMatchObject({
      needsStructure: true,
      analysisBpmRange: { id: '70-180', minBpm: 70, maxBpm: 180 }
    })
  })

  it('keeps the queued BPM range snapshot', async () => {
    const job = createJob({
      needsBpm: true,
      analysisBpmRange: { id: '88-175', minBpm: 88, maxBpm: 175 }
    })

    await expect(buildKeyAnalysisWorkerMessage(job)).resolves.toMatchObject({
      analysisBpmRange: { id: '88-175', minBpm: 88, maxBpm: 175 }
    })
  })

  it('passes the frozen grid mode to the worker', async () => {
    const job = createJob({ needsBpm: true, analysisGridMode: 'dynamic' })

    await expect(buildKeyAnalysisWorkerMessage(job)).resolves.toMatchObject({
      analysisGridMode: 'dynamic'
    })
  })

  it('prepares the time basis for dynamic BPM without structure', async () => {
    const job = createJob({
      needsBpm: true,
      needsStructure: false,
      analysisGridMode: 'dynamic'
    })

    await expect(buildKeyAnalysisWorkerMessage(job)).resolves.toMatchObject({
      analyzedTimeBasisOffsetMs: 37
    })
  })

  it('passes the probed audio duration and frozen audio identity for dynamic grids', async () => {
    const job = createJob({
      needsBpm: true,
      analysisGridMode: 'dynamic',
      probe: { durationSec: 200 },
      fileSize: 1024,
      fileMtimeMs: 1700000000000
    })

    await expect(buildKeyAnalysisWorkerMessage(job)).resolves.toMatchObject({
      audioDurationSec: 200,
      fileSize: 1024,
      fileMtimeMs: 1700000000000
    })
  })

  it('falls back to the dynamic duration probe when the queue probe is missing', async () => {
    const job = createJob({ needsBpm: true, analysisGridMode: 'dynamic' })

    await expect(buildKeyAnalysisWorkerMessage(job)).resolves.toMatchObject({
      audioDurationSec: 240
    })
  })

  it('does not resolve audio duration for normal BPM-only jobs', async () => {
    const job = createJob({ needsBpm: true, analysisGridMode: 'normal' })

    await expect(buildKeyAnalysisWorkerMessage(job)).resolves.toMatchObject({
      audioDurationSec: undefined,
      analyzedTimeBasisOffsetMs: undefined
    })
  })
})
