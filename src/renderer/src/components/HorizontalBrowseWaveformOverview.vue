<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import type {
  IPioneerPreviewWaveformData,
  ISongHotCue,
  ISongInfo,
  ISongMemoryCue
} from 'src/types/globals'
import HotCueMarkersLayer from '@renderer/components/HotCueMarkersLayer.vue'
import MemoryCueMarkersLayer from '@renderer/components/MemoryCueMarkersLayer.vue'
import PlaybackRangeHandles from '@renderer/pages/modules/songPlayer/PlaybackRangeHandles.vue'
import { isSameHorizontalBrowseSongFilePath } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellSongs'
import {
  getRekordboxPreviewWaveformRequestChannel,
  resolveSongExternalWaveformSource
} from '@renderer/utils/rekordboxExternalSource'
import type { WaveformGlobalOverviewData } from '@shared/waveformSurfaceCache'
import { formatSaturatedWaveformRgb } from '@shared/waveformDisplayColor'
import { loadWaveformGlobalOverviewData } from '@renderer/composables/horizontalBrowse/horizontalBrowseCompactVisualWaveform'
import { drawCompactVisualWaveform } from '@renderer/components/compactVisualWaveformRenderer'
import {
  drawWaveformTimelineTicks,
  resolveWaveformTimelineTickThemeVariant
} from '@renderer/components/waveformTimelineTicks'
import {
  normalizeSongStructureAnalysis,
  type SongStructureSection,
  type SongStructureSectionKind
} from '@shared/songStructure'
import type { HorizontalBrowsePlaybackRangeOverlay } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseEditPlaybackRange'
import type { AudioEditClip, AudioEditRange } from '@shared/audioEditTimeline'
import { remapAudioEditOverviewWaveform } from '@renderer/composables/horizontalBrowse/audioEditCompactWaveform'

const props = defineProps<{
  song: ISongInfo | null
  currentSeconds?: number
  durationSeconds?: number
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
  markerAnchor?: 'top' | 'bottom'
  loopRange?: { startSec: number; endSec: number } | null
  sectionSeekMode?: 'seek' | 'seek-play'
  playbackRange?: HorizontalBrowsePlaybackRangeOverlay | null
  audioEditHasEdits?: boolean
  audioEditClips?: AudioEditClip[] | null
  audioEditSelection?: AudioEditRange | null
  audioEditPendingStartSec?: number | null
  audioEditPendingEndSec?: number | null
  audioEditInsertedRanges?: AudioEditRange[] | null
}>()

const emit = defineEmits<{
  (event: 'seek', value: number): void
  (event: 'seek-play', value: number): void
}>()

type PioneerPreviewWaveformResponse = {
  items?: Array<{ analyzePath: string; data: IPioneerPreviewWaveformData | null }>
}

const runtime = useRuntimeStore()
const trackRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const compactVisualData = ref<WaveformGlobalOverviewData | null>(null)
const pioneerPreviewData = ref<IPioneerPreviewWaveformData | null>(null)
const scrubbing = ref(false)
const trackWidth = ref(0)

let resizeObserver: ResizeObserver | null = null
let themeClassObserver: MutationObserver | null = null
let loadToken = 0
let seekRaf = 0
let pendingSeekSeconds: number | null = null
let lastSeekEmitAt = 0
let lastSeekEmitSeconds: number | null = null
let activeScrubPointerId: number | null = null
const SEEK_EMIT_DUPLICATE_WINDOW_MS = 350
const SEEK_EMIT_DUPLICATE_EPSILON_SEC = 0.05
const SEEK_EMIT_DUPLICATE_EPSILON_PX = 2

const parseDurationToSeconds = (input: unknown) => {
  const raw = String(input || '').trim()
  if (!raw) return 0
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) || 0)
  const parts = raw
    .split(':')
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part))
  if (!parts.length) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}

const resolvePositiveSeconds = (input: unknown) => {
  const value = Number(input)
  return Number.isFinite(value) && value > 0 ? value : 0
}

const normalizedStructure = computed(() =>
  normalizeSongStructureAnalysis(props.song?.songStructure)
)

const displayWaveformData = computed(() => {
  if (!props.audioEditHasEdits || !props.audioEditClips?.length) return compactVisualData.value
  return remapAudioEditOverviewWaveform(compactVisualData.value, props.audioEditClips)
})

