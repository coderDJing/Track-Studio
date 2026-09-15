import { describe, expect, it } from 'vitest'
import { getDeferredStructureGridDetail } from './workerPool'
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
