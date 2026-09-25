import { describe, expect, it } from 'vitest'
import { collectKeyAnalysisJobResultErrors, getDeferredStructureGridDetail } from './workerPool'
import { normalizePath, type KeyAnalysisJob } from './types'

const createStructureJob = (): KeyAnalysisJob => ({
  jobId: 1,
  filePath: 'D:/music/grid-pending.mp3',
  normalizedPath: normalizePath('D:/music/grid-pending.mp3'),
  priority: 'background',
  fastAnalysis: false,
  source: 'background',
  needsStructure: true
})

describe('key analysis structure result handling', () => {
  it('将本轮缺少 v2 网格标记为后台补算，而不是前台失败', () => {
    expect(
      getDeferredStructureGridDetail(createStructureJob(), {
        songStructureError: 'missing v2 beat grid for v23 structure analysis'
      })
    ).toBe('structure: missing v2 beat grid for v23 structure analysis')
  })

  it('保留真正的 worker 或其它结构错误', () => {
    expect(
      getDeferredStructureGridDetail(createStructureJob(), {
        songStructureError: 'missing unified waveform for v23 structure analysis'
      })
    ).toBeNull()
    expect(
      getDeferredStructureGridDetail(
        createStructureJob(),
        { songStructureError: 'missing v2 beat grid for v23 structure analysis' },
        'worker crashed'
      )
    ).toBeNull()
  })
})

describe('key analysis energy result handling', () => {
  const energyJob = { ...createStructureJob(), needsStructure: false, needsEnergy: true }

  it('无有效 BPM 时不把依赖项能量计为另一项失败', () => {
    expect(
      collectKeyAnalysisJobResultErrors(energyJob, {
        bpmError: 'no valid Beat-This result'
      })
    ).toEqual([])
    expect(
      collectKeyAnalysisJobResultErrors(energyJob, { bpmError: 'Beat This runtime failed' })
    ).toEqual(['bpm: Beat This runtime failed'])
  })

  it('有效节拍网格下仍报告能量模型失败', () => {
    expect(collectKeyAnalysisJobResultErrors(energyJob, { energyError: 'model failed' })).toEqual([
      'energy: model failed'
    ])
  })
})