const totalSeconds = computed(() => {
  const compactDuration = resolvePositiveSeconds(displayWaveformData.value?.duration)
  if (compactDuration > 0) return compactDuration
  const structureDuration = resolvePositiveSeconds(normalizedStructure.value?.durationSec)
  if (structureDuration > 0) return structureDuration
  const explicit = resolvePositiveSeconds(props.durationSeconds)
  if (explicit > 0) return explicit
  return parseDurationToSeconds(props.song?.duration)
})

const playheadLeft = computed(() => {
  if (!props.song || totalSeconds.value <= 0) return null
  const current = Number(props.currentSeconds)
  const ratio = Number.isFinite(current)
    ? Math.max(0, Math.min(1, current / totalSeconds.value))
    : 0
  return `${ratio * 100}%`
})

const loopMaskStyle = computed(() => {
  const loopRange = props.loopRange
  if (!loopRange || totalSeconds.value <= 0) return null
  const startSec = Math.max(0, Number(loopRange.startSec) || 0)
  const endSec = Math.max(startSec, Number(loopRange.endSec) || 0)
  if (endSec <= startSec) return null
  return {
    left: `${(startSec / totalSeconds.value) * 100}%`,
    width: `${((endSec - startSec) / totalSeconds.value) * 100}%`
  }
})

const audioEditSelectionStyle = computed(() => {
  const range = props.audioEditSelection
  if (!range || totalSeconds.value <= 0) return null
  const startSec = Math.max(0, Number(range.startSec) || 0)
  const endSec = Math.max(startSec, Number(range.endSec) || 0)
  if (endSec <= startSec) return null
  return {
    left: `${(startSec / totalSeconds.value) * 100}%`,
    width: `${((endSec - startSec) / totalSeconds.value) * 100}%`
  }
})

const audioEditInsertedStyles = computed(() => {
  const ranges = props.audioEditInsertedRanges
  if (!ranges?.length || totalSeconds.value <= 0) return []
  return ranges.flatMap((range, index) => {
    const startSec = Math.max(0, Number(range.startSec) || 0)
    const endSec = Math.max(startSec, Number(range.endSec) || 0)
    if (endSec <= startSec) return []
    return [
      {
        key: `${startSec}-${endSec}-${index}`,
        style: {
          left: `${(startSec / totalSeconds.value) * 100}%`,
          width: `${((endSec - startSec) / totalSeconds.value) * 100}%`
        }
      }
    ]
  })
})

const resolveStructureLabel = (kind: SongStructureSectionKind) => {
  if (kind === 'breakdown') return 'BREAK'
  return kind.toUpperCase()
}

const structureSections = computed(() => {
  const structure = normalizedStructure.value
  if (!structure || totalSeconds.value <= 0) return []
  return structure.sections
    .map((section: SongStructureSection) => {
      const startSec = Math.max(0, Math.min(totalSeconds.value, Number(section.startSec) || 0))
      const endSec = Math.max(startSec, Math.min(totalSeconds.value, Number(section.endSec) || 0))
      if (endSec - startSec <= 0.2) return null
      return {
        key: `${section.kind}-${section.startSec}-${section.endSec}`,
        kind: section.kind,
        label: resolveStructureLabel(section.kind),
        startSec,
        active:
          Number.isFinite(Number(props.currentSeconds)) &&
          Number(props.currentSeconds) >= startSec &&
          Number(props.currentSeconds) < endSec,
        style: {
          left: `${(startSec / totalSeconds.value) * 100}%`,
          width: `${((endSec - startSec) / totalSeconds.value) * 100}%`,
          '--structure-strength': String(Math.max(0.38, Math.min(0.78, section.confidence)))
        } as Record<string, string>
      }
    })
    .filter(
      (
        section
      ): section is {
        key: string
        kind: SongStructureSectionKind
        label: string
        startSec: number
        active: boolean
        style: Record<string, string>
      } => section !== null
    )
})

const handleStructureSectionClick = (startSec: number) => {
  if (props.sectionSeekMode === 'seek-play') {
    emit('seek-play', startSec)
    return
  }
  emit('seek', startSec)
}

const resolveSeekDuplicateEpsilonSec = () => {
  const track = trackRef.value
  if (!track || totalSeconds.value <= 0) return SEEK_EMIT_DUPLICATE_EPSILON_SEC
  const rect = track.getBoundingClientRect()
  if (rect.width <= 0) return SEEK_EMIT_DUPLICATE_EPSILON_SEC
  return Math.max(
    SEEK_EMIT_DUPLICATE_EPSILON_SEC,
    (totalSeconds.value / rect.width) * SEEK_EMIT_DUPLICATE_EPSILON_PX
  )
}

