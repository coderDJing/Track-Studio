import type { BrowserWindow } from 'electron'
import { performance, type EventLoopUtilization } from 'node:perf_hooks'
import { log } from '../../log'
import { getMainProcessStallContext } from '../../services/mainProcessActivityTrace'
import { getPlaylistScanDiagnosticSnapshot } from '../../services/playlistScanDiagnostics'
import { getPlaylistOpenPerfSnapshot } from '../../services/playlistOpenPerfTrace'
import { isPackagedRcBuild } from '../../services/rcDiagnostics'

const MAIN_PROCESS_STALL_THRESHOLD_MS = 3_000
const MAIN_PROCESS_HEARTBEAT_INTERVAL_MS = 1_000
const MAIN_PROCESS_STALL_INCIDENT_GRACE_MS = 30_000

type MainProcessStallIncident = {
  startedAtMs: number
  lastStallAtMs: number
  count: number
  totalDurationMs: number
  maxDurationMs: number
}

type RendererUnresponsiveIncident = {
  startedAtMs: number
  rendererPid: number | null
  url: string | null
}

type MainWindowResponsivenessDiagnosticsOptions = {
  isAuxiliaryWindowVisible?: () => boolean
}

const getRendererPid = (browserWindow: BrowserWindow): number | null => {
  try {
    return browserWindow.webContents.getOSProcessId()
  } catch {
    return null
  }
}

const getRendererUrl = (browserWindow: BrowserWindow): string | null => {
  try {
    return browserWindow.webContents.getURL() || null
  } catch {
    return null
  }
}

const summarizeActiveResources = (): Record<string, number> => {
  try {
    const counts: Record<string, number> = {}
    for (const resource of process.getActiveResourcesInfo()) {
      counts[resource] = (counts[resource] || 0) + 1
    }
    return counts
  } catch {
    return {}
  }
}

const stringifyDiagnostic = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ serializationFailed: true })
  }
}

const captureSnapshot = (
  browserWindow: BrowserWindow,
  options?: { sinceMs?: number; auxiliaryWindowVisible?: boolean }
) => {
  const rendererPid = getRendererPid(browserWindow)
  const url = getRendererUrl(browserWindow)
  const sinceMs = options?.sinceMs ?? Date.now() - 5_000

  return {
    windowId: browserWindow.id,
    webContentsId: browserWindow.webContents.id,
    rendererPid,
    url,
    loading: browserWindow.webContents.isLoading(),
    focused: browserWindow.isFocused(),
    visible: browserWindow.isVisible(),
    auxiliaryWindowVisible: options?.auxiliaryWindowVisible === true,
    // app.getAppMetrics() 是同步跨进程调用。在大型 Electron 会话中它本身能阻塞主进程数秒，
    // 不能作为每秒心跳或卡顿现场的采样方式，否则诊断器会制造它要检测的卡顿。
    playlistScans: getPlaylistScanDiagnosticSnapshot(),
    playlistOpenPerf: getPlaylistOpenPerfSnapshot(),
    ...getMainProcessStallContext(sinceMs)
  }
}

/**
 * 记录 Windows 未响应的可定位证据：
 * - Electron 事件用于区分 renderer 卡死、恢复和崩溃；
 * - 心跳延迟用于发现主进程消息循环被同步任务或原生调用阻塞的情况；
 * - 心跳只做轻量时间/CPU 采样；禁止在这里调用同步跨进程 Electron 指标 API。
 */
