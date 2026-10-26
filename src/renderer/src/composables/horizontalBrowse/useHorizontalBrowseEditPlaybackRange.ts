import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  clampPlaybackRangePercent,
  findCrossedPlaybackSectionRange,
  findCurrentOrUpcomingPlaybackSectionRange,
  findNextPlaybackSectionRange,
  isPlaybackSectionRangeMode,
  normalizePlaybackRangeMode,
  normalizePlaybackRangeSectionKinds,
  normalizePlaybackRangeSectionMatchMode,
  resolvePlaybackSectionRangeResolution,
  type PlaybackRangePercentRange,
  type PlaybackSectionRange
} from '@shared/playbackRange'
import { normalizeAudioEditRange, type AudioEditRange } from '@shared/audioEditTimeline'

type PendingRangeAction =
  | {
      kind: 'seek'
      filePath: string
      targetSec: number
      startedAtMs: number
    }
  | {
      kind: 'finish'
      filePath: string
      startedAtMs: number
    }

type UseHorizontalBrowseEditPlaybackRangeParams = {
  runtime: ReturnType<typeof useRuntimeStore>
  isEditMode: ComputedRef<boolean>
  topDeckSong: Ref<ISongInfo | null> | ComputedRef<ISongInfo | null>
  currentSeconds: Ref<number> | ComputedRef<number>
  durationSeconds: ComputedRef<number>
  resolvePlaying: () => boolean
  resolveLoopActive: () => boolean
  seek: (seconds: number) => void
  seekAndPlay: (seconds: number) => void
  pause: () => void
  advanceToNextSong: () => boolean
  handleLoopPlaybackTick: (deck: HorizontalBrowseDeckKey) => void
  customRangeSec?: Ref<AudioEditRange | null>
  setCustomRangeSec?: (range: AudioEditRange | null) => void
}

export type HorizontalBrowsePlaybackRangeOverlay = {
  visible: boolean
  startPercent: number
  endPercent: number
  locked: boolean
  lockedRanges: PlaybackRangePercentRange[]
  setStartPercent: (value: number) => void
  setEndPercent: (value: number) => void
}

const RANGE_STOP_TOLERANCE_SEC = 0.05
const RANGE_ACTION_TARGET_TOLERANCE_SEC = 0.12
const RANGE_ACTION_TIMEOUT_MS = 1500

