import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { createStageDiagnostics } from './stageDiagnostics'
import {
  getMainThreadActivitySnapshot,
  resetMainThreadActivityTraceForTests
} from './mainProcessActivityTraceState'

const mocks = vi.hoisted(() => ({ enabled: true, warn: vi.fn() }))
vi.mock('./rcDiagnosticEnvironment', () => ({ isPackagedRcMainProcess: () => mocks.enabled }))
vi.mock('../log', () => ({ log: { warn: mocks.warn } }))

beforeEach(() => {
  mocks.enabled = true
  mocks.warn.mockClear()
  vi.useFakeTimers()
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
})
afterEach(() => {
  resetMainThreadActivityTraceForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('stage diagnostics', () => {
  it('正常阶段不落盘，异常也不会留下 pending 活动', async () => {
    const diagnostics = createStageDiagnostics('metadata-auto-perf', { itemIndex: 2 })
    await expect(diagnostics.measure('read', async () => 42)).resolves.toBe(42)
    await expect(
      diagnostics.measure('write', async () => {
        throw new Error('failed')
      })
    ).rejects.toThrow('failed')
    expect(mocks.warn).not.toHaveBeenCalled()
    expect(getMainThreadActivitySnapshot(0).pendingTotal).toBe(0)
  })

  it('只有超阈值才记录阶段、同步属性和结果', async () => {
    const diagnostics = createStageDiagnostics('playlist-scan-perf', { songListUUID: 'list' })
    diagnostics.measureSync('snapshot-save', () => vi.advanceTimersByTime(801))
    await diagnostics.measure('network', async () => vi.advanceTimersByTime(4000), 15_000)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    expect(mocks.warn.mock.calls[0]).toEqual([
      '[playlist-scan-perf] slow stage',
      expect.objectContaining({
        songListUUID: 'list',
        stage: 'snapshot-save',
        synchronous: true,
        elapsedMs: 801,
        thresholdMs: 800,
        outcome: 'completed'
      })
    ])
  })

  it('禁用诊断时仍保留业务返回值，不跟踪也不落盘', async () => {
    mocks.enabled = false
    const diagnostics = createStageDiagnostics('test')
    expect(
      await diagnostics.measure('slow', async () => {
        vi.advanceTimersByTime(10_000)
        return 1
      })
    ).toBe(1)
    expect(mocks.warn).not.toHaveBeenCalled()
    expect(getMainThreadActivitySnapshot(0).slowest).toEqual([])
  })
})
