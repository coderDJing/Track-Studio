import { log } from '../../log'
import { LibraryMergeError } from './types'

type DeferredMaintenanceTask = {
  label: string
  run: () => void | Promise<void>
}

let mutationLocked = false
/** 当前持锁者的令牌；释放时必须对得上，过期句柄不能解开后来者的锁。 */
let mutationLockToken = 0
/** 已登记、正在进行中的库写收尾任务数量（不含合并自身）。 */
let activeMaintenanceCount = 0
const maintenanceIdleWaiters = new Set<() => void>()
const deferredMaintenanceTasks: DeferredMaintenanceTask[] = []

export const isLibraryMergeMutationLocked = (): boolean => mutationLocked

/**
 * 合并锁与「库写收尾任务」之间的互斥（删歌收尾的序号整理 / 置脏 / 云同步触发等）。
 *
 * 这类任务被挪进后台通道后不再挂在 IPC 的 await 上，而合并锁只代表「拿锁那一刻」库里没有
 * 别的写者，管不到之后，于是两头都漏：
 *  - 任务进入时锁已被持有 → 直接 return 等于永久丢掉这次收尾（序号断层、云同步不再触发）；
 *  - 任务检查通过后锁才被拿到 → 收尾和合并在同一份缓存上并发写。
 *
 * 两条不变量把两个方向都堵死：
 *  1. `tryBeginLibraryMaintenanceMutation()` 在一个同步片段里完成「检查锁 + 登记」；
 *  2. `acquireLibraryMergeLockAfterMaintenanceIdle()` 是唯一的上锁入口，且「确认没有进行中
 *     的收尾」与 `mutationLocked = true` 写在 `await` 回来后的同一个同步片段里，中间没有
 *     任何 await，所以收尾任务插不进这道缝。
 *
 * 拿不到名额的收尾走 `deferLibraryMaintenanceAfterMergeLockReleased()`，在合并释放锁后补跑，
 * 不再被静默丢弃。
 */
export const tryBeginLibraryMaintenanceMutation = (): (() => void) | null => {
  if (mutationLocked) return null
  activeMaintenanceCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeMaintenanceCount = Math.max(0, activeMaintenanceCount - 1)
    if (activeMaintenanceCount > 0) return
    const waiters = [...maintenanceIdleWaiters]
    maintenanceIdleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

const waitForLibraryMaintenanceMutationsIdle = async (): Promise<void> => {
  if (activeMaintenanceCount === 0) return
  await new Promise<void>((resolve) => {
    maintenanceIdleWaiters.add(resolve)
  })
}

/**
 * 合并上锁的唯一入口：先等所有库写收尾退出，再在同一个同步片段里「拒绝已持锁 + 置锁」。
 *
 * 返回释放函数。置锁与拒绝之间没有 await，所以并发进来的两个合并请求里，后到的那个会在
 * 这里被拒（MERGE_ALREADY_ACTIVE），不会出现「两个都以为自己拿到了锁、失败的一方在
 * finally 里把仍在执行的合并解锁」。
 *
 * 不要改回「先 `await` 等空闲、再在别处 `mutationLocked = true`」——那样 await 与置锁之间
 * 会被别的微任务插进来，互斥就破了。也不要额外暴露一个能直接改 `mutationLocked` 的 setter。
 */
export const acquireLibraryMergeLockAfterMaintenanceIdle = async (): Promise<() => void> => {
  while (activeMaintenanceCount > 0) {
    await waitForLibraryMaintenanceMutationsIdle()
  }
  if (mutationLocked) {
    throw new LibraryMergeError('MERGE_ALREADY_ACTIVE', '当前库已有合并任务正在运行')
  }
  mutationLocked = true
  const token = ++mutationLockToken
  let released = false
  return () => {
    if (released) return
    released = true
    // 只有仍然持锁的那一次获取能解锁；过期句柄是空操作（失败路径不该动别人的锁）。
    if (mutationLockToken !== token) return
    mutationLocked = false
  }
}

/** 合并锁定期间被挡下的收尾任务，等锁释放后补跑。 */
export const deferLibraryMaintenanceAfterMergeLockReleased = (
  label: string,
  run: () => void | Promise<void>
): void => {
  deferredMaintenanceTasks.push({ label, run })
}

export const getDeferredLibraryMaintenanceCount = (): number => deferredMaintenanceTasks.length

/** 合并释放锁后调用：把被挡下的收尾补跑掉（各自会重新排队进自己的后台通道）。 */
export const drainDeferredLibraryMaintenance = (): void => {
  if (deferredMaintenanceTasks.length === 0) return
  const tasks = deferredMaintenanceTasks.splice(0)
  for (const task of tasks) {
    try {
      void Promise.resolve(task.run()).catch((error) => {
        log.error('[library-merge] deferred maintenance failed', { label: task.label, error })
      })
    } catch (error) {
      log.error('[library-merge] deferred maintenance threw synchronously', {
        label: task.label,
        error
      })
    }
  }
}

export const resetLibraryMergeMutationGateForTests = (): void => {
  mutationLocked = false
  activeMaintenanceCount = 0
  maintenanceIdleWaiters.clear()
  deferredMaintenanceTasks.length = 0
}