export const attachMainWindowResponsivenessDiagnostics = (
  browserWindow: BrowserWindow,
  options: MainWindowResponsivenessDiagnosticsOptions = {}
) => {
  const rcDiagnosticsEnabled = isPackagedRcBuild()
  let rendererUnresponsiveIncident: RendererUnresponsiveIncident | null = null
  let lastHeartbeatAt = Date.now()
  let lastCpuUsage = process.cpuUsage()
  let lastEventLoopUtilization = performance.eventLoopUtilization()
  let stallIncident: MainProcessStallIncident | null = null
  let backgroundStallIncident: MainProcessStallIncident | null = null

  const isAuxiliaryWindowVisible = () => {
    try {
      return options.isAuxiliaryWindowVisible?.() === true
    } catch {
      return false
    }
  }

  const finishStallIncident = () => {
    if (!stallIncident) return
    if (stallIncident.count > 1) {
      log.error('[main-window] main-process stall incident summary', {
        startedAtMs: stallIncident.startedAtMs,
        endedAtMs: stallIncident.lastStallAtMs,
        stallCount: stallIncident.count,
        totalStallDurationMs: stallIncident.totalDurationMs,
        maxStallDurationMs: stallIncident.maxDurationMs
      })
    }
    stallIncident = null
  }

  const finishBackgroundStallIncident = () => {
    if (!backgroundStallIncident) return
    // RC 诊断仅留一条聚合记录：窗口隐藏、最小化或锁屏时的调度延迟不等同于用户可感知卡顿。
    log.info('[main-window] non-interactive main-process delay summary', {
      startedAtMs: backgroundStallIncident.startedAtMs,
      endedAtMs: backgroundStallIncident.lastStallAtMs,
      stallCount: backgroundStallIncident.count,
      totalStallDurationMs: backgroundStallIncident.totalDurationMs,
      maxStallDurationMs: backgroundStallIncident.maxDurationMs,
      windowVisible: false
    })
    backgroundStallIncident = null
  }

  const recordStall = (
    incident: MainProcessStallIncident | null,
    now: number,
    stallDurationMs: number
  ): MainProcessStallIncident => {
    if (!incident) {
      return {
        startedAtMs: now,
        lastStallAtMs: now,
        count: 1,
        totalDurationMs: stallDurationMs,
        maxDurationMs: stallDurationMs
      }
    }
    incident.lastStallAtMs = now
    incident.count += 1
    incident.totalDurationMs += stallDurationMs
    incident.maxDurationMs = Math.max(incident.maxDurationMs, stallDurationMs)
    return incident
  }

  const heartbeat = rcDiagnosticsEnabled
    ? setInterval(() => {
        const previousHeartbeatAt = lastHeartbeatAt
        const now = Date.now()
        const stallDurationMs = now - previousHeartbeatAt - MAIN_PROCESS_HEARTBEAT_INTERVAL_MS
        lastHeartbeatAt = now
        const currentCpuUsage = process.cpuUsage()
        const cpuUserMs = (currentCpuUsage.user - lastCpuUsage.user) / 1000
        const cpuSystemMs = (currentCpuUsage.system - lastCpuUsage.system) / 1000
        lastCpuUsage = currentCpuUsage
        const eventLoopUtilization: EventLoopUtilization =
          performance.eventLoopUtilization(lastEventLoopUtilization)
        lastEventLoopUtilization = performance.eventLoopUtilization()
        if (browserWindow.isDestroyed()) {
          return
        }
        if (stallDurationMs < MAIN_PROCESS_STALL_THRESHOLD_MS) {
          if (
            stallIncident &&
            now - stallIncident.lastStallAtMs >= MAIN_PROCESS_STALL_INCIDENT_GRACE_MS
          ) {
            finishStallIncident()
          }
          if (
            backgroundStallIncident &&
            now - backgroundStallIncident.lastStallAtMs >= MAIN_PROCESS_STALL_INCIDENT_GRACE_MS
          ) {
            finishBackgroundStallIncident()
          }
          return
        }
        const mainWindowVisible = browserWindow.isVisible()
        const auxiliaryWindowVisible = isAuxiliaryWindowVisible()
        if (!mainWindowVisible && !auxiliaryWindowVisible) {
          finishStallIncident()
          backgroundStallIncident = recordStall(backgroundStallIncident, now, stallDurationMs)
          return
        }
        finishBackgroundStallIncident()
        stallIncident = recordStall(stallIncident, now, stallDurationMs)
        // 每次达到阈值都保留现场，避免同一轮后续更严重的卡顿只剩汇总计数。
        const snapshot = captureSnapshot(browserWindow, {
          sinceMs: previousHeartbeatAt,
          auxiliaryWindowVisible
        })
        const elapsedMs = Math.max(0, now - previousHeartbeatAt)
        const cpuUserMsRounded = Math.round(cpuUserMs)
        const cpuSystemMsRounded = Math.round(cpuSystemMs)
        const processCpuMs = Math.max(0, cpuUserMs + cpuSystemMs)
        const processCpuRatio = elapsedMs > 0 ? processCpuMs / elapsedMs : 0
        const power = snapshot.power
        const isNonInteractiveSystemDelay =
          power.systemIdleState === 'locked' ||
          (power.systemIdleState === 'idle' &&
            power.systemIdleSeconds !== null &&
            power.systemIdleSeconds >= 10 &&
            processCpuRatio <= 0.1)
        if (isNonInteractiveSystemDelay) {
          finishStallIncident()
          return
        }
        const overlappingActivity = snapshot.activity.longest
        const stallClassification = overlappingActivity
          ? {
              kind: 'tracked-main-thread-activity-overlap',
              activity: overlappingActivity
            }
          : processCpuRatio >= 0.7
            ? {
                kind: 'process-cpu-bound',
                processCpuRatio: Math.round(processCpuRatio * 1000) / 1000
              }
            : processCpuRatio <= 0.1
              ? {
                  kind: 'low-process-cpu',
                  processCpuRatio: Math.round(processCpuRatio * 1000) / 1000
                }
              : { kind: 'unclassified', processCpuRatio: Math.round(processCpuRatio * 1000) / 1000 }
        log.error(
          '[main-window] main-process event loop stalled',
          stringifyDiagnostic({
            incidentStartedAtMs: stallIncident.startedAtMs,
            stallIndex: stallIncident.count,
            stallDurationMs,
            interactiveSurface: mainWindowVisible ? 'main-window' : 'mini-player',
            stallClassification,
            snapshot,
            mainProcessInterval: {
              elapsedMs,
              cpuUserMs: cpuUserMsRounded,
              cpuSystemMs: cpuSystemMsRounded,
              processCpuRatio: Math.round(processCpuRatio * 1000) / 1000,
              eventLoopActiveMs: Math.round(eventLoopUtilization.active),
              eventLoopIdleMs: Math.round(eventLoopUtilization.idle),
              eventLoopUtilization: Math.round(eventLoopUtilization.utilization * 1000) / 1000,
              activeResources: summarizeActiveResources()
            }
          })
        )
      }, MAIN_PROCESS_HEARTBEAT_INTERVAL_MS)
    : null

  browserWindow.webContents.on('unresponsive', () => {
    if (!rcDiagnosticsEnabled) return
    if (rendererUnresponsiveIncident !== null) {
      return
    }
    rendererUnresponsiveIncident = {
      startedAtMs: Date.now(),
      rendererPid: getRendererPid(browserWindow),
      url: getRendererUrl(browserWindow)
    }
    log.error(
      '[main-window] renderer unresponsive',
      stringifyDiagnostic({
        incident: rendererUnresponsiveIncident,
        snapshot: captureSnapshot(browserWindow)
      })
    )
  })

  browserWindow.webContents.on('responsive', () => {
    if (!rcDiagnosticsEnabled) return
    const incident = rendererUnresponsiveIncident
    if (incident === null) {
      return
    }
    const durationMs = Date.now() - incident.startedAtMs
    rendererUnresponsiveIncident = null
    log.error(
      '[main-window] renderer recovered',
      stringifyDiagnostic({
        durationMs,
        incident,
        rendererPidChanged:
          incident.rendererPid !== null && incident.rendererPid !== getRendererPid(browserWindow),
        snapshot: captureSnapshot(browserWindow, { sinceMs: incident.startedAtMs })
      })
    )
  })

  // Electron 某些 renderer 重载不会先发 render-process-gone；若此前已经无响应，
  // 在 load 完成处闭合这次事件，避免日志只留下“卡住”却不知道最终走向。
  browserWindow.webContents.on('did-finish-load', () => {
    if (!rcDiagnosticsEnabled) return
    const incident = rendererUnresponsiveIncident
    if (incident === null) return
    const durationMs = Date.now() - incident.startedAtMs
    rendererUnresponsiveIncident = null
    log.error(
      '[main-window] renderer reloaded after unresponsive',
      stringifyDiagnostic({
        durationMs,
        incident,
        rendererPidChanged:
          incident.rendererPid !== null && incident.rendererPid !== getRendererPid(browserWindow),
        snapshot: captureSnapshot(browserWindow, { sinceMs: incident.startedAtMs })
      })
    )
  })

  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    const incident = rendererUnresponsiveIncident
    const durationMs = incident === null ? null : Math.max(0, Date.now() - incident.startedAtMs)
    const sinceMs = incident?.startedAtMs ?? Date.now() - 5_000
    rendererUnresponsiveIncident = null
    log.error(
      '[main-window] render-process-gone',
      stringifyDiagnostic({
        details,
        unresponsiveDurationMs: durationMs,
        incident,
        snapshot: captureSnapshot(browserWindow, { sinceMs })
      })
    )
  })

  const dispose = () => {
    if (rendererUnresponsiveIncident) {
      const incident = rendererUnresponsiveIncident
      rendererUnresponsiveIncident = null
      log.error('[main-window] window closed while renderer unresponsive', {
        durationMs: Math.max(0, Date.now() - incident.startedAtMs),
        incident
      })
    }
    finishStallIncident()
    finishBackgroundStallIncident()
    if (heartbeat) clearInterval(heartbeat)
  }
  browserWindow.once('closed', dispose)
  return dispose
}