export const useHorizontalBrowseEditPlaybackRange = (
  params: UseHorizontalBrowseEditPlaybackRangeParams
) => {
  const previousTimeSec = ref<number | null>(null)
  const sectionRangeFallbackFilePath = ref<string | null>(null)
  const queuedSectionAnalysisFilePath = ref('')
  const ignoreRangeEndsBeforeSec = ref<number | null>(null)
  let pendingAction: PendingRangeAction | null = null

  const currentFilePath = computed(() => String(params.topDeckSong.value?.filePath || '').trim())
  const safeDurationSeconds = computed(() => Math.max(0, Number(params.durationSeconds.value) || 0))
  const playbackSectionRangeResolution = computed(() =>
    resolvePlaybackSectionRangeResolution(
      params.runtime.setting,
      params.topDeckSong.value?.songStructure,
      safeDurationSeconds.value
    )
  )
  const playbackSectionHandleRange = computed(() => {
    const resolution = playbackSectionRangeResolution.value
    if (resolution.status !== 'ready') return null
    return findCurrentOrUpcomingPlaybackSectionRange(
      resolution.ranges,
      params.currentSeconds.value,
      RANGE_STOP_TOLERANCE_SEC
    )
  })

  const secondsToPercent = (seconds: number) => {
    const duration = safeDurationSeconds.value
    if (duration <= 0) return 0
    return Math.min(Math.max((seconds / duration) * 100, 0), 100)
  }

  const playbackRangeLockedRanges = computed<PlaybackRangePercentRange[]>(() => {
    if (!isPlaybackSectionRangeMode(params.runtime.setting)) return []
    const resolution = playbackSectionRangeResolution.value
    if (resolution.status !== 'ready') return []
    return resolution.ranges
      .map((range) => ({
        startPercent: secondsToPercent(range.startSec),
        endPercent: secondsToPercent(range.endSec)
      }))
      .filter((range) => range.endPercent > range.startPercent)
  })

  const playbackRangeHandlesLocked = computed(() =>
    isPlaybackSectionRangeMode(params.runtime.setting)
  )
  const playbackRangeHandlesVisible = computed(() => {
    if (!params.isEditMode.value || !currentFilePath.value || safeDurationSeconds.value <= 0) {
      return false
    }
    if (params.runtime.setting.enablePlaybackRange !== true) return false
    if (!playbackRangeHandlesLocked.value) return true
    return playbackRangeLockedRanges.value.length > 0
  })
  const percentToSeconds = (percent: number) =>
    (safeDurationSeconds.value * clampPlaybackRangePercent(percent, 0)) / 100

  const syncCustomRangeFromPercents = (startPercent: number, endPercent: number) => {
    if (!params.setCustomRangeSec || !params.isEditMode.value) return
    params.setCustomRangeSec(
      normalizeAudioEditRange(percentToSeconds(startPercent), percentToSeconds(endPercent))
    )
  }

  const playbackRangeHandleStartPercent = computed({
    get: () => {
      const sectionRange = playbackSectionHandleRange.value
      if (playbackRangeHandlesLocked.value && sectionRange) {
        return secondsToPercent(sectionRange.startSec)
      }
      const customRange = params.isEditMode.value ? params.customRangeSec?.value : null
      if (customRange) return secondsToPercent(customRange.startSec)
      return clampPlaybackRangePercent(params.runtime.setting.startPlayPercent, 0)
    },
    set: (value: number) => {
      if (playbackRangeHandlesLocked.value) return
      const next = clampPlaybackRangePercent(value, 0)
      params.runtime.setting.startPlayPercent = next
      syncCustomRangeFromPercents(next, playbackRangeHandleEndPercent.value)
    }
  })
  const playbackRangeHandleEndPercent = computed({
    get: () => {
      const sectionRange = playbackSectionHandleRange.value
      if (playbackRangeHandlesLocked.value && sectionRange) {
        return secondsToPercent(sectionRange.endSec)
      }
      const customRange = params.isEditMode.value ? params.customRangeSec?.value : null
      if (customRange) return secondsToPercent(customRange.endSec)
      return clampPlaybackRangePercent(params.runtime.setting.endPlayPercent, 100)
    },
    set: (value: number) => {
      if (playbackRangeHandlesLocked.value) return
      const next = clampPlaybackRangePercent(value, 100)
      params.runtime.setting.endPlayPercent = next
      syncCustomRangeFromPercents(playbackRangeHandleStartPercent.value, next)
    }
  })
  const setPlaybackRangeStartPercent = (value: number) => {
    playbackRangeHandleStartPercent.value = value
  }
  const setPlaybackRangeEndPercent = (value: number) => {
    playbackRangeHandleEndPercent.value = value
  }
  const playbackRangeOverlay = computed<HorizontalBrowsePlaybackRangeOverlay>(() => ({
    visible: playbackRangeHandlesVisible.value,
    startPercent: playbackRangeHandleStartPercent.value,
    endPercent: playbackRangeHandleEndPercent.value,
    locked: playbackRangeHandlesLocked.value,
    lockedRanges: playbackRangeLockedRanges.value,
    setStartPercent: setPlaybackRangeStartPercent,
    setEndPercent: setPlaybackRangeEndPercent
  }))

  const resetRangeRuntimeState = () => {
    previousTimeSec.value = null
    ignoreRangeEndsBeforeSec.value = null
    pendingAction = null
  }

  const queueCurrentSongSectionAnalysis = () => {
    const filePath = currentFilePath.value
    if (!filePath || sameRendererFilePath(queuedSectionAnalysisFilePath.value, filePath)) return
    queuedSectionAnalysisFilePath.value = filePath
    try {
      window.electron.ipcRenderer.send('key-analysis:queue-playing', {
        analysisAuthority: 'frkb',
        filePath,
        focusSlot: 'horizontal-browse-top'
      })
    } catch {}
  }

  const resolveCustomPlaybackRange = (): PlaybackSectionRange | null => {
    const duration = safeDurationSeconds.value
    if (duration <= 0) return null
    const customRange = params.isEditMode.value ? params.customRangeSec?.value : null
    if (customRange && customRange.endSec > customRange.startSec) {
      return { startSec: customRange.startSec, endSec: customRange.endSec, kinds: [] }
    }
    const startSec =
      (duration * clampPlaybackRangePercent(params.runtime.setting.startPlayPercent, 0)) / 100
    const endSec =
      (duration * clampPlaybackRangePercent(params.runtime.setting.endPlayPercent, 100)) / 100
    if (endSec <= startSec) return null
    return { startSec, endSec, kinds: [] }
  }

  const resolveActivePlaybackRanges = () => {
    if (params.runtime.setting.enablePlaybackRange !== true) {
      return { status: 'disabled' as const, ranges: [] as PlaybackSectionRange[] }
    }
    if (isPlaybackSectionRangeMode(params.runtime.setting)) {
      const resolution = playbackSectionRangeResolution.value
      return { status: resolution.status, ranges: resolution.ranges }
    }
    const range = resolveCustomPlaybackRange()
    return {
      status: range ? ('ready' as const) : ('no-match' as const),
      ranges: range ? [range] : []
    }
  }

  const startSeekAction = (targetSec: number, startPlayback: boolean) => {
    const filePath = currentFilePath.value
    if (!filePath) return
    previousTimeSec.value = targetSec
    pendingAction = {
      kind: 'seek',
      filePath,
      targetSec,
      startedAtMs: performance.now()
    }
    if (startPlayback) {
      params.seekAndPlay(targetSec)
    } else {
      params.seek(targetSec)
    }
  }

  const finishRangePlayback = () => {
    const filePath = currentFilePath.value
    if (!filePath) return
    pendingAction = { kind: 'finish', filePath, startedAtMs: performance.now() }
    if (params.runtime.setting.autoPlayNextSong && params.advanceToNextSong()) return
    params.pause()
  }

  const syncPendingAction = (currentSec: number, playing: boolean) => {
    const action = pendingAction
    if (!action) return false
    const expired = performance.now() - action.startedAtMs >= RANGE_ACTION_TIMEOUT_MS
    if (!sameRendererFilePath(action.filePath, currentFilePath.value) || expired) {
      pendingAction = null
      return false
    }
    if (action.kind === 'seek') {
      if (Math.abs(currentSec - action.targetSec) <= RANGE_ACTION_TARGET_TOLERANCE_SEC) {
        pendingAction = null
      }
      return true
    }
    if (!playing) {
      pendingAction = null
    }
    return true
  }

  const shouldIgnorePassedRangeEnd = (endSec: number, currentSec: number) => {
    const ignoreBefore = ignoreRangeEndsBeforeSec.value
    if (ignoreBefore === null) return false
    if (currentSec < ignoreBefore - RANGE_STOP_TOLERANCE_SEC) {
      ignoreRangeEndsBeforeSec.value = null
      return false
    }
    return endSec <= ignoreBefore + RANGE_STOP_TOLERANCE_SEC
  }

  const applyPlaybackRangeActivation = (startPlayback: boolean) => {
    if (!params.isEditMode.value || !currentFilePath.value) return
    if (params.runtime.setting.enablePlaybackRange !== true) return
    const currentSec = Math.max(0, Number(params.currentSeconds.value) || 0)
    const activeRanges = resolveActivePlaybackRanges()
    previousTimeSec.value = currentSec

    if (activeRanges.status === 'unanalysed') {
      queueCurrentSongSectionAnalysis()
      return
    }
    if (activeRanges.status !== 'ready') {
      ignoreRangeEndsBeforeSec.value = null
      return
    }

    const targetRange = findCurrentOrUpcomingPlaybackSectionRange(
      activeRanges.ranges,
      currentSec,
      RANGE_STOP_TOLERANCE_SEC
    )
    if (!targetRange) {
      ignoreRangeEndsBeforeSec.value = currentSec
      return
    }

    ignoreRangeEndsBeforeSec.value = null
    if (currentSec >= targetRange.startSec - RANGE_STOP_TOLERANCE_SEC) return
    startSeekAction(targetRange.startSec, startPlayback || params.resolvePlaying())
  }

  const handleLateSectionRangeReady = () => {
    const resolution = playbackSectionRangeResolution.value
    if (resolution.status !== 'ready') return
    const currentSec = Math.max(0, Number(params.currentSeconds.value) || 0)
    const targetRange = findCurrentOrUpcomingPlaybackSectionRange(
      resolution.ranges,
      currentSec,
      RANGE_STOP_TOLERANCE_SEC
    )
    if (!targetRange || currentSec >= targetRange.startSec - RANGE_STOP_TOLERANCE_SEC) return
    startSeekAction(targetRange.startSec, params.resolvePlaying())
  }

  const handlePlaybackRangeTick = (deck: HorizontalBrowseDeckKey) => {
    if (deck !== 'top') return
    const currentSec = Math.max(0, Number(params.currentSeconds.value) || 0)
    const active =
      params.isEditMode.value &&
      Boolean(currentFilePath.value) &&
      params.runtime.setting.enablePlaybackRange === true &&
      safeDurationSeconds.value > 0
    if (!active) {
      previousTimeSec.value = null
      pendingAction = null
      return
    }

    const playing = params.resolvePlaying()
    if (syncPendingAction(currentSec, playing)) {
      previousTimeSec.value = currentSec
      return
    }
    const previousSec = previousTimeSec.value
    previousTimeSec.value = currentSec
    if (
      !playing ||
      params.resolveLoopActive() ||
      previousSec === null ||
      currentSec < previousSec
    ) {
      return
    }

    if (isPlaybackSectionRangeMode(params.runtime.setting)) {
      const resolution = playbackSectionRangeResolution.value
      if (resolution.status !== 'ready') return
      const crossedRange = findCrossedPlaybackSectionRange(
        resolution.ranges,
        previousSec,
        currentSec,
        RANGE_STOP_TOLERANCE_SEC
      )
      if (!crossedRange || shouldIgnorePassedRangeEnd(crossedRange.endSec, currentSec)) return
      const nextRange = findNextPlaybackSectionRange(
        resolution.ranges,
        crossedRange.endSec,
        RANGE_STOP_TOLERANCE_SEC
      )
      if (nextRange) {
        startSeekAction(nextRange.startSec, true)
        return
      }
      finishRangePlayback()
      return
    }

    const customRange = resolveCustomPlaybackRange()
    if (!customRange || shouldIgnorePassedRangeEnd(customRange.endSec, currentSec)) return
    const effectiveEnd = Math.max(customRange.endSec - RANGE_STOP_TOLERANCE_SEC, 0)
    if (currentSec >= effectiveEnd && previousSec < effectiveEnd) {
      finishRangePlayback()
    }
  }
  const handleDeckPlaybackTick = (deck: HorizontalBrowseDeckKey) => {
    params.handleLoopPlaybackTick(deck)
    handlePlaybackRangeTick(deck)
  }

  watch(
    () => [params.isEditMode.value, currentFilePath.value] as const,
    ([editMode, filePath]) => {
      resetRangeRuntimeState()
      queuedSectionAnalysisFilePath.value = ''
      if (!editMode || !filePath) {
        sectionRangeFallbackFilePath.value = null
      }
    }
  )

  watch(
    () => ({
      editMode: params.isEditMode.value,
      filePath: currentFilePath.value,
      enabled: params.runtime.setting.enablePlaybackRange === true,
      mode: normalizePlaybackRangeMode(params.runtime.setting.playbackRangeMode),
      sectionKinds: normalizePlaybackRangeSectionKinds(
        params.runtime.setting.playbackRangeSectionKinds
      ).join('|'),
      sectionMatchMode: normalizePlaybackRangeSectionMatchMode(
        params.runtime.setting.playbackRangeSectionMatchMode
      )
    }),
    (state, previousState) => {
      if (!state.editMode || !state.filePath || !state.enabled) {
        ignoreRangeEndsBeforeSec.value = null
        return
      }
      if (!previousState) return

      const enteredEditMode = !previousState.editMode && state.editMode
      const becameEnabled = !previousState.enabled && state.enabled
      const modeChanged = previousState.enabled && previousState.mode !== state.mode
      const sectionSelectionChanged =
        previousState.enabled &&
        state.mode === 'section' &&
        (previousState.sectionKinds !== state.sectionKinds ||
          previousState.sectionMatchMode !== state.sectionMatchMode)

      if (enteredEditMode) {
        applyPlaybackRangeActivation(false)
      } else if (becameEnabled || modeChanged || sectionSelectionChanged) {
        applyPlaybackRangeActivation(true)
      }
    },
    { immediate: true }
  )

  watch(
    () => {
      const resolution = playbackSectionRangeResolution.value
      return {
        editMode: params.isEditMode.value,
        filePath: currentFilePath.value,
        sectionMode: isPlaybackSectionRangeMode(params.runtime.setting),
        status: resolution.status,
        ranges: resolution.ranges
          .map((range) => `${range.startSec.toFixed(3)}-${range.endSec.toFixed(3)}`)
          .join('|')
      }
    },
    (state) => {
      if (!state.editMode || !state.filePath || !state.sectionMode) {
        sectionRangeFallbackFilePath.value = null
        return
      }
      if (state.status === 'unanalysed') {
        sectionRangeFallbackFilePath.value = state.filePath
        queueCurrentSongSectionAnalysis()
        return
      }
      if (
        state.status === 'ready' &&
        sameRendererFilePath(sectionRangeFallbackFilePath.value, state.filePath)
      ) {
        sectionRangeFallbackFilePath.value = null
        handleLateSectionRangeReady()
        return
      }
      if (state.status === 'no-match') {
        sectionRangeFallbackFilePath.value = null
      }
    },
    { immediate: true }
  )

  return {
    playbackRangeOverlay,
    handleDeckPlaybackTick
  }
}