const isDuplicateSeekSeconds = (seconds: number) =>
  lastSeekEmitSeconds !== null &&
  Math.abs(lastSeekEmitSeconds - seconds) <= resolveSeekDuplicateEpsilonSec()

const flushPendingSeek = () => {
  seekRaf = 0
  if (pendingSeekSeconds === null) return
  const nextSeconds = pendingSeekSeconds
  pendingSeekSeconds = null
  const now = performance.now()
  if (
    isDuplicateSeekSeconds(nextSeconds) &&
    now - lastSeekEmitAt <= SEEK_EMIT_DUPLICATE_WINDOW_MS
  ) {
    return
  }
  lastSeekEmitAt = now
  lastSeekEmitSeconds = nextSeconds
  emit('seek', nextSeconds)
}

const scheduleSeek = (seconds: number, immediate = false) => {
  pendingSeekSeconds = seconds
  if (immediate) {
    if (seekRaf) {
      cancelAnimationFrame(seekRaf)
      seekRaf = 0
    }
    flushPendingSeek()
    return
  }
  if (seekRaf) return
  seekRaf = requestAnimationFrame(flushPendingSeek)
}

const resolveSeekSecondsByClientX = (clientX: number) => {
  const track = trackRef.value
  if (!track || totalSeconds.value <= 0) return null
  const rect = track.getBoundingClientRect()
  if (rect.width <= 0) return null
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return ratio * totalSeconds.value
}

const handlePointerMove = (event: PointerEvent) => {
  if (!scrubbing.value) return
  if (activeScrubPointerId !== null && event.pointerId !== activeScrubPointerId) return
  const seconds = resolveSeekSecondsByClientX(event.clientX)
  if (seconds === null) return
  scheduleSeek(seconds)
}

const stopScrubbing = () => {
  if (!scrubbing.value) return
  scrubbing.value = false
  activeScrubPointerId = null
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('pointercancel', handlePointerCancel)
}

const handlePointerUp = (event: PointerEvent) => {
  if (activeScrubPointerId !== null && event.pointerId !== activeScrubPointerId) return
  const seconds = resolveSeekSecondsByClientX(event.clientX)
  if (seconds !== null && !isDuplicateSeekSeconds(seconds)) {
    scheduleSeek(seconds, true)
  }
  stopScrubbing()
}

const handlePointerCancel = (event: PointerEvent) => {
  if (activeScrubPointerId !== null && event.pointerId !== activeScrubPointerId) return
  stopScrubbing()
}

const beginScrubbing = (event: PointerEvent) => {
  const seconds = resolveSeekSecondsByClientX(event.clientX)
  if (seconds === null) return
  scrubbing.value = true
  activeScrubPointerId = event.pointerId
  scheduleSeek(seconds, true)
  window.addEventListener('pointermove', handlePointerMove, { passive: true })
  window.addEventListener('pointerup', handlePointerUp, { passive: true })
  window.addEventListener('pointercancel', handlePointerCancel, { passive: true })
}

const handlePointerDown = (event: PointerEvent) => {
  if (event.button !== 0 || !props.song || totalSeconds.value <= 0) return
  beginScrubbing(event)
  event.preventDefault()
}

const useHalfWaveform = () => (runtime.setting?.waveformMode ?? 'half') !== 'full'

const resizeCanvas = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) => {
  const pixelRatio = window.devicePixelRatio || 1
  const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
  const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))

  if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
    canvas.width = scaledWidth
    canvas.height = scaledHeight
  }

  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.scale(pixelRatio, pixelRatio)
}

const clearCanvas = () => {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

const drawTimelineTicks = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  if (!props.song || totalSeconds.value <= 0) {
    clearCanvas()
    return
  }
  drawWaveformTimelineTicks(
    ctx,
    width,
    height,
    totalSeconds.value,
    resolveWaveformTimelineTickThemeVariant(runtime.setting?.themeMode),
    {
      playedPercent: totalSeconds.value > 0 ? Number(props.currentSeconds) / totalSeconds.value : 0
    }
  )
}

