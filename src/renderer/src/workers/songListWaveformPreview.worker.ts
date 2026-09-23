import {
  drawSongListCompactVisualWaveform,
  drawSongListTimelineTicks,
  drawSongListMixxxWaveform,
  drawSongListPioneerPreviewWaveform,
  drawSongListSeratoOverview,
  type SongListWaveformRgbMetricsCacheEntry
} from './songListWaveformPreview.shared'
import type {
  SongListWaveformWorkerData,
  SongListWaveformWorkerIncoming
} from './songListWaveformPreview.types'

type RenderPayload = Extract<SongListWaveformWorkerIncoming, { type: 'render' }>['payload']

const canvasMap = new Map<string, OffscreenCanvas>()
const ctxMap = new Map<string, OffscreenCanvasRenderingContext2D>()
const dataMap = new Map<string, SongListWaveformWorkerData>()
const rgbMetricsCache = new Map<string, SongListWaveformRgbMetricsCacheEntry>()
const pendingRenderByCanvasId = new Map<string, RenderPayload>()
let renderTimer: ReturnType<typeof setTimeout> | null = null

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

const resizeCanvas = (
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  pixelRatio: number
) => {
  const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
  const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))
  if (canvas.width !== scaledWidth) {
    canvas.width = scaledWidth
  }
  if (canvas.height !== scaledHeight) {
    canvas.height = scaledHeight
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.scale(pixelRatio, pixelRatio)
}

const clearCanvas = (canvasId: string) => {
  const canvas = canvasMap.get(canvasId)
  const ctx = ctxMap.get(canvasId)
  if (!canvas || !ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

const renderWaveform = (payload: RenderPayload) => {
  const canvas = canvasMap.get(payload.canvasId)
  const ctx = ctxMap.get(payload.canvasId)
  if (!canvas || !ctx) return

  const width = Math.max(1, Math.floor(payload.width || 1))
  const height = Math.max(1, Math.floor(payload.height || 1))
  const pixelRatio = Math.max(1, Number(payload.pixelRatio) || 1)
  resizeCanvas(canvas, ctx, width, height, pixelRatio)
  ctx.fillStyle = payload.backgroundColor || '#d9dee6'
  ctx.fillRect(0, 0, width, height)

  const data = dataMap.get(payload.filePath) ?? null
  const playedPercent = clamp01(payload.playedPercent)
  if (!data) {
    drawSongListTimelineTicks(ctx, width, height, {
      durationSec: payload.durationSec,
      playedPercent,
      themeVariant: payload.themeVariant
    })
    return
  }

  if (data.kind === 'pioneer') {
    drawSongListPioneerPreviewWaveform(
      ctx,
      width,
      height,
      data.data,
      playedPercent,
      payload.progressColor
    )
    return
  }

  if (data.kind === 'compactVisual') {
    drawSongListCompactVisualWaveform(ctx, width, height, data.data, {
      isHalf: payload.isHalf,
      progressColor: payload.progressColor,
      playedPercent
    })
    return
  }

  if (data.kind === 'serato') {
    drawSongListSeratoOverview(ctx, width, height, data.data, playedPercent, payload.progressColor)
    return
  }

  drawSongListMixxxWaveform(ctx, width, height, payload.filePath, data.data, {
    isHalf: payload.isHalf,
    playedPercent,
    rgbMetricsCache
  })
}

const scheduleRender = () => {
  if (renderTimer) return
  renderTimer = setTimeout(() => {
    renderTimer = null
    const requests = Array.from(pendingRenderByCanvasId.values())
    pendingRenderByCanvasId.clear()
    for (const request of requests) {
      renderWaveform(request)
    }
  }, 0)
}

self.onmessage = (event: MessageEvent<SongListWaveformWorkerIncoming>) => {
  const message = event.data
  if (!message?.type) return

  if (message.type === 'attachCanvas') {
    const canvas = message.payload?.canvas
    const canvasId = String(message.payload?.canvasId || '').trim()
    if (!canvasId || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvasMap.set(canvasId, canvas)
    ctxMap.set(canvasId, ctx)
    return
  }

  if (message.type === 'detachCanvas') {
    const canvasId = String(message.payload?.canvasId || '').trim()
    if (!canvasId) return
    pendingRenderByCanvasId.delete(canvasId)
    canvasMap.delete(canvasId)
    ctxMap.delete(canvasId)
    return
  }

  if (message.type === 'setData') {
    const filePath = String(message.payload?.filePath || '').trim()
    if (!filePath) return
    const data = message.payload?.data ?? null
    if (!data) {
      dataMap.delete(filePath)
      rgbMetricsCache.delete(filePath)
      return
    }
    dataMap.set(filePath, data)
    rgbMetricsCache.delete(filePath)
    return
  }

  if (message.type === 'clearData') {
    const filePath = String(message.payload?.filePath || '').trim()
    if (!filePath) return
    dataMap.delete(filePath)
    rgbMetricsCache.delete(filePath)
    return
  }

  if (message.type === 'clearCanvas') {
    const canvasId = String(message.payload?.canvasId || '').trim()
    if (!canvasId) return
    pendingRenderByCanvasId.delete(canvasId)
    clearCanvas(canvasId)
    return
  }

  if (message.type === 'render') {
    const canvasId = String(message.payload?.canvasId || '').trim()
    if (!canvasId) return
    pendingRenderByCanvasId.set(canvasId, message.payload)
    scheduleRender()
  }
}
