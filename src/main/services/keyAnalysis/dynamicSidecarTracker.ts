/**
 * worker 拥有的 Dynamic 推理 sidecar 追踪。
 *
 * worker 被硬终止时不会执行其内部的 process exit hook，主进程只能按“本任务上报过的
 * 精确 PID”清理。这里只保存 worker→pid 映射，不使用全局进程名匹配。
 *
 * 幂等/已关闭信息按 **worker + job 生命周期**保存，而不是全局 PID 黑名单：
 * OS 会把同一个 PID 复用到新 worker/新任务上，全局黑名单会让合法新进程永不登记、
 * 取消时泄漏。生命周期只在 `begin`（确认新任务已启动）时重置。
 */
export type DynamicSidecarTracker = {
  /** 确认某个 worker 上真的启动了新任务时调用；同一 job 重复调用是幂等的。 */
  begin: (workerKey: object, jobKey: object) => void
  track: (params: {
    workerKey: object
    jobKey: object | null
    pid: number | null | undefined
    canCommit: () => boolean
  }) => void
  release: (workerKey: object, kill: boolean) => void
  peek: (workerKey: object) => number | undefined
}

const MAX_REMEMBERED_PIDS = 64

type SidecarLifecycle = {
  jobKey: object | null
  pid: number | null
  released: boolean
  /** 本生命周期内已请求终止的 PID：重复清理幂等。 */
  terminatedPids: Set<number>
  /** 本生命周期内已确认退出的 PID：迟到进度只忽略，不再按可能复用的 PID 杀进程。 */
  closedPids: Set<number>
}

const remember = (set: Set<number>, pid: number) => {
  if (set.size >= MAX_REMEMBERED_PIDS) {
    const oldest = set.values().next()
    if (!oldest.done) set.delete(oldest.value)
  }
  set.add(pid)
}

const createLifecycle = (jobKey: object | null): SidecarLifecycle => ({
  jobKey,
  pid: null,
  released: false,
  terminatedPids: new Set(),
  closedPids: new Set()
})

export const createDynamicSidecarTracker = (deps: {
  terminatePid: (pid: number) => boolean
}): DynamicSidecarTracker => {
  const lifecycleByWorker = new WeakMap<object, SidecarLifecycle>()

  const terminateOnce = (lifecycle: SidecarLifecycle, pid: number) => {
    if (lifecycle.terminatedPids.has(pid)) return
    remember(lifecycle.terminatedPids, pid)
    deps.terminatePid(pid)
  }

  return {
    begin: (workerKey, jobKey) => {
      const current = lifecycleByWorker.get(workerKey)
      // 同一 job 的重复 begin 不能清掉本轮已记录的 PID / 已终止信息。
      if (current && current.jobKey === jobKey) return
      lifecycleByWorker.set(workerKey, createLifecycle(jobKey))
    },
    track: ({ workerKey, jobKey, pid, canCommit }) => {
      if (pid === undefined) return
      let lifecycle = lifecycleByWorker.get(workerKey)
      if (!lifecycle) {
        if (pid === null) return
        // 没来得及 begin 但任务确实有提交资格：按该 job 隐式建立生命周期并登记。
        const eligible = jobKey !== null && canCommit()
        lifecycle = createLifecycle(eligible ? jobKey : null)
        lifecycleByWorker.set(workerKey, lifecycle)
      }
      if (lifecycle.jobKey !== jobKey) {
        // 旧 job 的迟到消息：只清理不属于当前 job 的 PID，绝不误杀新任务正在用的进程。
        if (pid === null) return
        if (pid === lifecycle.pid) return
        if (lifecycle.closedPids.has(pid)) return
        terminateOnce(lifecycle, pid)
        return
      }
      if (pid === null) {
        if (lifecycle.pid !== null) {
          remember(lifecycle.closedPids, lifecycle.pid)
          lifecycle.pid = null
        }
        return
      }
      if (lifecycle.closedPids.has(pid)) return
      if (lifecycle.released || !canCommit()) {
        terminateOnce(lifecycle, pid)
        return
      }
      if (lifecycle.terminatedPids.has(pid)) return
      lifecycle.pid = pid
    },
    release: (workerKey, kill) => {
      const lifecycle = lifecycleByWorker.get(workerKey)
      if (!lifecycle) return
      const pid = lifecycle.pid
      lifecycle.pid = null
      if (!kill) {
        if (pid !== null) remember(lifecycle.closedPids, pid)
        return
      }
      lifecycle.released = true
      if (pid !== null) terminateOnce(lifecycle, pid)
    },
    peek: (workerKey) => lifecycleByWorker.get(workerKey)?.pid ?? undefined
  }
}