const drawPioneerPreviewWaveform = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: IPioneerPreviewWaveformData
) => {
  const columns = Array.isArray(data?.columns) ? data.columns : []
  const maxHeight = Math.max(
    1,
    Number(data?.maxHeight) ||
      columns.reduce((value, column) => Math.max(value, Number(column?.backHeight) || 0), 0)
  )
  if (!columns.length || maxHeight <= 0) return

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
    for (let cursor = start; cursor < end; cursor++) {
      const candidate = columns[cursor]
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
}

const drawWaveform = () => {
  const track = trackRef.value
  const canvas = canvasRef.value
  if (!track || !canvas) return

  const width = Math.max(1, track.clientWidth)
  const height = Math.max(1, track.clientHeight)
  trackWidth.value = width
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  resizeCanvas(canvas, ctx, width, height)

  if (pioneerPreviewData.value) {
    drawPioneerPreviewWaveform(ctx, width, height, pioneerPreviewData.value)
    return
  }

  if (displayWaveformData.value) {
    drawCompactVisualWaveform(ctx, {
      width,
      height,
      data: displayWaveformData.value,
      rangeStartSec: 0,
      rangeDurationSec: Math.max(0.0001, Number(displayWaveformData.value.duration) || 0),
      showDetailHighlights: false,
      showCenterLine: false,
      waveformLayout: useHalfWaveform() ? 'top-half' : 'full'
    })
    return
  }

  drawTimelineTicks(ctx, width, height)
}

const loadWaveform = async () => {
  const currentSong = props.song
  const currentToken = ++loadToken
  compactVisualData.value = null
  pioneerPreviewData.value = null
  clearCanvas()

  const filePath = String(currentSong?.filePath || '').trim()
  if (!filePath) return

  const externalWaveformSource = resolveSongExternalWaveformSource(currentSong, {
    rootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
    sourceKind: runtime.pioneerDeviceLibrary.selectedSourceKind || undefined
  })

  if (externalWaveformSource) {
    try {
      const response = (await window.electron.ipcRenderer.invoke(
        getRekordboxPreviewWaveformRequestChannel(externalWaveformSource.sourceKind),
        externalWaveformSource.rootPath,
        [externalWaveformSource.analyzePath]
      )) as PioneerPreviewWaveformResponse | null

      if (currentToken !== loadToken) return
      const preview =
        response?.items?.find((item) => item.analyzePath === externalWaveformSource.analyzePath)
          ?.data ?? null
      if (preview) {
        pioneerPreviewData.value = preview
        drawWaveform()
        return
      }
    } catch {}
    drawWaveform()
    return
  }

  // Normal file libraries still use FRKB's cached overview and may queue its analysis.
  const globalOverview = await loadWaveformGlobalOverviewData(filePath).catch(() => null)
  if (currentToken !== loadToken) return
  if (globalOverview) {
    compactVisualData.value = globalOverview
    drawWaveform()
    return
  }

  drawWaveform()
}

watch(
  [
    () => props.song?.filePath ?? '',
    () => props.song?.externalAnalyzePath ?? props.song?.pioneerAnalyzePath ?? '',
    () => props.song?.externalWaveformRootPath ?? props.song?.pioneerDeviceRootPath ?? ''
  ],
  () => {
    void loadWaveform()
  },
  { immediate: true }
)

watch(
  () => runtime.setting?.waveformMode,
  () => {
    drawWaveform()
  }
)

watch(
  () => runtime.setting?.themeMode,
  () => {
    drawWaveform()
  }
)

watch(
  () => [Number(props.currentSeconds) || 0, totalSeconds.value] as const,
  () => {
    if (displayWaveformData.value || pioneerPreviewData.value) return
    drawWaveform()
  }
)

watch(
  () => [props.audioEditHasEdits, props.audioEditClips],
  () => {
    drawWaveform()
  },
  { deep: true }
)

const handleSongWaveformUpdated = (_event: unknown, payload: { filePath?: string }) => {
  const filePath = String(payload?.filePath || '').trim()
  const currentSongFilePath = String(props.song?.filePath || '').trim()
  if (!filePath || !currentSongFilePath) return
  if (!isSameHorizontalBrowseSongFilePath(filePath, currentSongFilePath)) return
  void loadWaveform()
}

onMounted(() => {
  if (trackRef.value) {
    resizeObserver = new ResizeObserver(() => {
      drawWaveform()
    })
    resizeObserver.observe(trackRef.value)
  }
  if (typeof MutationObserver !== 'undefined') {
    const targets = [
      document.documentElement,
      document.body,
      document.getElementById('app')
    ].filter((target): target is HTMLElement => Boolean(target))
    themeClassObserver = new MutationObserver(() => drawWaveform())
    for (const target of targets) {
      themeClassObserver.observe(target, { attributes: true, attributeFilter: ['class'] })
    }
  }
  window.electron.ipcRenderer.on('song-waveform-updated', handleSongWaveformUpdated)
  drawWaveform()
})

onUnmounted(() => {
  loadToken += 1
  stopScrubbing()
  if (seekRaf) {
    cancelAnimationFrame(seekRaf)
    seekRaf = 0
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (themeClassObserver) {
    themeClassObserver.disconnect()
    themeClassObserver = null
  }
  window.electron.ipcRenderer.removeListener('song-waveform-updated', handleSongWaveformUpdated)
})
</script>

<template>
  <div
    class="overview-waveform"
    :class="{ 'is-scrubbing': scrubbing }"
    @pointerdown.stop="handlePointerDown"
  >
    <div ref="trackRef" class="overview-waveform__track">
      <canvas ref="canvasRef" class="overview-waveform__canvas"></canvas>
      <div
        v-if="props.playbackRange?.visible"
        class="overview-waveform__playback-range"
        @pointerdown.stop
      >
        <PlaybackRangeHandles
          :model-value-start="props.playbackRange.startPercent"
          :model-value-end="props.playbackRange.endPercent"
          :container-width="trackWidth"
          enable-playback-range
          :waveform-show="!!props.song"
          :locked="props.playbackRange.locked"
          :locked-ranges="props.playbackRange.lockedRanges"
          @update:model-value-start="props.playbackRange.setStartPercent"
          @update:model-value-end="props.playbackRange.setEndPercent"
        />
      </div>
      <MemoryCueMarkersLayer
        :memory-cues="props.memoryCues || []"
        :visible-duration-sec="totalSeconds"
        show-loop-range
        :anchor="props.markerAnchor || 'top'"
        size="compact"
      />
      <HotCueMarkersLayer
        :hot-cues="props.hotCues || []"
        :visible-duration-sec="totalSeconds"
        show-loop-range
        :anchor="props.markerAnchor || 'top'"
        size="compact"
      />
      <div v-if="loopMaskStyle" class="overview-waveform__loop-mask" :style="loopMaskStyle"></div>
      <div
        v-for="region in audioEditInsertedStyles"
        :key="region.key"
        class="overview-waveform__audio-edit-insert"
        :style="region.style"
        aria-hidden="true"
      ></div>
      <div
        v-if="audioEditSelectionStyle"
        class="overview-waveform__audio-edit-selection"
        :style="audioEditSelectionStyle"
      ></div>
      <div
        v-if="audioEditPendingStartSec != null && totalSeconds > 0"
        class="overview-waveform__audio-edit-bound"
        :style="{ left: `${(Number(audioEditPendingStartSec) / totalSeconds) * 100}%` }"
      ></div>
      <div
        v-if="audioEditPendingEndSec != null && totalSeconds > 0"
        class="overview-waveform__audio-edit-bound"
        :style="{ left: `${(Number(audioEditPendingEndSec) / totalSeconds) * 100}%` }"
      ></div>
      <div
        v-if="playheadLeft !== null"
        class="overview-waveform__playhead"
        :style="{ left: playheadLeft }"
      ></div>
    </div>
    <div
      class="overview-waveform__structure"
      :class="{ 'overview-waveform__structure--empty': !structureSections.length }"
      @pointerdown.stop
    >
      <button
        v-for="section in structureSections"
        :key="section.key"
        type="button"
        class="overview-waveform__structure-segment"
        :aria-label="`Seek to ${section.label}`"
        :class="[
          `overview-waveform__structure-segment--${section.kind}`,
          { 'overview-waveform__structure-segment--active': section.active }
        ]"
        :style="section.style"
        @click.stop="handleStructureSectionClick(section.startSec)"
      >
        <span class="overview-waveform__structure-label">
          {{ section.label }}
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.overview-waveform {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-inline: var(--overview-waveform-side-inset, 10px);
  box-sizing: border-box;
  cursor: default;
  touch-action: pan-y;
  background: var(--shell-waveform-bg, var(--waveform-bg));
}

.overview-waveform__track {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  height: auto;
  min-width: 0;
  min-height: 0;
}

.overview-waveform__canvas {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.overview-waveform__playback-range {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 12;
}

.overview-waveform__playback-range :deep(.manual-handle:not(.is-locked)) {
  pointer-events: auto;
}

.overview-waveform__structure {
  --structure-intro: rgba(125, 211, 252, 0.74);
  --structure-groove: rgba(52, 211, 153, 0.72);
  --structure-breakdown: rgba(196, 181, 253, 0.74);
  --structure-build: rgba(251, 191, 36, 0.76);
  --structure-drop: rgba(248, 113, 113, 0.78);
  --structure-outro: rgba(148, 163, 184, 0.68);
  position: relative;
  flex: 0 0 8px;
  width: 100%;
  height: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--shell-waveform-bg, var(--waveform-bg)) 86%, var(--border));
  border-radius: 0;
  pointer-events: auto;
  z-index: 2;
}

