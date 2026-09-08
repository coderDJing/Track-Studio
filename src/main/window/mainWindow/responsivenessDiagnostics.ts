import { app, type BrowserWindow, type ProcessMetric } from 'electron'
import { log } from '../../log'
import { getMainProcessStallContext } from '../../services/mainProcessActivityTrace'
import { getPlaylistScanDiagnosticSnapshot } from '../../services/playlistScanDiagnostics'
import { getPlaylistOpenPerfSnapshot } from '../../services/playlistOpenPerfTrace'

const MAIN_PROCESS_STALL_THRESHOLD_MS = 3_000
const MAIN_PROCESS_HEARTBEAT_INTERVAL_MS = 1_000
const MAIN_PROCESS_STALL_INCIDENT_GRACE_MS = 30_000

type SlimProcessMetric = {
  pid: number
  type: string
  serviceName?: string
  percentCPUUsage?: number
  cumulativeCPUUsage?: number
  workingSetKb?: number
  peakWorkingSetKb?: number
  privateKb?: number
}

const getRendererPid = (browserWindow: BrowserWindow): number | null => {
  try {
    return browserWindow.webContents.getOSProcessId()
  } catch {
    return null
  }
}

const summarizeProcessMetrics = (metrics: ProcessMetric[]): SlimProcessMetric[] =>
  metrics.map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    serviceName:
      'serviceName' in metric ? String(metric.serviceName || '') || undefined : undefined,
    percentCPUUsage: metric.cpu?.percentCPUUsage,
    cumulativeCPUUsage: metric.cpu?.cumulativeCPUUsage,
    workingSetKb: metric.memory?.workingSetSize,
    peakWorkingSetKb: metric.memory?.peakWorkingSetSize,
    privateKb: metric.memory?.privateBytes
  }))

const getProcessMetrics = (rendererPid: number | null): SlimProcessMetric[] => {
  try {
    return summarizeProcessMetrics(
      app
        .getAppMetrics()
        .filter(
          (metric) =>
            metric.pid === rendererPid ||
            metric.type === 'Browser' ||
            metric.type === 'GPU' ||
            metric.type === 'Utility'
        )
    )
  } catch {
    return []
  }
}

const captureSnapshot = (
  browserWindow: BrowserWindow,
  options?: { sinceMs?: number; processMetrics?: SlimProcessMetric[] }
) => {
  const rendererPid = getRendererPid(browserWindow)
  let url: string | null = null
  try {
    url = browserWindow.webContents.getURL() || null
  } catch {}
  const sinceMs = options?.sinceMs ?? Date.now() - 5_000

  return {
    windowId: browserWindow.id,
    webContentsId: browserWindow.webContents.id,
    rendererPid,
    url,
    loading: browserWindow.webContents.isLoading(),
    focused: browserWindow.isFocused(),
    visible: browserWindow.isVisible(),
    processMetrics: options?.processMetrics ?? getProcessMetrics(rendererPid),
    playlistScans: getPlaylistScanDiagnosticSnapshot(),
    playlistOpenPerf: getPlaylistOpenPerfSnapshot(),
    ...getMainProcessStallContext(sinceMs)
  }
}

/**
 * 记录 Windows 未响应的可定位证据：
 * - Electron 事件用于区分 renderer 卡死、恢复和崩溃；
 * - 心跳延迟用于发现主进程消息循环被同步任务或原生调用阻塞的情况；
 * - 每次心跳都采样进程 CPU，卡住时才能看到卡顿窗口内的占用，而不是恢复后的 0。
 */
export const attachMainWindowResponsivenessDiagnostics = (browserWindow: BrowserWindow) => {
  let rendererUnresponsiveAt: number | null = null
  let lastHeartbeatAt = Date.now()
  let stallIncident: {
    startedAtMs: number
    lastStallAtMs: number
    count: number
    totalDurationMs: number
    maxDurationMs: number
  } | null = null

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

  const heartbeat = setInterval(() => {
    const previousHeartbeatAt = lastHeartbeatAt
    const now = Date.now()
    const stallDurationMs = now - previousHeartbeatAt - MAIN_PROCESS_HEARTBEAT_INTERVAL_MS
    lastHeartbeatAt = now
    // 必须每拍都采样，Electron 的 percentCPUUsage 是相对上次调用的增量。
    const processMetrics = browserWindow.isDestroyed()
      ? []
      : getProcessMetrics(getRendererPid(browserWindow))
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
      return
    }
    if (stallIncident) {
      stallIncident.lastStallAtMs = now
      stallIncident.count += 1
      stallIncident.totalDurationMs += stallDurationMs
      stallIncident.maxDurationMs = Math.max(stallIncident.maxDurationMs, stallDurationMs)
      return
    }
    stallIncident = {
      startedAtMs: now,
      lastStallAtMs: now,
      count: 1,
      totalDurationMs: stallDurationMs,
      maxDurationMs: stallDurationMs
    }
    log.error('[main-window] main-process event loop stalled', {
      stallDurationMs,
      snapshot: captureSnapshot(browserWindow, {
        sinceMs: previousHeartbeatAt,
        processMetrics
      })
    })
  }, MAIN_PROCESS_HEARTBEAT_INTERVAL_MS)

  browserWindow.webContents.on('unresponsive', () => {
    if (rendererUnresponsiveAt !== null) {
      return
    }
    rendererUnresponsiveAt = Date.now()
    log.error('[main-window] renderer unresponsive', {
      snapshot: captureSnapshot(browserWindow)
    })
  })

  browserWindow.webContents.on('responsive', () => {
    if (rendererUnresponsiveAt === null) {
      return
    }
    const durationMs = Date.now() - rendererUnresponsiveAt
    const sinceMs = rendererUnresponsiveAt
    rendererUnresponsiveAt = null
    log.error('[main-window] renderer recovered', {
      durationMs,
      snapshot: captureSnapshot(browserWindow, { sinceMs })
    })
  })

  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    const durationMs =
      rendererUnresponsiveAt === null ? null : Math.max(0, Date.now() - rendererUnresponsiveAt)
    const sinceMs = rendererUnresponsiveAt ?? Date.now() - 5_000
    rendererUnresponsiveAt = null
    log.error('[main-window] render-process-gone', {
      details,
      unresponsiveDurationMs: durationMs,
      snapshot: captureSnapshot(browserWindow, { sinceMs })
    })
  })

  const dispose = () => {
    finishStallIncident()
    clearInterval(heartbeat)
  }
  browserWindow.once('closed', dispose)
  return dispose
}
