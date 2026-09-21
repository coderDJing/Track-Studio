import { onMounted, onUnmounted, watch, type Ref } from 'vue'
import type { CompactVisualWaveformData } from '@shared/compactVisualWaveform'
import type { MiniPlayerPioneerPreviewWaveform } from '@shared/miniPlayerWindow'
import { drawPlayerCompactVisualWaveform } from '@renderer/pages/modules/songPlayer/playerCompactVisualWaveformRenderer'
import {
  drawWaveformTimelineTicks,
  resolveWaveformTimelineTickThemeVariant
} from '@renderer/components/waveformTimelineTicks'
import { formatSaturatedWaveformRgb } from '@shared/waveformDisplayColor'
import { readCurrentAccentColor } from '@renderer/utils/accentColor'

const WAVEFORM_HEIGHT = 40
const CURSOR_WIDTH = 9
const WAVEFORM_PLAYHEAD_NEEDLE_BACKGROUND = [
  'linear-gradient(90deg,',
  'transparent 0,',
  'transparent 18%,',
  'var(--waveform-playhead-veil, rgba(248, 250, 252, 0.18)) 35%,',
  'var(--waveform-playhead-needle, rgba(248, 250, 252, 0.98)) 50%,',
  'var(--waveform-playhead-veil, rgba(248, 250, 252, 0.18)) 65%,',
  'transparent 82%,',
  'transparent 100%)'
].join(' ')

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const resizeCanvas = (
  targetCanvas: HTMLCanvasElement,
  targetCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  pixelRatio: number
) => {
  const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
  const scaledHeight = Math.floor(height * pixelRatio)
  if (targetCanvas.width !== scaledWidth || targetCanvas.height !== scaledHeight) {
    targetCanvas.width = scaledWidth
    targetCanvas.height = scaledHeight
  }
  targetCanvas.style.width = `${width}px`
  targetCanvas.style.height = `${height}px`
  targetCtx.setTransform(1, 0, 0, 1, 0, 0)
  targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height)
  targetCtx.scale(pixelRatio, pixelRatio)
}

