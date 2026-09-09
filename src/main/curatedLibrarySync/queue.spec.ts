import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CuratedLibrarySyncStartResult } from '../../shared/curatedLibrarySync'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  complete: vi.fn()
}))

vi.mock('./engine', () => ({
  runCuratedLibrarySync: mocks.run,
  completeCuratedLibrarySyncStatus: mocks.complete
}))

const deferred = () => {
  let resolve: (value: CuratedLibrarySyncStartResult) => void = () => undefined
  const promise = new Promise<CuratedLibrarySyncStartResult>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('curated library sync queue', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.run.mockReset()
    mocks.complete.mockReset()
  })

  it('让手动触发复用正在执行的自动同步', async () => {
    const active = deferred()
    mocks.run.mockReturnValueOnce(active.promise)
    const { enqueueCuratedLibrarySync } = await import('./queue')

    const automatic = enqueueCuratedLibrarySync({ trigger: 'scheduled' })
    await flushPromises()
    const manual = enqueueCuratedLibrarySync({ trigger: 'manual', allowWhenDisabled: true })

    expect(manual).toBe(automatic)
    expect(mocks.run).toHaveBeenCalledTimes(1)

    active.resolve({ status: 'success' })
    await manual
    expect(mocks.complete).toHaveBeenCalledWith({ status: 'success' })
  })

  it('把手动同步期间的多个自动触发合并为一次后续同步', async () => {
    const manualRun = deferred()
    const automaticRun = deferred()
    mocks.run.mockReturnValueOnce(manualRun.promise).mockReturnValueOnce(automaticRun.promise)
    const { enqueueCuratedLibrarySync } = await import('./queue')

    const manual = enqueueCuratedLibrarySync({ trigger: 'manual', allowWhenDisabled: true })
    await flushPromises()
    expect(enqueueCuratedLibrarySync({ trigger: 'scheduled' })).toBe(manual)
    expect(enqueueCuratedLibrarySync({ trigger: 'realtime' })).toBe(manual)

    manualRun.resolve({ status: 'success' })
    await manual
    await flushPromises()

    expect(mocks.run).toHaveBeenCalledTimes(2)
    expect(mocks.run).toHaveBeenLastCalledWith({ trigger: 'realtime' })

    automaticRun.resolve({ status: 'success' })
    await flushPromises()
  })
})
