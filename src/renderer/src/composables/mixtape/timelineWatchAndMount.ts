import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import {
  DEFAULT_LANE_COUNT,
  normalizeMixtapeLaneIndex
} from '@renderer/composables/mixtape/constants'
import type {
  MixtapeMixMode,
  MixtapeStemMode,
  MixtapeTrack,
  RawWaveformData,
  StemWaveformData
} from '@renderer/composables/mixtape/types'
import type { TimelineWaveformData } from '@renderer/composables/mixtape/timelineRenderAndLoadTypes'

type ValueRef<T> = {
  value: T
}

type TimelineScrollHost = InstanceType<typeof OverlayScrollbarsComponent> | null

type TimelineWatchAndMountContext = {
  tracks: ValueRef<MixtapeTrack[]>
  laneCount?: ValueRef<number>
  mixtapeMixMode: ValueRef<MixtapeMixMode>
  mixtapeStemMode: ValueRef<MixtapeStemMode>
  resolveTrackWaveformFilePaths: (track: MixtapeTrack) => string[]
  resolveTrackGridSignature: (track: MixtapeTrack) => string
  isTrackDragging: ValueRef<boolean>
  bpmAnalysisActive: ValueRef<boolean>
  timelineDurationSec: ValueRef<number>
  playheadSec: ValueRef<number>
  renderPxPerSec: ValueRef<number>
  waveformVersion: ValueRef<number>
  stopTransportForTrackChange: () => void
  clearTimelineLayoutCache: () => void
  updateTimelineWidth: (preserveScrollCenter?: boolean) => void
  scheduleWaveformLoad: () => void
  scheduleFullPreRender: () => void
  scheduleWorkerPreRender: () => void
  scheduleTimelineDraw: () => void
  scheduleWaveformDraw: () => void
  waveformRenderWorkerRef: ValueRef<Worker | null>
  handleWaveformWorkerMessage: (event: MessageEvent) => void
  pushStemWaveformToWorker: (filePath: string, data: StemWaveformData | null) => void
  pushRawWaveformToWorker: (filePath: string, data: RawWaveformData | null) => void
  waveformDataMap: Map<string, TimelineWaveformData | null>
  rawWaveformDataMap: Map<string, RawWaveformData | null>
  timelineScrollRef: ValueRef<TimelineScrollHost>
  setTimelineWheelTarget: (target: HTMLElement | null) => void
  timelineViewport: ValueRef<HTMLElement | null>
  timelineObserverRef: ValueRef<ResizeObserver | null>
  timelineViewportObserverRef: ValueRef<ResizeObserver | null>
  overviewObserverRef: ValueRef<ResizeObserver | null>
  overviewRef: ValueRef<HTMLElement | null>
  updateOverviewWidth: () => void
  startTimelineScrollSampler: () => void
  handleTimelineWheel: (event: WheelEvent) => void
  handleWaveformUpdated: (...args: unknown[]) => void
  scheduleTransportPreload: () => void
  initTimelineWorkerRenderer?: () => void
}