export function useMiniPlayerRemoteWaveform(params: {
  waveformEl: Ref<HTMLDivElement | null>
  compactVisualWaveform: Ref<CompactVisualWaveformData | null>
  pioneerPreviewWaveform: Ref<MiniPlayerPioneerPreviewWaveform | null>
  currentSeconds: Ref<number>
  durationSeconds: Ref<number>
  waveformMode: Ref<'half' | 'full'>
  themeMode: Ref<string | undefined>
  onSeekPercent: (percent: number) => void
}) {
  const baseCanvas = document.createElement('canvas')
  const progressCanvas = document.createElement('canvas')
  const progressWrapper = document.createElement('div')
  const canvasContainer = document.createElement('div')
  const cursorEl = document.createElement('div')
  const cursorNeedleEl = document.createElement('div')
  const interactionLayer = document.createElement('div')
  const baseCtx = baseCanvas.getContext('2d')
  const progressCtx = progressCanvas.getContext('2d')
  if (!baseCtx || !progressCtx) {
    throw new Error('canvas context is null')
  }

  canvasContainer.style.position = 'relative'
  canvasContainer.style.width = '100%'
  canvasContainer.style.height = '100%'
  canvasContainer.style.background = 'var(--waveform-bg)'
  canvasContainer.style.overflow = 'hidden'
  canvasContainer.style.isolation = 'isolate'
  baseCanvas.style.position = 'absolute'
  baseCanvas.style.inset = '0'
  baseCanvas.style.zIndex = '1'
  baseCanvas.style.pointerEvents = 'none'
  progressWrapper.style.position = 'absolute'
  progressWrapper.style.top = '0'
  progressWrapper.style.left = '0'
  progressWrapper.style.height = '100%'
  progressWrapper.style.width = '0%'
  progressWrapper.style.overflow = 'hidden'
  progressWrapper.style.zIndex = '2'
  progressWrapper.style.pointerEvents = 'none'
  progressCanvas.style.position = 'absolute'
  progressCanvas.style.inset = '0'
  progressCanvas.style.pointerEvents = 'none'
  cursorEl.style.position = 'absolute'
  cursorEl.style.top = '0'
  cursorEl.style.height = '100%'
  cursorEl.style.width = `${CURSOR_WIDTH}px`
  cursorEl.style.zIndex = '3'
  cursorEl.style.pointerEvents = 'none'
  cursorEl.style.transform = 'translateX(-50%)'
  cursorNeedleEl.style.position = 'absolute'
  cursorNeedleEl.style.inset = '0'
  cursorNeedleEl.style.borderRadius = '999px'
  cursorNeedleEl.style.background = WAVEFORM_PLAYHEAD_NEEDLE_BACKGROUND
  interactionLayer.style.position = 'absolute'
  interactionLayer.style.inset = '0'
  interactionLayer.style.zIndex = '4'
  interactionLayer.style.cursor = 'pointer'
  cursorEl.appendChild(cursorNeedleEl)
  progressWrapper.appendChild(progressCanvas)
  canvasContainer.appendChild(baseCanvas)
  canvasContainer.appendChild(progressWrapper)
  canvasContainer.appendChild(cursorEl)
  canvasContainer.appendChild(interactionLayer)

  let resizeObserver: ResizeObserver | null = null
  let themeObserver: MutationObserver | null = null
  let mounted = false

  const updateProgressVisual = (progress: number) => {
    const percent = clamp01(progress) * 100
    progressWrapper.style.width = `${percent}%`
    cursorEl.style.left = `${percent}%`
  }

  const clearCanvases = () => {
    baseCtx.setTransform(1, 0, 0, 1, 0, 0)
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
    progressCtx.setTransform(1, 0, 0, 1, 0, 0)
    progressCtx.clearRect(0, 0, progressCanvas.width, progressCanvas.height)
  }

  const drawPioneerPreview = (
    width: number,
    height: number,
    waveformData: MiniPlayerPioneerPreviewWaveform
  ) => {
    const columns = Array.isArray(waveformData.columns) ? waveformData.columns : []
    const maxHeight = Math.max(
      1,
      Number(waveformData.maxHeight) ||
        columns.reduce((value, column) => Math.max(value, Number(column?.backHeight) || 0), 0)
    )
    if (!columns.length || width <= 0 || height <= 0) {
      clearCanvases()
      return
    }
    const pixelRatio = window.devicePixelRatio || 1
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)
    const drawToCanvas = (ctx: CanvasRenderingContext2D, applyTint: boolean) => {
      const columnCount = Math.max(1, Math.floor(width))
      const samplesPerColumn = columns.length / columnCount
      const spacing = width / columnCount
      const drawWidth = Math.max(1, spacing)
      const scaleY = height / maxHeight
      for (let index = 0; index < columnCount; index++) {
        const start = Math.floor(index * samplesPerColumn)
        const end = Math.min(
          columns.length,
          Math.max(start + 1, Math.floor((index + 1) * samplesPerColumn))
        )
        let selected = columns[start] || null
        for (let i = start; i < end; i++) {
          const candidate = columns[i]
          if (!candidate) continue
          if (!selected || (candidate.backHeight || 0) >= (selected.backHeight || 0)) {
            selected = candidate
          }
        }
        if (!selected) continue
        const backHeight = Math.max(0, Number(selected.backHeight) || 0)
        const frontHeight = Math.max(0, Number(selected.frontHeight) || 0)
        const x = Math.min(width - drawWidth, index * spacing)
        if (backHeight > 0) {
          ctx.fillStyle = formatSaturatedWaveformRgb({
            r: selected.backColorR || 0,
            g: selected.backColorG || 0,
            b: selected.backColorB || 0
          })
          ctx.fillRect(
            x,
            height - Math.max(1, backHeight * scaleY),
            drawWidth,
            Math.max(1, backHeight * scaleY)
          )
        }
        if (frontHeight > 0) {
          ctx.fillStyle = formatSaturatedWaveformRgb({
            r: selected.frontColorR || 0,
            g: selected.frontColorG || 0,
            b: selected.frontColorB || 0
          })
          ctx.fillRect(
            x,
            height - Math.max(1, frontHeight * scaleY),
            drawWidth,
            Math.max(1, frontHeight * scaleY)
          )
        }
      }
      if (!applyTint) return
      ctx.save()
      ctx.globalCompositeOperation = 'source-atop'
      ctx.globalAlpha = 0.32
      ctx.fillStyle = readCurrentAccentColor()
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
    }
    drawToCanvas(baseCtx, false)
    drawToCanvas(progressCtx, true)
  }

  const drawWaveform = () => {
    const container = params.waveformEl.value
    if (!container) return
    const width = container.clientWidth || 1
    const height = Math.max(1, container.clientHeight || WAVEFORM_HEIGHT)
    const duration = Math.max(0, params.durationSeconds.value || 0)
    const progress = duration > 0 ? params.currentSeconds.value / duration : 0
    updateProgressVisual(progress)
    const pioneer = params.pioneerPreviewWaveform.value
    if (pioneer) {
      drawPioneerPreview(width, height, pioneer)
      return
    }
    const compact = params.compactVisualWaveform.value
    if (compact) {
      drawPlayerCompactVisualWaveform({
        width,
        height,
        data: compact,
        useHalfWaveform: params.waveformMode.value !== 'full',
        baseCanvas,
        progressCanvas,
        baseCtx,
        progressCtx,
        pixelRatio: window.devicePixelRatio || 1,
        resizeCanvas
      })
      return
    }
    const pixelRatio = window.devicePixelRatio || 1
    const themeVariant = resolveWaveformTimelineTickThemeVariant(params.themeMode.value)
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)
    drawWaveformTimelineTicks(baseCtx, width, height, duration, themeVariant)
    drawWaveformTimelineTicks(progressCtx, width, height, duration, themeVariant, { active: true })
  }

  const getPercentFromClientX = (clientX: number) => {
    const rect = canvasContainer.getBoundingClientRect()
    if (!rect.width) return 0
    return clamp01((clientX - rect.left) / rect.width)
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    params.onSeekPercent(getPercentFromClientX(event.clientX))
  }

  const mountCanvas = () => {
    const container = params.waveformEl.value
    if (!container || mounted) return
    container.prepend(canvasContainer)
    interactionLayer.addEventListener('pointerdown', handlePointerDown)
    resizeObserver = new ResizeObserver(() => drawWaveform())
    resizeObserver.observe(container)
    themeObserver = new MutationObserver(() => drawWaveform())
    ;[document.documentElement, document.body, document.getElementById('app')].forEach((target) => {
      if (target) {
        themeObserver?.observe(target, { attributes: true, attributeFilter: ['class', 'style'] })
      }
    })
    mounted = true
    drawWaveform()
  }

  const unmountCanvas = () => {
    interactionLayer.removeEventListener('pointerdown', handlePointerDown)
    resizeObserver?.disconnect()
    themeObserver?.disconnect()
    resizeObserver = null
    themeObserver = null
    canvasContainer.remove()
    mounted = false
  }

  watch(
    [
      params.compactVisualWaveform,
      params.pioneerPreviewWaveform,
      params.durationSeconds,
      params.waveformMode,
      params.themeMode
    ],
    () => drawWaveform()
  )
  watch(params.currentSeconds, () => {
    const duration = Math.max(0, params.durationSeconds.value || 0)
    updateProgressVisual(duration > 0 ? params.currentSeconds.value / duration : 0)
  })

  onMounted(mountCanvas)
  onUnmounted(unmountCanvas)

  return {
    drawWaveform
  }
}

export const miniPlayerWaveformHeight = WAVEFORM_HEIGHT
