import { describe, expect, it, vi } from 'vitest'
import { terminateWorkerWithDynamicSidecarCleanup } from './workerTermination'

const createWorker = (terminate: () => Promise<unknown>) => ({ terminate })

describe('terminateWorkerWithDynamicSidecarCleanup', () => {
  it('cleans the sidecar before and after a successful terminate', async () => {
    const sequence: string[] = []
    const worker = createWorker(async () => {
      sequence.push('terminate')
      return 0
    })
    const cleanup = vi.fn(() => sequence.push('cleanup'))
    const onSettled = vi.fn()

    await expect(
      terminateWorkerWithDynamicSidecarCleanup(worker, cleanup, onSettled)
    ).resolves.toBe(0)
    expect(sequence).toEqual(['cleanup', 'terminate', 'cleanup'])
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('cleans again and keeps the swallowed-error semantics when terminate fails', async () => {
    const worker = createWorker(async () => {
      throw new Error('worker already gone')
    })
    const cleanup = vi.fn()
    const onSettled = vi.fn()

    await expect(
      terminateWorkerWithDynamicSidecarCleanup(worker, cleanup, onSettled)
    ).resolves.toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})