.overview-waveform__structure--empty {
  visibility: hidden;
  pointer-events: none;
}

.overview-waveform__structure-segment {
  position: absolute;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 8px;
  min-width: 3px;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  padding: 0;
  appearance: none;
  opacity: var(--structure-strength, 0.62);
  background: var(--structure-groove);
  cursor: pointer;
  box-shadow:
    inset 1px 0 0 rgba(255, 255, 255, 0.34),
    inset -1px 0 0 rgba(0, 0, 0, 0.18),
    0 1px 2px rgba(0, 0, 0, 0.2);
}

.overview-waveform__structure-segment:focus-visible {
  outline: none;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.72),
    0 0 0 1px rgba(0, 0, 0, 0.34);
}

.overview-waveform__structure-segment--active {
  opacity: min(1, calc(var(--structure-strength, 0.62) + 0.22));
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.44),
    0 0 0 1px rgba(255, 255, 255, 0.16),
    0 1px 4px rgba(0, 0, 0, 0.32);
}

.overview-waveform__structure-label {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  padding: 0 3px;
  color: rgba(12, 18, 28, 0.9);
  font-size: 7px;
  font-weight: 800;
  line-height: 8px;
  text-align: center;
  text-overflow: clip;
  text-shadow: 0 1px 1px rgba(255, 255, 255, 0.26);
  white-space: nowrap;
  pointer-events: none;
}

