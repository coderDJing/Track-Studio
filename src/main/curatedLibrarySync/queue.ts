import { completeCuratedLibrarySyncStatus, runCuratedLibrarySync } from './engine'
import type { CuratedLibrarySyncStartPayload } from '../../shared/curatedLibrarySync'

type CuratedLibrarySyncRun = Promise<Awaited<ReturnType<typeof runCuratedLibrarySync>>>
type InFlightCuratedSync = {
  promise: CuratedLibrarySyncRun
  trigger: 'manual' | 'scheduled' | 'realtime'
}

let queued: Promise<unknown> = Promise.resolve()
let inFlightCurated: InFlightCuratedSync | null = null
let deferredAutomaticPayload: CuratedLibrarySyncStartPayload | null = null

export const enqueueCloudWork = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = queued.then(task, task)
  queued = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export const enqueueCuratedLibrarySync = (
  payload?: CuratedLibrarySyncStartPayload
): CuratedLibrarySyncRun => {
  const trigger =
    payload?.trigger === 'scheduled' || payload?.trigger === 'realtime' ? payload.trigger : 'manual'
  if (inFlightCurated) {
    // 手动点击只接入当前任务；手动任务期间到达的自动触发合并成一次后续同步。
    if (trigger !== 'manual' && inFlightCurated.trigger === 'manual') {
      deferredAutomaticPayload = payload || { trigger }
    }
    return inFlightCurated.promise
  }

  const promise = enqueueCloudWork(async () => {
    const result = await runCuratedLibrarySync(payload)
    completeCuratedLibrarySyncStatus(result)
    return result
  })
  inFlightCurated = { promise, trigger }
  void promise.then(
    () => finishCuratedSync(promise),
    () => finishCuratedSync(promise)
  )
  return promise
}

const finishCuratedSync = (promise: CuratedLibrarySyncRun): void => {
  if (inFlightCurated?.promise !== promise) return
  inFlightCurated = null
  const deferred = deferredAutomaticPayload
  deferredAutomaticPayload = null
  if (deferred) void enqueueCuratedLibrarySync(deferred)
}
