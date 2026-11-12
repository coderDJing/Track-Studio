import { describe, expect, it, vi } from 'vitest'
import { createDynamicSidecarTracker } from './dynamicSidecarTracker'

const createTracker = () => {
  const terminatePid = vi.fn(() => true)
  return { terminatePid, tracker: createDynamicSidecarTracker({ terminatePid }) }
}

const jobA = {}
const jobB = {}

describe('createDynamicSidecarTracker lifecycle', () => {
  it('records the reported pid for the current job', () => {
    const { tracker } = createTracker()
    const worker = {}
    tracker.begin(worker, jobA)
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => true })
    expect(tracker.peek(worker)).toBe(4242)

    // 同一 job 重复 begin 不能清掉已记录的 PID。
    tracker.begin(worker, jobA)
    expect(tracker.peek(worker)).toBe(4242)
  })

  it('ignores progress without eligibility instead of registering it', () => {
    const { tracker } = createTracker()
    const worker = {}
    tracker.begin(worker, jobA)
    tracker.track({ workerKey: worker, jobKey: jobA, pid: undefined, canCommit: () => true })
    tracker.track({ workerKey: worker, jobKey: jobA, pid: null, canCommit: () => true })
    expect(tracker.peek(worker)).toBeUndefined()
  })

  it('treats null as session close: clears the record and ignores late old pids', () => {
    const { tracker, terminatePid } = createTracker()
    const worker = {}
    tracker.begin(worker, jobA)
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => true })
    tracker.track({ workerKey: worker, jobKey: jobA, pid: null, canCommit: () => true })
    expect(tracker.peek(worker)).toBeUndefined()

    // 正常关闭后同一任务迟到的旧 PID：可能是被复用的无关进程，绝不能杀。
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => false })
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => true })
    expect(terminatePid).not.toHaveBeenCalled()
    expect(tracker.peek(worker)).toBeUndefined()
  })

  it('kills the recorded pid once and repeated cleanup is idempotent', () => {
    const { tracker, terminatePid } = createTracker()
    const worker = {}
    tracker.begin(worker, jobA)
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => true })
    tracker.release(worker, true)
    tracker.release(worker, true)
    expect(terminatePid).toHaveBeenCalledTimes(1)
    expect(terminatePid).toHaveBeenCalledWith(4242)
    expect(tracker.peek(worker)).toBeUndefined()
  })

  it('terminates a pid that only arrives after release (release before report)', () => {
    const { tracker, terminatePid } = createTracker()
    const worker = {}
    tracker.begin(worker, jobA)
    tracker.release(worker, true)
    expect(terminatePid).not.toHaveBeenCalled()

    tracker.track({ workerKey: worker, jobKey: jobA, pid: 5151, canCommit: () => true })
    expect(terminatePid).toHaveBeenCalledTimes(1)
    expect(terminatePid).toHaveBeenCalledWith(5151)
    expect(tracker.peek(worker)).toBeUndefined()

    tracker.track({ workerKey: worker, jobKey: jobA, pid: 5151, canCommit: () => true })
    expect(terminatePid).toHaveBeenCalledTimes(1)
  })

  it('allows the same pid to be reused by a different worker after release', () => {
    const { tracker, terminatePid } = createTracker()
    const workerA = {}
    const workerB = {}
    tracker.begin(workerA, jobA)
    tracker.track({ workerKey: workerA, jobKey: jobA, pid: 4242, canCommit: () => true })
    tracker.release(workerA, true)
    expect(terminatePid).toHaveBeenCalledTimes(1)

    // OS 复用了 4242：新 worker 的合法进程必须能重新登记并清理。
    tracker.begin(workerB, jobB)
    tracker.track({ workerKey: workerB, jobKey: jobB, pid: 4242, canCommit: () => true })
    expect(tracker.peek(workerB)).toBe(4242)
    expect(terminatePid).toHaveBeenCalledTimes(1)

    tracker.release(workerB, true)
    expect(terminatePid).toHaveBeenCalledTimes(2)
  })

  it('allows the same pid to be reused by a new job on the same worker', () => {
    const { tracker, terminatePid } = createTracker()
    const worker = {}
    tracker.begin(worker, jobA)
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => true })
    tracker.release(worker, true)

    tracker.begin(worker, jobB)
    tracker.track({ workerKey: worker, jobKey: jobB, pid: 4242, canCommit: () => true })
    expect(tracker.peek(worker)).toBe(4242)
    expect(terminatePid).toHaveBeenCalledTimes(1)

    tracker.release(worker, true)
    expect(terminatePid).toHaveBeenCalledTimes(2)
  })

  it('never kills the new job process when a stale job message reports the same pid', () => {
    const { tracker, terminatePid } = createTracker()
    const worker = {}
    tracker.begin(worker, jobA)
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => true })
    tracker.release(worker, true)

    tracker.begin(worker, jobB)
    tracker.track({ workerKey: worker, jobKey: jobB, pid: 4242, canCommit: () => true })
    // 旧 job 的迟到消息带同一个（已被新任务复用的）PID。
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => false })
    expect(terminatePid).toHaveBeenCalledTimes(1)
    expect(tracker.peek(worker)).toBe(4242)
  })

  it('terminates a stale job pid that does not belong to the current job', () => {
    const { tracker, terminatePid } = createTracker()
    const worker = {}
    tracker.begin(worker, jobA)
    tracker.begin(worker, jobB)
    tracker.track({ workerKey: worker, jobKey: jobB, pid: 6262, canCommit: () => true })

    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => false })
    expect(terminatePid).toHaveBeenCalledWith(4242)
    expect(terminatePid).toHaveBeenCalledTimes(1)
    // 当前任务的进程不受影响。
    expect(tracker.peek(worker)).toBe(6262)

    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => false })
    expect(terminatePid).toHaveBeenCalledTimes(1)
  })

  it('implicitly starts the lifecycle when begin was missed but the job is eligible', () => {
    const { tracker, terminatePid } = createTracker()
    const worker = {}
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => true })
    expect(tracker.peek(worker)).toBe(4242)
    tracker.release(worker, true)
    expect(terminatePid).toHaveBeenCalledWith(4242)
  })

  it('does not kill on a non-destructive release', () => {
    const { tracker, terminatePid } = createTracker()
    const worker = {}
    tracker.begin(worker, jobA)
    tracker.track({ workerKey: worker, jobKey: jobA, pid: 4242, canCommit: () => true })
    tracker.release(worker, false)
    expect(terminatePid).not.toHaveBeenCalled()
    expect(tracker.peek(worker)).toBeUndefined()
  })
})
