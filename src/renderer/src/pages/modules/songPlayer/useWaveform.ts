import { onMounted, onUnmounted, watch, type Ref } from 'vue'
import {
  WebAudioPlayer,
  type SeekedEventPayload,
  type WebAudioPlayerEvents
} from './webAudioPlayer'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import { formatSaturatedWaveformRgb } from '@shared/waveformDisplayColor'
import { drawPlayerCompactVisualWaveform } from './playerCompactVisualWaveformRenderer'
import {
  drawWaveformTimelineTicks,
  resolveWaveformTimelineTickThemeVariant
} from '@renderer/components/waveformTimelineTicks'
import { normalizeSongStructureAnalysis } from '@shared/songStructure'
import { readCurrentAccentColor } from '@renderer/utils/accentColor'

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

export function useWaveform(params: {
  waveformEl: Ref<HTMLDivElement | null>
  audioPlayer: Ref<WebAudioPlayer | null>
  runtime: ReturnType<typeof useRuntimeStore>
  updateParentWaveformWidth: () => void
  onNextSong: () => void
  onError?: (error: unknown) => void
}) {
  const { waveformEl, audioPlayer, runtime, updateParentWaveformWidth, onNextSong, onError } =
    params

  const waveformHeight = 40
  const cursorWidth = 9
  const pointerPreloadDeferRefreshMs = 1000

  const useHalfWaveform = () => (runtime.setting?.waveformMode ?? 'half') !== 'full'

  const canvasContainer = document.createElement('div')
  canvasContainer.style.position = 'relative'
  canvasContainer.style.width = '100%'
  canvasContainer.style.height = `${waveformHeight}px`
  canvasContainer.style.pointerEvents = 'auto'
  canvasContainer.style.background = 'var(--waveform-bg)'
  canvasContainer.style.overflow = 'hidden'
  canvasContainer.style.isolation = 'isolate'

  const baseCanvas = document.createElement('canvas')
  const progressCanvas = document.createElement('canvas')
  const progressWrapper = document.createElement('div')
  const cursorEl = document.createElement('div')
  const cursorNeedleEl = document.createElement('div')
  const interactionLayer = document.createElement('div')

  baseCanvas.style.position = 'absolute'
  baseCanvas.style.top = '0'
  baseCanvas.style.left = '0'
  baseCanvas.style.zIndex = '1'
  baseCanvas.style.display = 'block'
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
  progressCanvas.style.top = '0'
  progressCanvas.style.left = '0'
  progressCanvas.style.display = 'block'
  progressCanvas.style.pointerEvents = 'none'

  cursorEl.style.position = 'absolute'
  cursorEl.style.top = '0'
  cursorEl.style.left = '0'
  cursorEl.style.height = '100%'
  cursorEl.style.width = `${cursorWidth}px`
  cursorEl.style.background = 'transparent'
  cursorEl.style.zIndex = '3'
  cursorEl.style.pointerEvents = 'none'
  cursorEl.style.transform = 'translateX(-50%)'
  cursorEl.style.opacity = '1'

  cursorNeedleEl.style.position = 'absolute'
  cursorNeedleEl.style.inset = '0'
  cursorNeedleEl.style.borderRadius = '999px'
  cursorNeedleEl.style.background = WAVEFORM_PLAYHEAD_NEEDLE_BACKGROUND
  cursorNeedleEl.style.pointerEvents = 'none'

  interactionLayer.style.position = 'absolute'
  interactionLayer.style.top = '0'
  interactionLayer.style.left = '0'
  interactionLayer.style.width = '100%'
  interactionLayer.style.height = '100%'
  interactionLayer.style.zIndex = '4'
  interactionLayer.style.cursor = 'pointer'
  interactionLayer.style.background = 'transparent'

  const baseCtx = baseCanvas.getContext('2d')
  const progressCtx = progressCanvas.getContext('2d')
  if (!baseCtx || !progressCtx) throw new Error('canvas context is null')

  canvasContainer.appendChild(baseCanvas)
  progressWrapper.appendChild(progressCanvas)
  canvasContainer.appendChild(progressWrapper)
  cursorEl.appendChild(cursorNeedleEl)
  canvasContainer.appendChild(cursorEl)
  canvasContainer.appendChild(interactionLayer)

  let animationFrameId: number | null = null
  let audioBuffer: AudioBuffer | null = null
  let hoverEl: HTMLElement | null = null
  let isPointerDown = false
  let lastPointerPreloadDeferAt = 0
  let themeClassObserver: MutationObserver | null = null
  type AudioEventName = keyof WebAudioPlayerEvents
  const audioEventHandlers: Array<() => void> = []

  const registerPlayerHandler = <K extends AudioEventName>(
    player: WebAudioPlayer,
    event: K,
    handler: (payload: WebAudioPlayerEvents[K]) => void
  ) => {
    player.on(event, handler)
    audioEventHandlers.push(() => {
      player.off(event, handler)
    })
  }

  const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

  const getPercentFromClientX = (clientX: number) => {
    const rect = canvasContainer.getBoundingClientRect()
    if (!rect.width) return 0
    return clamp01((clientX - rect.left) / rect.width)
  }

  const syncHoverOverlay = (percent: number) => {
    if (hoverEl) {
      hoverEl.style.width = `${percent * 100}%`
    }
  }

  const resolveSeekTarget = (percent: number) => {
    const player = audioPlayer.value
    if (!player) return null
    const duration = resolveWaveformTimelineDuration(player)
    if (duration <= 0 || !Number.isFinite(duration)) return null
    const clampedPercent = clamp01(percent)
    return {
      duration,
      percent: clampedPercent,
      timeSec: duration * clampedPercent
    }
  }

  const deferManualSeekPreloads = (force = false) => {
    const player = audioPlayer.value
    if (!player) return
    const now = performance.now()
    if (!force && now - lastPointerPreloadDeferAt < pointerPreloadDeferRefreshMs) return
    lastPointerPreloadDeferAt = now
    player.deferMetadataPreloadsForManualSeek()
  }

  const commitSeekPercent = (percent: number) => {
    const target = resolveSeekTarget(percent)
    const player = audioPlayer.value
    if (!target || !player) return false
    player.seek(target.timeSec, true)
    return true
  }

  const handlePointerMove = (event: PointerEvent) => {
    const percent = getPercentFromClientX(event.clientX)
    syncHoverOverlay(percent)
    if (isPointerDown) {
      deferManualSeekPreloads()
    }
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    isPointerDown = true
    try {
      interactionLayer.setPointerCapture(event.pointerId)
    } catch {}
    const percent = getPercentFromClientX(event.clientX)
    syncHoverOverlay(percent)
    deferManualSeekPreloads(true)
  }

  const finishPointerSeek = (event: PointerEvent, commit: boolean) => {
    if (!isPointerDown) return
    const percent = getPercentFromClientX(event.clientX)
    if (commit) commitSeekPercent(percent)
    isPointerDown = false
    try {
      interactionLayer.releasePointerCapture(event.pointerId)
    } catch {}
  }

  const handlePointerUp = (event: PointerEvent) => {
    finishPointerSeek(event, true)
  }

  const handlePointerCancel = (event: PointerEvent) => {
    finishPointerSeek(event, false)
  }

  const handlePointerLeave = () => {
    if (!isPointerDown) {
      syncHoverOverlay(0)
    }
  }

  interactionLayer.addEventListener('pointermove', handlePointerMove)
  interactionLayer.addEventListener('pointerdown', handlePointerDown)
  interactionLayer.addEventListener('pointerup', handlePointerUp)
  interactionLayer.addEventListener('pointercancel', handlePointerCancel)
  interactionLayer.addEventListener('pointerleave', handlePointerLeave)

  const handleResize = () => {
    updateWaveform()
  }

  const bindThemeClassObserver = () => {
    if (themeClassObserver || typeof MutationObserver === 'undefined') return
    const targets = [
      document.documentElement,
      document.body,
      document.getElementById('app')
    ].filter((target): target is HTMLElement => Boolean(target))
    if (!targets.length) return
    themeClassObserver = new MutationObserver(() => {
      updateWaveform()
    })
    for (const target of targets) {
      themeClassObserver.observe(target, {
        attributes: true,
        attributeFilter: ['class']
      })
    }
  }

  const updateProgressVisual = (progress: number) => {
    const clamped = Math.max(0, Math.min(1, progress || 0))
    const percent = clamped * 100
    progressWrapper.style.clipPath = ''
    progressWrapper.style.width = `${percent}%`
    progressWrapper.style.transform = `translateX(0)`
    cursorEl.style.left = `${percent}%`
  }

  const resolveWaveformTimelineDuration = (player: WebAudioPlayer) => {
    const compactDuration = Number(player.compactVisualWaveformData?.duration)
    if (Number.isFinite(compactDuration) && compactDuration > 0) return compactDuration
    const structureDuration = Number(
      normalizeSongStructureAnalysis(runtime.playingData.playingSong?.songStructure)?.durationSec
    )
    if (Number.isFinite(structureDuration) && structureDuration > 0) return structureDuration
    const playerDuration = Number(player.getDuration())
    if (Number.isFinite(playerDuration) && playerDuration > 0) return playerDuration
    const bufferDuration = Number(audioBuffer?.duration)
    return Number.isFinite(bufferDuration) && bufferDuration > 0 ? bufferDuration : 0
  }

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

  const clearCanvases = () => {
    baseCtx.setTransform(1, 0, 0, 1, 0, 0)
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
    progressCtx.setTransform(1, 0, 0, 1, 0, 0)
    progressCtx.clearRect(0, 0, progressCanvas.width, progressCanvas.height)
  }

  const drawEmptyTimelineTicks = (width: number, height: number, duration: number) => {
    const pixelRatio = window.devicePixelRatio || 1
    const themeVariant = resolveWaveformTimelineTickThemeVariant(runtime.setting?.themeMode)
    resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
    resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)
    drawWaveformTimelineTicks(baseCtx, width, height, duration, themeVariant)
    drawWaveformTimelineTicks(progressCtx, width, height, duration, themeVariant, { active: true })
  }

  const drawPioneerPreviewWaveform = (
    width: number,
    height: number,
    waveformData: IPioneerPreviewWaveformData,
    progressColor: string,
    tintProgress = false
  ) => {
    const columns = Array.isArray(waveformData?.columns) ? waveformData.columns : []
    const maxHeight = Math.max(
      1,
      Number(waveformData?.maxHeight) ||
        columns.reduce((value, column) => Math.max(value, Number(column?.backHeight) || 0), 0)
    )
    if (!columns.length || width <= 0 || height <= 0 || maxHeight <= 0) {
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
          const backPixelHeight = Math.max(1, backHeight * scaleY)
          ctx.fillStyle = formatSaturatedWaveformRgb({
            r: selected.backColorR || 0,
            g: selected.backColorG || 0,
            b: selected.backColorB || 0
          })
          ctx.fillRect(x, height - backPixelHeight, drawWidth, backPixelHeight)
        }

        if (frontHeight > 0) {
          const frontPixelHeight = Math.max(1, frontHeight * scaleY)
          ctx.fillStyle = formatSaturatedWaveformRgb({
            r: selected.frontColorR || 0,
            g: selected.frontColorG || 0,
            b: selected.frontColorB || 0
          })
          ctx.fillRect(x, height - frontPixelHeight, drawWidth, frontPixelHeight)
        }
      }

      if (!applyTint) return
      ctx.save()
      ctx.globalCompositeOperation = 'source-atop'
      ctx.globalAlpha = 0.32
      ctx.fillStyle = progressColor
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
    }

    drawToCanvas(baseCtx, false)
    drawToCanvas(progressCtx, tintProgress)
  }

  const drawWaveform = (forceRedraw = false) => {
    if (!waveformEl.value || !audioPlayer.value) return

    const container = waveformEl.value
    const width = container.clientWidth || 1
    const height = waveformHeight
    const player = audioPlayer.value
    const pioneerPreviewData = player.pioneerPreviewWaveformData ?? null
    const compactVisualData = player.compactVisualWaveformData ?? null

    const duration = resolveWaveformTimelineDuration(player)
    const currentTime = player?.getCurrentTime?.() ?? 0
    const progress = duration > 0 ? currentTime / duration : 0
    updateProgressVisual(progress)

    if (!forceRedraw) {
      return
    }

    if (pioneerPreviewData) {
      drawPioneerPreviewWaveform(width, height, pioneerPreviewData, readCurrentAccentColor(), true)
      return
    }

    if (compactVisualData) {
      drawPlayerCompactVisualWaveform({
        width,
        height,
        data: compactVisualData,
        useHalfWaveform: useHalfWaveform(),
        baseCanvas,
        progressCanvas,
        baseCtx,
        progressCtx,
        pixelRatio: window.devicePixelRatio || 1,
        resizeCanvas
      })
      return
    }

    drawEmptyTimelineTicks(width, height, duration)
  }

  let ro: ResizeObserver | null = null

  const updateWaveform = () => {
    if (!audioPlayer.value) return
    const player = audioPlayer.value
    const pioneerPreviewData = player.pioneerPreviewWaveformData ?? null
    const compactVisualData = player.compactVisualWaveformData ?? null
    if (!pioneerPreviewData && !compactVisualData) {
      audioBuffer = null
      drawWaveform(true)
      syncHoverOverlay(0)
      return
    }

    if (pioneerPreviewData) {
      audioBuffer = null
      drawWaveform(true)
      return
    }

    const buffer = player.audioBuffer ?? null
    audioBuffer = buffer
    drawWaveform(true)
  }

  const animate = () => {
    const isPlaying = audioPlayer.value?.isPlaying() ?? false
    if (isPlaying) {
      drawWaveform()
    }
    animationFrameId = requestAnimationFrame(animate)
  }

  const attachEventListeners = () => {
    const player = audioPlayer.value
    if (!player) return
    const getTimeEl = () => document.querySelector('#time') as HTMLElement | null
    const getDurationEl = () => document.querySelector('#duration') as HTMLElement | null

    const formatTime = (seconds: number) => {
      const minutes = Math.floor(seconds / 60)
      const secondsRemainder = Math.round(seconds) % 60
      const paddedSeconds = `0${secondsRemainder}`.slice(-2)
      return `${minutes}:${paddedSeconds}`
    }

    const updateDurationDisplay = (seconds: number) => {
      const el = getDurationEl()
      if (el) el.textContent = formatTime(seconds)
    }

    const updateTimeDisplay = (seconds: number) => {
      const el = getTimeEl()
      if (el) el.textContent = formatTime(seconds)
    }

    const handleDecode = (duration: number) => {
      updateDurationDisplay(duration)
      updateProgressVisual(0)
      updateParentWaveformWidth()
      updateWaveform()
      setTimeout(() => {
        updateParentWaveformWidth()
        updateWaveform()
      }, 50)
    }

    const handleReady = () => {
      const playerDuration = audioPlayer.value?.getDuration?.()
      if (typeof playerDuration === 'number') {
        updateDurationDisplay(playerDuration)
      }
      updateProgressVisual(0)
      updateParentWaveformWidth()
      updateWaveform()
      setTimeout(() => {
        updateParentWaveformWidth()
        updateWaveform()
      }, 50)
    }

    const handlePlay = () => {
      runtime.playerReady = true
      runtime.isSwitchingSong = false
    }

    const handlePause = () => {
      drawWaveform()
    }

    const handleTimeUpdate = (currentTime: number) => {
      drawWaveform()
      updateTimeDisplay(currentTime)
    }

    const handleFinish = () => {
      if (runtime.setting.autoPlayNextSong) {
        onNextSong()
      }
      drawWaveform()
    }

    registerPlayerHandler(player, 'decode', handleDecode)
    registerPlayerHandler(player, 'ready', handleReady)
    const handleSeeked = (payload: SeekedEventPayload) => {
      drawWaveform()
      updateTimeDisplay(payload.time)
    }

    registerPlayerHandler(player, 'play', handlePlay)
    registerPlayerHandler(player, 'pause', handlePause)
    registerPlayerHandler(player, 'timeupdate', handleTimeUpdate)
    registerPlayerHandler(player, 'seeked', handleSeeked)
    registerPlayerHandler(player, 'finish', handleFinish)
    registerPlayerHandler(player, 'waveformready', () => {
      updateWaveform()
    })

    if (onError) {
      const handleError = (error: unknown) => {
        onError(error)
      }
      registerPlayerHandler(player, 'error', handleError)
    }
  }

  const detachEventListeners = () => {
    if (audioEventHandlers.length) {
      for (const dispose of audioEventHandlers) {
        try {
          dispose()
        } catch {}
      }
      audioEventHandlers.length = 0
    }
  }

  watch(
    () => waveformEl.value,
    (newEl) => {
      if (newEl) {
        if (!canvasContainer.parentNode) {
          if (newEl.firstChild) newEl.insertBefore(canvasContainer, newEl.firstChild)
          else newEl.appendChild(canvasContainer)
        }
        if (!baseCanvas.parentNode) {
          canvasContainer.appendChild(baseCanvas)
        }
        if (!progressWrapper.parentNode) {
          canvasContainer.appendChild(progressWrapper)
        }
        if (!progressCanvas.parentNode) {
          progressWrapper.appendChild(progressCanvas)
        }
        if (!cursorEl.parentNode) {
          canvasContainer.appendChild(cursorEl)
        }
        if (!cursorNeedleEl.parentNode) {
          cursorEl.appendChild(cursorNeedleEl)
        }
        if (!interactionLayer.parentNode) {
          canvasContainer.appendChild(interactionLayer)
        }
        hoverEl = newEl.querySelector('#hover')
        canvasContainer.style.height = `${waveformHeight}px`
        // 观察容器尺寸变化，防止首次为 0 宽导致不渲染
        try {
          if (ro) ro.disconnect()
          ro = new ResizeObserver(() => {
            // 宽度变化时重绘
            updateWaveform()
          })
          ro.observe(newEl)
        } catch {}
      } else {
        hoverEl = null
        if (ro) {
          try {
            ro.disconnect()
          } catch {}
          ro = null
        }
      }
    },
    { immediate: true }
  )

  watch(
    () => runtime.setting?.waveformMode,
    () => {
      updateWaveform()
    }
  )

  watch(
    () => runtime.setting?.themeMode,
    () => {
      setTimeout(() => {
        updateWaveform()
      }, 0)
    }
  )

  watch(
    () => runtime.setting?.accentColor,
    () => {
      setTimeout(() => {
        updateWaveform()
      }, 0)
    }
  )

  watch(
    () => audioPlayer.value,
    () => {
      detachEventListeners()
      attachEventListeners()
      updateProgressVisual(0)
      updateWaveform()
    },
    { immediate: true }
  )

  watch(
    () => runtime.setting.hiddenPlayControlArea,
    () => {
      if (waveformEl.value) {
        setTimeout(() => {
          updateWaveform()
        }, 100)
      }
    }
  )

  onMounted(() => {
    if (animationFrameId === null) {
      animationFrameId = requestAnimationFrame(animate)
    }
    bindThemeClassObserver()
    window.addEventListener('resize', handleResize)
  })

  onUnmounted(() => {
    detachEventListeners()
    window.removeEventListener('resize', handleResize)
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    if (ro) {
      try {
        ro.disconnect()
      } catch {}
      ro = null
    }
    if (themeClassObserver) {
      try {
        themeClassObserver.disconnect()
      } catch {}
      themeClassObserver = null
    }
    interactionLayer.removeEventListener('pointermove', handlePointerMove)
    interactionLayer.removeEventListener('pointerdown', handlePointerDown)
    interactionLayer.removeEventListener('pointerup', handlePointerUp)
    interactionLayer.removeEventListener('pointercancel', handlePointerCancel)
    interactionLayer.removeEventListener('pointerleave', handlePointerLeave)
    hoverEl = null
    if (canvasContainer.parentNode) {
      canvasContainer.parentNode.removeChild(canvasContainer)
    }
  })

  return {
    updateWaveform,
    drawWaveform
  }
}
