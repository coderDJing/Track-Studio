import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../log', () => ({
  log: { error: () => {} }
}))

import {
  acquireLibraryMergeLockAfterMaintenanceIdle,
  deferLibraryMaintenanceAfterMergeLockReleased,
  drainDeferredLibraryMaintenance,
  getDeferredLibraryMaintenanceCount,
  isLibraryMergeMutationLocked,
  resetLibraryMergeMutationGateForTests,
  tryBeginLibraryMaintenanceMutation
} from './mutationGate'

/**
 * 锁住「库写收尾与合并互斥」这两条不变量：
 *  1. 收尾登记成功时，合并必须等它退出才上锁（不再出现并发写缓存）；
 *  2. 收尾拿不到名额时必须能被合并释放后补跑（不再被静默丢弃）。
 * 另外锁住「并发获取合并锁」的安全边界：同一时刻只能有一个持有者，失败或过期的释放
 * 不能把仍在执行的合并解锁。
 */
describe('libraryMerge mutationGate', () => {
  beforeEach(() => {
    resetLibraryMergeMutationGateForTests()
  })

  it('未锁定时可以登记收尾，登记期间合并不分辨率', async () => {
    const release = tryBeginLibraryMaintenanceMutation()
    expect(release).toBeTypeOf('function')

    let locked = false
    const acquiring = acquireLibraryMergeLockAfterMaintenanceIdle().then(() => {
      locked = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(locked).toBe(false)
    expect(isLibraryMergeMutationLocked()).toBe(false)

    release?.()
    await acquiring
    expect(locked).toBe(true)
    expect(isLibraryMergeMutationLocked()).toBe(true)
  })

  it('多个收尾任务全部退出后合并且只有一次才上锁', async () => {
    const first = tryBeginLibraryMaintenanceMutation()
    const second = tryBeginLibraryMaintenanceMutation()

    let locked = false
    const acquiring = acquireLibraryMergeLockAfterMaintenanceIdle().then(() => {
      locked = true
    })

    first?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(locked).toBe(false)

    second?.()
    await acquiring
    expect(locked).toBe(true)
  })

  it('合并锁定后收尾登记不上，只能走补跑队列', async () => {
    const release = tryBeginLibraryMaintenanceMutation()
    const acquiring = acquireLibraryMergeLockAfterMaintenanceIdle()
    release?.()
    await acquiring

    expect(tryBeginLibraryMaintenanceMutation()).toBeNull()
  })

  it('补跑队列在 drain 时逐个执行且只执行一次', async () => {
    const ran: string[] = []
    deferLibraryMaintenanceAfterMergeLockReleased('a', async () => {
      ran.push('a')
    })
    deferLibraryMaintenanceAfterMergeLockReleased('b', async () => {
      ran.push('b')
    })
    expect(getDeferredLibraryMaintenanceCount()).toBe(2)

    drainDeferredLibraryMaintenance()
    await Promise.resolve()
    expect(ran).toEqual(['a', 'b'])
    expect(getDeferredLibraryMaintenanceCount()).toBe(0)

    drainDeferredLibraryMaintenance()
    await Promise.resolve()
    expect(ran).toEqual(['a', 'b'])
  })

  it('补跑任务抛错不会影响同批其它任务', async () => {
    const ran: string[] = []
    deferLibraryMaintenanceAfterMergeLockReleased('bad', async () => {
      throw new Error('boom')
    })
    deferLibraryMaintenanceAfterMergeLockReleased('good', async () => {
      ran.push('good')
    })

    drainDeferredLibraryMaintenance()
    await Promise.resolve()
    await Promise.resolve()
    expect(ran).toEqual(['good'])
  })

  it('已持有时再次获取会被拒，且不影响持有者的锁', async () => {
    const release = await acquireLibraryMergeLockAfterMaintenanceIdle()
    expect(isLibraryMergeMutationLocked()).toBe(true)

    await expect(acquireLibraryMergeLockAfterMaintenanceIdle()).rejects.toMatchObject({
      code: 'MERGE_ALREADY_ACTIVE'
    })
    expect(isLibraryMergeMutationLocked()).toBe(true)

    release()
    expect(isLibraryMergeMutationLocked()).toBe(false)
  })

  it('过期的释放句柄不会解开后来者的锁', async () => {
    const staleRelease = await acquireLibraryMergeLockAfterMaintenanceIdle()
    staleRelease()
    expect(isLibraryMergeMutationLocked()).toBe(false)

    const freshRelease = await acquireLibraryMergeLockAfterMaintenanceIdle()
    staleRelease()
    expect(isLibraryMergeMutationLocked()).toBe(true)

    freshRelease()
    expect(isLibraryMergeMutationLocked()).toBe(false)
  })

  it('重复调用同一个释放句柄是空操作', async () => {
    const release = await acquireLibraryMergeLockAfterMaintenanceIdle()
    const second = await acquireLibraryMergeLockAfterMaintenanceIdle().catch(() => null)
    expect(second).toBeNull()

    release()
    release()
    expect(isLibraryMergeMutationLocked()).toBe(false)
  })

  it('释放后可以重新登记，锁状态与名额不互相污染', async () => {
    const releaseFirst = tryBeginLibraryMaintenanceMutation()
    const acquiringFirst = acquireLibraryMergeLockAfterMaintenanceIdle()
    releaseFirst?.()
    await acquiringFirst

    expect(isLibraryMergeMutationLocked()).toBe(true)
    expect(tryBeginLibraryMaintenanceMutation()).toBeNull()

    resetLibraryMergeMutationGateForTests()
    const releaseSecond = tryBeginLibraryMaintenanceMutation()
    expect(releaseSecond).toBeTypeOf('function')
    releaseSecond?.()
  })
})
