import { app, ipcMain, powerMonitor, type IpcMainInvokeEvent } from 'electron'
import { getBackgroundTaskExecutionStatus } from './backgroundOrchestrator'
import { getCoverTaskDiagnosticSnapshot } from './covers'
import { getBackgroundFileIoDiagnosticSnapshot } from './playbackForegroundActivity'
import { isPackagedRcBuild } from './rcDiagnostics'
import { getCoverIndexDbDiagnosticSnapshot } from '../libraryCacheDb/coverIndex'
import {
  beginMainThreadActivity,
  endMainThreadActivity,
  getMainThreadActivitySnapshot,
  summarizeIpcArgHint
} from './mainProcessActivityTraceState'
import { TracedEventListenerRegistry, type EventListenerFn } from './tracedEventListeners'

type InvokeListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

type PowerTraceState = {
  lastSuspendAtMs: number | null
  lastResumeAtMs: number | null
  lastLockScreenAtMs: number | null
  lastUnlockScreenAtMs: number | null
}

const powerTrace: PowerTraceState = {
  lastSuspendAtMs: null,
  lastResumeAtMs: null,
  lastLockScreenAtMs: null,
  lastUnlockScreenAtMs: null
}

const listenerRegistry = new TracedEventListenerRegistry()
let installed = false
let powerMonitorAttached = false

const toMb = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10

const scheduleEndMainThreadActivity = (id: number): void => {
  const finish = () => endMainThreadActivity(id)
  try {
    setImmediate(finish)
  } catch {
    finish()
  }
}

const beginIpcActivity = (
  kind: 'ipc-handle' | 'ipc-on',
  channel: string,
  args: unknown[]
): number => {
  const hint = summarizeIpcArgHint(args)
  return beginMainThreadActivity({
    kind,
    name: channel,
    argCount: hint.argCount,
    argHint: hint.argHint
  })
}

const wrapInvokeListener = (channel: string, listener: InvokeListener): InvokeListener => {
  return async (event, ...args) => {
    const id = beginIpcActivity('ipc-handle', channel, args)
    try {
      const result = await listener(event, ...args)
      endMainThreadActivity(id)
      if (result !== null && typeof result === 'object') {
        // Electron 把返回值克隆回 renderer 发生在 JS 函数返回之后，可能单独堵住事件循环。
        const returnHint = summarizeIpcArgHint([result])
        const returnId = beginMainThreadActivity({
          kind: 'ipc-handle',
          name: `${channel}:serialize-return`,
          argCount: returnHint.argCount,
          argHint: returnHint.argHint
        })
        scheduleEndMainThreadActivity(returnId)
      }
      return result
    } catch (error) {
      endMainThreadActivity(id)
      throw error
    }
  }
}

const createWrappedListener =
  (channel: string, listener: EventListenerFn): EventListenerFn =>
  (...rawArgs) => {
    const id = beginIpcActivity('ipc-on', channel, rawArgs.slice(1))
    try {
      const result = listener(...rawArgs)
      if (result && typeof result === 'object' && 'then' in result) {
        return Promise.resolve(result).finally(() => scheduleEndMainThreadActivity(id))
      }
      scheduleEndMainThreadActivity(id)
      return result
    } catch (error) {
      scheduleEndMainThreadActivity(id)
      throw error
    }
  }

const attachPowerMonitorListeners = (): void => {
  if (powerMonitorAttached) return
  powerMonitorAttached = true
  const stamp = (field: keyof PowerTraceState) => {
    powerTrace[field] = Date.now()
  }
  try {
    powerMonitor.on('suspend', () => stamp('lastSuspendAtMs'))
    powerMonitor.on('resume', () => stamp('lastResumeAtMs'))
    powerMonitor.on('lock-screen', () => stamp('lastLockScreenAtMs'))
    powerMonitor.on('unlock-screen', () => stamp('lastUnlockScreenAtMs'))
  } catch {
    powerMonitorAttached = false
  }
}

