import type { HorizontalBrowseStableCanvasPresentationFrame } from './horizontalBrowseStableCanvasPresentation'
import type { HorizontalBrowseTransportSnapshot } from '@shared/horizontalBrowseTransport'

// 临时排查：仅开发模式启用，每次开始/恢复播放采集 60 秒，明细最多 40 条、汇总每秒一条。
// 排查期间可将此开关改为 false；根因确认且另一台电脑验证通过后删除本模块与接线。
const STARTUP_DIAGNOSTICS_ENABLED = import.meta.env.DEV
const STARTUP_WINDOW_MS = 60_000
const REPORT_INTERVAL_MS = 1_000
const MAX_EVENT_REPORTS = 40
let transportSnapshot: HorizontalBrowseTransportSnapshot | null = null

export const recordHorizontalBrowseWaveformStartupTransport = (
  snapshot: HorizontalBrowseTransportSnapshot
) => {
  if (!STARTUP_DIAGNOSTICS_ENABLED || typeof window === 'undefined') return
  const previous = transportSnapshot
  transportSnapshot = snapshot
  for (const deck of ['top', 'bottom'] as const) {
    const nextState = snapshot[deck]
    const oldState = previous?.[deck]
    if (
      nextState.loaded === oldState?.loaded &&
      nextState.decoding === oldState?.decoding &&
      nextState.fullDecoding === oldState?.fullDecoding &&
      nextState.fullyDecoded === oldState?.fullyDecoded
    )
      continue
    try {
      window.electron.ipcRenderer.send('outputLog', {
        level: 'info',
        source: 'renderer',
        scope: 'hb-waveform-startup',
        message: JSON.stringify({ event: 'decode-state', deck, state: nextState })
      })
    } catch {}
  }
}

type DiagnosticOptions = {
  direction: () => string
  canvas: () => HTMLElement | null
  currentSeconds: () => number
  playbackRate: () => number
  linked: () => boolean
}

const rounded = (value: number) =>
  Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null

const describeSurface = (surface: HTMLElement | null) => {
  if (!surface) return null
  const rect = surface.getBoundingClientRect()
  const pixelRatio = window.devicePixelRatio || 1
  const scaler = surface.parentElement
  const tiles = Array.from(surface.querySelectorAll('canvas')).slice(0, 2)
  return {
    tag: surface.tagName,
    pixelRatio,
    left: rounded(rect.left),
    top: rounded(rect.top),
    width: rounded(rect.width),
    height: rounded(rect.height),
    transform: surface.style.transform,
    scalerTransform: scaler ? getComputedStyle(scaler).transform : null,
    tiles: tiles.map((tile) => {
      const tileRect = tile.getBoundingClientRect()
      return {
        leftDevicePx: rounded(tileRect.left * pixelRatio),
        topDevicePx: rounded(tileRect.top * pixelRatio),
        cssWidth: rounded(tileRect.width),
        bitmapWidth: tile.width,
        cssHeight: rounded(tileRect.height),
        bitmapHeight: tile.height,
        imageRendering: getComputedStyle(tile).imageRendering
      }
    })
  }
}

// 诊断读取失败不能中断播放动画。
const safelyDescribeSurface = (surface: HTMLElement | null) => {
  try {
    return describeSurface(surface)
  } catch {
    return null
  }
}

