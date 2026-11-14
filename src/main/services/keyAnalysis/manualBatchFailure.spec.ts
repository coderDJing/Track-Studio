// Run: pnpm exec vitest run src/main/services/keyAnalysis/manualBatchFailure.spec.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../log', () => ({ log: { error: vi.fn() } }))
vi.mock('../../libraryCacheDb', () => ({}))
vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false, macOS: false, windows: true, linux: false },
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcut: vi.fn() },
  platform: { isWindows: true, isMacOS: false, isLinux: false }
}))
vi.mock('../libraryMerge/mutationGate', () => ({ isLibraryMergeMutationLocked: () => false }))
vi.mock('./queue', () => ({
  KeyAnalysisQueue: class {
    enqueueList = vi.fn()
    setGlobalConcurrency = vi.fn()
    hasTrackedPath = () => true
  }
}))

import { enqueueManualKeyAnalysisBatch, keyAnalysisEvents } from '../keyAnalysisQueue'

const runBatch = (
  files: string[],
  emit: (filePath: string, batchId: string) => void
): Record<string, unknown> => {
  const ended: Array<Record<string, unknown>> = []
  const onEnd = (payload: Record<string, unknown>) => ended.push(payload)
  keyAnalysisEvents.on('manual-batch-end', onEnd)
  const { batchId } = enqueueManualKeyAnalysisBatch(files)
  for (const filePath of files) emit(filePath, batchId)
  keyAnalysisEvents.off('manual-batch-end', onEnd)
  expect(ended).toHaveLength(1)
  return ended[0]
}

describe('manual batch failure accounting', () => {
  it('全部成功时失败数为 0，界面无需汇总', () => {
    const end = runBatch(['D:/mb-ok/1.wav', 'D:/mb-ok/2.wav'], (filePath, batchId) => {
      keyAnalysisEvents.emit('analysis-stage-update', {
        filePath,
        stage: 'job-done',
        manualBatchIds: [batchId]
      })
    })
    expect(end).toMatchObject({ canceled: false, total: 2, failed: 0, failedItems: [] })
  })

  it('只有主进程标记过的真失败才计数，并带出首个原因', () => {
    const end = runBatch(
      ['D:/mb-fail/1.wav', 'D:/mb-fail/2.wav', 'D:/mb-fail/3.wav'],
      (filePath, batchId) => {
        const failed = filePath.endsWith('2.wav')
        keyAnalysisEvents.emit('analysis-stage-update', {
          filePath,
          stage: failed ? 'job-error' : 'job-done',
          manualBatchIds: [batchId],
          ...(failed
            ? { manualBatchFailed: true, manualBatchFailureDetail: 'bpm: runtime not available' }
            : {})
        })
      }
    )
    expect(end).toMatchObject({ canceled: false, total: 3, failed: 1 })
    expect(end.failedItems).toEqual([
      { filePath: expect.stringContaining('2.wav'), detail: 'bpm: runtime not available' }
    ])
  })

  it('结果作废等 job-error 不计入失败', () => {
    const end = runBatch(['D:/mb-stale/1.wav'], (filePath, batchId) => {
      keyAnalysisEvents.emit('analysis-stage-update', {
        filePath,
        stage: 'job-error',
        manualBatchIds: [batchId]
      })
    })
    expect(end).toMatchObject({ failed: 0, failedItems: [] })
  })
})