const getPowerSnapshot = (now: number) => {
  let systemIdleSeconds: number | null = null
  let systemIdleState: string | null = null
  if (app.isReady()) {
    try {
      systemIdleSeconds = Number(powerMonitor.getSystemIdleTime())
      if (!Number.isFinite(systemIdleSeconds) || systemIdleSeconds < 0) {
        systemIdleSeconds = null
      }
    } catch {
      systemIdleSeconds = null
    }
    try {
      systemIdleState = String(powerMonitor.getSystemIdleState(1) || '') || null
    } catch {
      systemIdleState = null
    }
  }
  const msSince = (timestamp: number | null): number | null =>
    timestamp === null ? null : Math.max(0, now - timestamp)
  return {
    lastSuspendAtMs: powerTrace.lastSuspendAtMs,
    lastResumeAtMs: powerTrace.lastResumeAtMs,
    lastLockScreenAtMs: powerTrace.lastLockScreenAtMs,
    lastUnlockScreenAtMs: powerTrace.lastUnlockScreenAtMs,
    msSinceResume: msSince(powerTrace.lastResumeAtMs),
    msSinceUnlock: msSince(powerTrace.lastUnlockScreenAtMs),
    systemIdleSeconds,
    systemIdleState
  }
}

const getMemorySnapshot = () => {
  const usage = process.memoryUsage()
  return {
    rssMb: toMb(usage.rss),
    heapUsedMb: toMb(usage.heapUsed),
    heapTotalMb: toMb(usage.heapTotal),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers)
  }
}

export const getMainProcessStallContext = (sinceMs: number) => {
  const now = Date.now()
  return {
    previousHeartbeatAtMs: sinceMs,
    memory: getMemorySnapshot(),
    power: getPowerSnapshot(now),
    backgroundTasks: getBackgroundTaskExecutionStatus(),
    backgroundFileIo: getBackgroundFileIoDiagnosticSnapshot(now),
    coverTasks: getCoverTaskDiagnosticSnapshot(now),
    coverIndexDb: getCoverIndexDbDiagnosticSnapshot(now),
    activity: getMainThreadActivitySnapshot(sinceMs)
  }
}

export const installMainProcessActivityTrace = (): void => {
  if (installed) return
  installed = true

  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: InvokeListener) => {
    return originalHandle(channel, wrapInvokeListener(channel, listener))
  }) as typeof ipcMain.handle

  if (typeof ipcMain.handleOnce === 'function') {
    const originalHandleOnce = ipcMain.handleOnce.bind(ipcMain)
    ipcMain.handleOnce = ((channel: string, listener: InvokeListener) => {
      return originalHandleOnce(channel, wrapInvokeListener(channel, listener))
    }) as typeof ipcMain.handleOnce
  }

  const originalOn = ipcMain.on.bind(ipcMain)
  const originalOnce = ipcMain.once.bind(ipcMain)
  const originalAddListener = ipcMain.addListener.bind(ipcMain)
  const originalRemoveListener = ipcMain.removeListener.bind(ipcMain)
  const originalOff = ipcMain.off.bind(ipcMain)

  const patchAdd = (original: typeof ipcMain.on): typeof ipcMain.on =>
    ((channel: string | symbol, listener: EventListenerFn) => {
      if (typeof channel !== 'string' || typeof listener !== 'function') {
        return original(channel as never, listener as never)
      }
      const wrapped = listenerRegistry.createAndRemember(channel, listener, (callback) =>
        createWrappedListener(channel, callback)
      )
      return original(channel, wrapped as never)
    }) as typeof ipcMain.on

  ipcMain.on = patchAdd(originalOn)
  ipcMain.addListener = patchAdd(originalAddListener)
  ipcMain.once = ((channel: string | symbol, listener: EventListenerFn) => {
    if (typeof channel !== 'string' || typeof listener !== 'function') {
      return originalOnce(channel as never, listener as never)
    }
    const onceWrapped = listenerRegistry.createOnce(
      channel,
      listener,
      (callback) => createWrappedListener(channel, callback),
      (callback) => originalRemoveListener(channel, callback as never)
    )
    // EventEmitter.once() internally dispatches through this.on(). Calling the captured once
    // after patching on() would wrap the listener twice and make removeListener() miss it.
    return originalOn(channel, onceWrapped as never)
  }) as typeof ipcMain.once

  const patchRemove = (original: typeof ipcMain.removeListener): typeof ipcMain.removeListener =>
    ((channel: string | symbol, listener: EventListenerFn) => {
      if (typeof channel !== 'string' || typeof listener !== 'function') {
        return original(channel as never, listener as never)
      }
      return original(channel, listenerRegistry.take(channel, listener) as never)
    }) as typeof ipcMain.removeListener

  ipcMain.removeListener = patchRemove(originalRemoveListener)
  ipcMain.off = patchRemove(originalOff)

  if (app.isReady()) {
    attachPowerMonitorListeners()
  } else {
    void app.whenReady().then(() => {
      attachPowerMonitorListeners()
    })
  }
}

if (isPackagedRcBuild()) {
  installMainProcessActivityTrace()
}