.overview-waveform__structure-segment--intro {
  background: var(--structure-intro);
}

.overview-waveform__structure-segment--groove {
  background: var(--structure-groove);
}

.overview-waveform__structure-segment--breakdown {
  background: var(--structure-breakdown);
}

.overview-waveform__structure-segment--build {
  background: var(--structure-build);
}

.overview-waveform__structure-segment--drop {
  background: var(--structure-drop);
}

.overview-waveform__structure-segment--outro {
  background: var(--structure-outro);
}

:global(.theme-light) .overview-waveform__structure,
:global(.theme-light) .overview-waveform {
  --structure-intro: rgba(2, 132, 199, 0.62);
  --structure-groove: rgba(5, 150, 105, 0.62);
  --structure-breakdown: rgba(124, 58, 237, 0.6);
  --structure-build: rgba(217, 119, 6, 0.64);
  --structure-drop: rgba(220, 38, 38, 0.66);
  --structure-outro: rgba(71, 85, 105, 0.58);
}

:global(.theme-light) .overview-waveform__structure-label {
  color: rgba(255, 255, 255, 0.96);
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.24);
}

.overview-waveform__loop-mask {
  position: absolute;
  top: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--shell-cue-accent, #d98921) 28%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--shell-cue-accent, #d98921) 44%, transparent);
  pointer-events: none;
}

.overview-waveform__audio-edit-insert {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 7;
  background: color-mix(in srgb, var(--shell-cue-accent, #d98921) 28%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--shell-cue-accent, #d98921) 44%, transparent);
  pointer-events: none;
}

.overview-waveform__audio-edit-selection {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 8;
  background: color-mix(in srgb, var(--accent) 28%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 44%, transparent);
  pointer-events: none;
}

.overview-waveform__audio-edit-bound {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 9;
  width: 2px;
  background: color-mix(in srgb, var(--accent) 80%, #fff);
  pointer-events: none;
  transform: translateX(-1px);
}

.overview-waveform__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--shell-playhead-bg);
  pointer-events: none;
}
</style>