export const createTimelineWatchAndMountModule = (ctx: TimelineWatchAndMountContext) => {
  const {
    tracks,
    laneCount,
    mixtapeMixMode,
    mixtapeStemMode,
    resolveTrackWaveformFilePaths,
    resolveTrackGridSignature,
    isTrackDragging,
    bpmAnalysisActive,
    timelineDurationSec,
    playheadSec,
    renderPxPerSec,
    waveformVersion,
    stopTransportForTrackChange,
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleWaveformLoad,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    scheduleTimelineDraw,
    scheduleWaveformDraw,
    waveformRenderWorkerRef,
    handleWaveformWorkerMessage,
    pushStemWaveformToWorker,
    pushRawWaveformToWorker,
    waveformDataMap,
    rawWaveformDataMap,
    timelineScrollRef,
    setTimelineWheelTarget,
    timelineViewport,
    timelineObserverRef,
    timelineViewportObserverRef,
    overviewObserverRef,
    overviewRef,
    updateOverviewWidth,
    startTimelineScrollSampler,
    handleTimelineWheel,
    handleWaveformUpdated,
    scheduleTransportPreload
  } = ctx
  const INITIAL_VIEWPORT_BIND_MAX_ATTEMPTS = 24
  const INITIAL_VIEWPORT_BIND_INTERVAL_MS = 50
  let initialViewportBindAttempts = 0
  let initialViewportBindTimer: ReturnType<typeof setTimeout> | null = null
  const isStemMixMode = () => mixtapeMixMode?.value === 'stem'
  const isStemWaveformData = (value: unknown): value is StemWaveformData =>
    !!value && typeof value === 'object' && 'all' in value

  const clearInitialViewportBindTimer = () => {
    if (!initialViewportBindTimer) return
    clearTimeout(initialViewportBindTimer)
    initialViewportBindTimer = null
  }

  const bindTimelineViewportIfReady = () => {
    const viewportEl = timelineScrollRef.value?.osInstance()?.elements().viewport as
      HTMLElement | undefined
    if (!viewportEl) return false
    setTimelineWheelTarget(viewportEl)
    if (typeof ResizeObserver !== 'undefined') {
      if (!timelineViewportObserverRef.value) {
        timelineViewportObserverRef.value = new ResizeObserver(() => updateTimelineWidth())
      }
      try {
        timelineViewportObserverRef.value.observe(viewportEl)
      } catch {}
    }
    updateTimelineWidth()
    nextTick(() => {
      scheduleWaveformLoad()
      scheduleWaveformDraw()
    })
    return true
  }

  const scheduleInitialViewportBind = () => {
    if (bindTimelineViewportIfReady()) {
      clearInitialViewportBindTimer()
      return
    }
    if (initialViewportBindAttempts >= INITIAL_VIEWPORT_BIND_MAX_ATTEMPTS) return
    initialViewportBindAttempts += 1
    clearInitialViewportBindTimer()
    initialViewportBindTimer = setTimeout(() => {
      initialViewportBindTimer = null
      scheduleInitialViewportBind()
    }, INITIAL_VIEWPORT_BIND_INTERVAL_MS)
  }

  watch(
    () =>
      `${String(mixtapeMixMode?.value || 'stem')}|${String(mixtapeStemMode?.value || '')}|${tracks.value
        .map((track: MixtapeTrack) => {
          const waveformPaths = resolveTrackWaveformFilePaths(track).join(',')
          const stemStatus = mixtapeMixMode?.value === 'stem' ? String(track.stemStatus || '') : ''
          return `${track.id}:${stemStatus}:${waveformPaths}`
        })
        .join('|')}`,
    () => {
      stopTransportForTrackChange()
      clearTimelineLayoutCache()
      updateTimelineWidth()
      scheduleWaveformLoad()
      scheduleTransportPreload()
      scheduleFullPreRender()
      scheduleWorkerPreRender()
      nextTick(() => scheduleWaveformDraw())
    }
  )

  watch(
    () =>
      `${String(laneCount?.value ?? DEFAULT_LANE_COUNT)}|${tracks.value
        .map((track: MixtapeTrack, index: number) => {
          const startSec = Number(track.startSec) || 0
          const laneIndex = normalizeMixtapeLaneIndex(track.laneIndex, index % DEFAULT_LANE_COUNT)
          const masterTempo = track.masterTempo === false ? 0 : 1
          return `${track.id}:${laneIndex}:${Math.round(startSec * 1000)}:${resolveTrackGridSignature(
            track
          )}:${masterTempo}`
        })
        .join('|')}`,
    (_next, prev) => {
      if (typeof prev === 'string' && prev) {
        stopTransportForTrackChange()
      }
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
      scheduleTimelineDraw()
      if (!isTrackDragging.value) {
        scheduleFullPreRender()
        scheduleWorkerPreRender()
      }
    }
  )

  watch(
    () => bpmAnalysisActive.value,
    (active) => {
      if (active) {
        stopTransportForTrackChange()
      }
    }
  )

  watch(
    () => timelineDurationSec.value,
    (duration) => {
      if (!Number.isFinite(duration) || duration < 0) return
      if (playheadSec.value > duration) {
        playheadSec.value = duration
      }
    }
  )

  watch(
    () => renderPxPerSec.value,
    () => {
      clearTimelineLayoutCache()
      updateTimelineWidth()
    }
  )

  watch(
    () => waveformVersion.value,
    () => {
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
    }
  )

  onMounted(() => {
    updateTimelineWidth()
    if (typeof Worker !== 'undefined') {
      try {
        const worker = new Worker(
          new URL('../../workers/mixtapeWaveformRender.worker.ts', import.meta.url),
          { type: 'module' }
        )
        waveformRenderWorkerRef.value = worker
        worker.onmessage = handleWaveformWorkerMessage
        if (isStemMixMode()) {
          for (const [filePath, data] of waveformDataMap.entries()) {
            pushStemWaveformToWorker(filePath, isStemWaveformData(data) ? data : null)
          }
        }
        for (const [filePath, data] of rawWaveformDataMap.entries()) {
          pushRawWaveformToWorker(filePath, data)
        }
      } catch {
        waveformRenderWorkerRef.value = null
      }
    }
    try {
      bindTimelineViewportIfReady()
      if (timelineViewport.value && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => scheduleWaveformDraw())
        timelineObserverRef.value = observer
        observer.observe(timelineViewport.value)
      }
      if (overviewRef.value && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => updateOverviewWidth())
        overviewObserverRef.value = observer
        observer.observe(overviewRef.value)
      }
    } catch {}
    updateOverviewWidth()
    initialViewportBindAttempts = 0
    scheduleInitialViewportBind()
    scheduleTransportPreload()
    startTimelineScrollSampler()
    if (typeof window !== 'undefined') {
      window.addEventListener('wheel', handleTimelineWheel, { passive: false })
    }
    if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.on('mixtape-waveform-updated', handleWaveformUpdated)
      window.electron.ipcRenderer.on('song-waveform-updated', handleWaveformUpdated)
    }
  })

  onBeforeUnmount(() => {
    clearInitialViewportBindTimer()
  })
}
