import pkg from '../../../../package.json'

type ChromiumPerformanceMemory = {
  usedJSHeapSize?: unknown
  totalJSHeapSize?: unknown
  jsHeapSizeLimit?: unknown
}

const HEARTBEAT_INTERVAL_MS = 1_000
const STALL_THRESHOLD_MS = 3_000
const REPORT_COOLDOWN_MS = 30_000

let installed = false

const toMiB = (value: unknown): number | undefined => {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return undefined
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

const getHeapSnapshot = () => {
  const memory = (performance as Performance & { memory?: ChromiumPerformanceMemory }).memory
  if (!memory) return undefined
  return {
    usedMiB: toMiB(memory.usedJSHeapSize),
    totalMiB: toMiB(memory.totalJSHeapSize),
    limitMiB: toMiB(memory.jsHeapSizeLimit)
  }
}

const getRecentMeasureSummary = () => {
  const measures = performance.getEntriesByType('measure')
  return {
    count: measures.length,
    recent: measures.slice(-6).map((entry) => ({
      name: entry.name,
      durationMs: Math.round(entry.duration)
    }))
  }
}

const reportRendererStall = (details: Record<string, unknown>) => {
  try {
    window.electron.ipcRenderer.send('outputLog', {
      level: 'warn',
      source: 'renderer',
      scope: 'renderer-stall-diagnostic',
      message: `renderer event loop delayed ${JSON.stringify(details)}`
    })
  } catch {}
}

export const installRendererStallDiagnostics = (): void => {
  if (installed || import.meta.env.DEV || !String(pkg.version || '').includes('-rc.')) return
  installed = true

  let previousHeartbeatAt = performance.now()
  let lastReportAt = -REPORT_COOLDOWN_MS
  window.setInterval(() => {
    const now = performance.now()
    const delayMs = now - previousHeartbeatAt - HEARTBEAT_INTERVAL_MS
    previousHeartbeatAt = now
    if (delayMs < STALL_THRESHOLD_MS || now - lastReportAt < REPORT_COOLDOWN_MS) return
    lastReportAt = now
    reportRendererStall({
      delayMs: Math.round(delayMs),
      visibilityState: document.visibilityState,
      heap: getHeapSnapshot(),
      userTiming: getRecentMeasureSummary()
    })
  }, HEARTBEAT_INTERVAL_MS)
}
