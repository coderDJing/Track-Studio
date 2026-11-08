import { computed, type Ref } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'

type DynamicBeatGridEditController = {
  isDynamic: Readonly<Ref<boolean>>
  hasV2GridMap: Readonly<Ref<boolean>>
  gridControlsDisabled: Readonly<Ref<boolean>>
  selectTargetByPointer: (event: PointerEvent) => boolean
  setActiveGridDownbeatLineAtSec: (sec: number) => boolean
  shiftActiveGrid: (deltaMs: number) => boolean
}

type UseMixtapeBeatAlignGridAdjustParams = {
  previewWrapRef: Ref<HTMLDivElement | null>
  previewLoading: Ref<boolean>
  previewMixxxData: Ref<MixxxWaveformData | null>
  canAdjustGrid?: Ref<boolean>
  previewPlaying: Ref<boolean>
  previewDownbeatBeatOffset: Ref<number>
  previewFirstBeatMs: Ref<number>
  previewStartSec: Ref<number>
  bpm: Readonly<Ref<number>>
  firstBeatMs: Readonly<Ref<number>>
  resolvePreviewAnchorSec: () => number
  resolvePreviewDurationSec: () => number
  resolveVisibleDurationSec: () => number
  clampPreviewStart: (value: number) => number
  getPreviewPlaybackSec: () => number
  schedulePreviewDraw: () => void
  applyPlaybackPhaseCompensation?: (deltaMs: number) => void
  downbeatBeatInterval: number
  dynamicGridEdit?: DynamicBeatGridEditController
}

type GridShiftOptions = {
  preservePlaybackPhase?: boolean
}

const normalizeBeatOffset = (value: number, interval: number) => {
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1))
  const numeric = Number(value)
  const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 0
  return ((rounded % safeInterval) + safeInterval) % safeInterval
}

const wrapMsInCycle = (valueMs: number, cycleMs: number) => {
  if (!Number.isFinite(cycleMs) || cycleMs <= 0) return 0
  const wrapped = ((valueMs % cycleMs) + cycleMs) % cycleMs
  return wrapped
}

export const useMixtapeBeatAlignGridAdjust = (params: UseMixtapeBeatAlignGridAdjustParams) => {
  const canAdjustGrid = computed(() => {
    if (params.canAdjustGrid) return params.canAdjustGrid.value
    if (params.previewLoading.value) return false
    return !!params.previewMixxxData.value
  })

  const canAdjustClipGrid = () =>
    canAdjustGrid.value && params.dynamicGridEdit?.gridControlsDisabled.value !== true

  const handlePreviewMouseDownForGridTargetSelect = (event: PointerEvent) => {
    if (params.dynamicGridEdit?.selectTargetByPointer(event) === true) {
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    return false
  }

  const handleSetDownbeatLineAtPlayhead = () => {
    if (!canAdjustClipGrid()) return
    const bpmValue = Number(params.bpm.value)
    if (!Number.isFinite(bpmValue) || bpmValue <= 0) return
    const beatMs = (60 / bpmValue) * 1000
    if (!Number.isFinite(beatMs) || beatMs <= 0) return
    const playbackSec = Number(params.getPreviewPlaybackSec())
    const candidateSec = params.previewPlaying.value
      ? playbackSec
      : params.resolvePreviewAnchorSec()
    const anchorSec = Number.isFinite(candidateSec)
      ? candidateSec
      : params.resolvePreviewAnchorSec()
    if (params.dynamicGridEdit?.hasV2GridMap.value === true) {
      params.dynamicGridEdit.setActiveGridDownbeatLineAtSec(anchorSec)
      return
    }
    const interval = Math.max(1, Math.floor(params.downbeatBeatInterval || 4))
    const cycleMs = beatMs * interval
    const downbeatBeatOffset = normalizeBeatOffset(params.previewDownbeatBeatOffset.value, interval)
    const anchorMs = Math.max(0, anchorSec * 1000)
    const alignedFirstBeatMs = anchorMs - downbeatBeatOffset * beatMs
    params.previewFirstBeatMs.value = wrapMsInCycle(alignedFirstBeatMs, cycleMs)
    params.schedulePreviewDraw()
  }

  const handleGridShift = (delta: number, options: GridShiftOptions = {}) => {
    if (!canAdjustClipGrid()) return
    if (params.dynamicGridEdit?.hasV2GridMap.value === true) {
      if (params.dynamicGridEdit.shiftActiveGrid(delta) && options.preservePlaybackPhase === true) {
        params.applyPlaybackPhaseCompensation?.(delta)
      }
      return
    }
    const bpmValue = Number(params.bpm.value)
    if (!Number.isFinite(bpmValue) || bpmValue <= 0) return
    const beatMs = (60 / bpmValue) * 1000
    if (!Number.isFinite(beatMs) || beatMs <= 0) return
    const cycleMs = beatMs * Math.max(1, Math.floor(params.downbeatBeatInterval || 4))
    const nextFirstBeatMs = Number(params.previewFirstBeatMs.value) + Number(delta)
    params.previewFirstBeatMs.value = wrapMsInCycle(nextFirstBeatMs, cycleMs)
    if (options.preservePlaybackPhase === true) {
      params.applyPlaybackPhaseCompensation?.(delta)
    }
    params.schedulePreviewDraw()
  }

  return {
    canAdjustGrid,
    handlePreviewMouseDownForGridTargetSelect,
    handleSetDownbeatLineAtPlayhead,
    handleGridShift
  }
}
