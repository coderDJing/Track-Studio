import { log } from '../log'
import { getBackgroundIdleSnapshot } from './backgroundIdleGate'

type BackgroundTaskCategory = 'key-analysis' | 'mixtape-stem-resume'

type BackgroundTaskRequest = {
  category: BackgroundTaskCategory
  trigger: string
  requestedAt: number
  run: () => Promise<void>
}

type BackgroundTaskRunningState = {
  category: BackgroundTaskCategory
  startedAt: number
  trigger: string
}

const CATEGORY_PRIORITY: Record<BackgroundTaskCategory, number> = {
  'mixtape-stem-resume': 400,
  'key-analysis': 300
}

const ORCHESTRATOR_TICK_MS = 5000

const pendingRequestMap = new Map<BackgroundTaskCategory, BackgroundTaskRequest>()
let runningState: BackgroundTaskRunningState | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let started = false
let flushInProgress = false
let flushRequested = false
let executionPaused = false
let runningCompletion: Promise<void> | null = null

export const getBackgroundTaskExecutionStatus = () => {
  const now = Date.now()
  return {
    pending: pendingRequestMap.size,
    pendingTasks: [...pendingRequestMap.values()].map((request) => ({
      category: request.category,
      trigger: request.trigger,
      waitingMs: Math.max(0, now - request.requestedAt)
    })),
    running: runningState !== null,
    runningTask: runningState
      ? {
          category: runningState.category,
          trigger: runningState.trigger,
          durationMs: Math.max(0, now - runningState.startedAt)
        }
      : null,
    paused: executionPaused
  }
}

const pauseBackgroundTaskExecution = (): (() => void) => {
  executionPaused = true
  let released = false
  return () => {
    if (released) return
    released = true
    executionPaused = false
    void flushPendingRequests()
  }
}

// Library merge cannot share a database with idle maintenance. Drop work that has not started,
// then wait for the currently running bounded callback to exit before the merge takes its lock.
// We intentionally do not force-kill a callback while it may be writing cache state.
export const interruptBackgroundTaskExecution = async (): Promise<() => void> => {
  const resume = pauseBackgroundTaskExecution()
  pendingRequestMap.clear()
  const activeRun = runningCompletion
  if (activeRun) {
    await activeRun
  }
  return resume
}

const pickNextRequest = (): BackgroundTaskRequest | null => {
  if (pendingRequestMap.size === 0) return null
  let next: BackgroundTaskRequest | null = null
  for (const request of pendingRequestMap.values()) {
    if (!next) {
      next = request
      continue
    }
    const currentPriority = CATEGORY_PRIORITY[request.category] || 0
    const nextPriority = CATEGORY_PRIORITY[next.category] || 0
    if (currentPriority > nextPriority) {
      next = request
      continue
    }
    if (currentPriority === nextPriority && request.requestedAt < next.requestedAt) {
      next = request
    }
  }
  return next
}

const runRequest = async (request: BackgroundTaskRequest) => {
  const currentRunning: BackgroundTaskRunningState = {
    category: request.category,
    startedAt: Date.now(),
    trigger: request.trigger
  }
  runningState = currentRunning
  try {
    await request.run()
  } catch (error) {
    log.error('[background-orchestrator] background task failed', {
      category: request.category,
      trigger: request.trigger,
      error
    })
  } finally {
    runningState = null
  }
}

const flushPendingRequests = async () => {
  if (!started || executionPaused) return
  if (flushInProgress) {
    flushRequested = true
    return
  }
  flushInProgress = true
  try {
    while (true) {
      if (runningState) return
      if (pendingRequestMap.size === 0) return
      const idleSnapshot = getBackgroundIdleSnapshot()
      if (!idleSnapshot.allowed) {
        return
      }
      const nextRequest = pickNextRequest()
      if (!nextRequest) return
      pendingRequestMap.delete(nextRequest.category)
      const completion = runRequest(nextRequest)
      runningCompletion = completion
      try {
        await completion
      } finally {
        if (runningCompletion === completion) {
          runningCompletion = null
        }
      }
      if (!flushRequested) {
        if (pendingRequestMap.size === 0) return
        continue
      }
      flushRequested = false
    }
  } finally {
    flushInProgress = false
    if (flushRequested) {
      flushRequested = false
      void flushPendingRequests()
    }
  }
}

export const requestBackgroundTaskExecution = (params: {
  category: BackgroundTaskCategory
  run: () => Promise<void> | void
  trigger?: string
}) => {
  if (!started) {
    return
  }
  const category = params.category
  const request: BackgroundTaskRequest = {
    category,
    trigger: String(params.trigger || 'manual'),
    requestedAt: Date.now(),
    run: async () => {
      await Promise.resolve(params.run())
    }
  }
  pendingRequestMap.set(category, request)
  void flushPendingRequests()
}

export const startBackgroundOrchestrator = () => {
  if (started) return
  started = true
  tickTimer = setInterval(() => {
    void flushPendingRequests()
  }, ORCHESTRATOR_TICK_MS)
  tickTimer.unref?.()
}

export const stopBackgroundOrchestrator = () => {
  started = false
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  pendingRequestMap.clear()
  runningState = null
  runningCompletion = null
  flushInProgress = false
  flushRequested = false
  executionPaused = false
}