export const createHorizontalBrowseWaveformStartupDiagnostics = (options: DiagnosticOptions) => {
  const enabled = STARTUP_DIAGNOSTICS_ENABLED && typeof window !== 'undefined'
  let startedAtMs = performance.now()
  let lastReportAtMs = startedAtMs
  let eventCount = 0
  let queuedAtMs = 0
  let lastTickAtMs = 0
  let lastOffsetPx: number | null = null
  let lastRenderToken = -1
  let ticks = 0
  let maxFrameGapMs = 0
  let slowFrames = 0
  let backwardsSteps = 0
  let repeatedSteps = 0
  let maxStepErrorDevicePx = 0
  let maxClockDriftMs = 0

  const inWindow = (nowMs: number) => enabled && nowMs - startedAtMs <= STARTUP_WINDOW_MS
  const write = (event: string, details: Record<string, unknown>) => {
    try {
      window.electron.ipcRenderer.send('outputLog', {
        level: 'info',
        source: 'renderer',
        scope: 'hb-waveform-startup',
        message: JSON.stringify({
          event,
          direction: options.direction(),
          ageMs: rounded(performance.now() - startedAtMs),
          sourceSeconds: rounded(options.currentSeconds()),
          playbackRate: rounded(options.playbackRate()),
          linked: options.linked(),
          transport: transportSnapshot?.[options.direction() === 'up' ? 'top' : 'bottom'],
          ...details
        })
      })
    } catch {}
  }
  const resetCounters = () => {
    ticks = 0
    maxFrameGapMs = 0
    slowFrames = 0
    backwardsSteps = 0
    repeatedSteps = 0
    maxStepErrorDevicePx = 0
    maxClockDriftMs = 0
  }
  const event = (name: string, details: Record<string, unknown> = {}) => {
    if (!inWindow(performance.now()) || eventCount >= MAX_EVENT_REPORTS) return
    eventCount += 1
    write(name, { ...details, surface: safelyDescribeSurface(options.canvas()) })
  }
  return {
    beginPlayback() {
      startedAtMs = performance.now()
      lastReportAtMs = startedAtMs
      eventCount = 0
      lastTickAtMs = 0
      lastOffsetPx = null
      resetCounters()
    },
    reset() {
      startedAtMs = performance.now()
      lastReportAtMs = startedAtMs
      eventCount = 0
      queuedAtMs = 0
      lastTickAtMs = 0
      lastOffsetPx = null
      lastRenderToken = -1
      resetCounters()
    },
    event,
    queue(frame: HorizontalBrowseStableCanvasPresentationFrame | null) {
      if (!frame || !inWindow(performance.now())) return
      queuedAtMs = performance.now()
      event('queue-frame', { frame })
    },
    rendered(renderToken: number, ready: boolean, viewportOnly: boolean) {
      event('worker-ready', {
        renderToken,
        ready,
        viewportOnly,
        workerWaitMs: rounded(performance.now() - queuedAtMs)
      })
    },
    tick(
      seconds: number,
      frame: HorizontalBrowseStableCanvasPresentationFrame | null,
      offsetPx: number | null
    ) {
      const nowMs = performance.now()
      if (!inWindow(nowMs)) return
      const gapMs = lastTickAtMs ? nowMs - lastTickAtMs : 0
      if (gapMs) {
        maxFrameGapMs = Math.max(maxFrameGapMs, gapMs)
        if (gapMs > 25) slowFrames += 1
      }
      if (
        frame &&
        offsetPx !== null &&
        lastOffsetPx !== null &&
        frame.renderToken === lastRenderToken
      ) {
        const stepPx = offsetPx - lastOffsetPx
        if (stepPx > 0) backwardsSteps += 1
        if (stepPx === 0) repeatedSteps += 1
        const expectedStepPx =
          (-(gapMs / 1000) * options.playbackRate() * frame.renderWidth) / frame.rangeDurationSec
        maxStepErrorDevicePx = Math.max(
          maxStepErrorDevicePx,
          Math.abs(stepPx - expectedStepPx) * frame.pixelRatio
        )
      }
      ticks += 1
      lastTickAtMs = nowMs
      lastOffsetPx = offsetPx
      lastRenderToken = frame?.renderToken ?? -1
      maxClockDriftMs = Math.max(
        maxClockDriftMs,
        Math.abs(seconds - options.currentSeconds()) * 1000
      )
      if (nowMs - lastReportAtMs < REPORT_INTERVAL_MS) return
      write('scroll-summary', {
        ticks,
        maxFrameGapMs: rounded(maxFrameGapMs),
        slowFrames,
        backwardsSteps,
        repeatedSteps,
        maxStepErrorDevicePx: rounded(maxStepErrorDevicePx),
        maxClockDriftMs: rounded(maxClockDriftMs),
        visualSeconds: rounded(seconds),
        offsetCssPx: rounded(offsetPx ?? 0),
        renderToken: frame?.renderToken,
        frameAnchorSec: frame?.anchorSec,
        surface: safelyDescribeSurface(options.canvas())
      })
      lastReportAtMs = nowMs
      resetCounters()
    }
  }
}
