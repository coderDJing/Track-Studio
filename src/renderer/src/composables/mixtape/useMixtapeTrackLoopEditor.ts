import { nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties, type Ref } from 'vue'
import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import {
  BASE_PX_PER_SEC,
  GRID_DOWNBEAT_LINE_ZOOM,
  MIXTAPE_WIDTH_SCALE,
  ZOOM_MIN
} from '@renderer/composables/mixtape/constants'
import {
  buildMixtapeTrackLoopSections,
  buildMixtapeTrackLoopSignature,
  mapLoopedTrackLocalToBaseLocal,
  normalizeMixtapeTrackLoopSegments
} from '@renderer/composables/mixtape/mixtapeTrackLoop'
import type {
  MixtapeTrack,
  MixtapeTrackLoopSegment,
  SerializedVisibleGridLine,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'

type TranslateFn = (key: string, payload?: Record<string, unknown>) => string

type TrackLoopOverlayBlock = {
  key: string
  loopKey: string
  kind: 'source' | 'repeat'
  selected: boolean
  style: CSSProperties
}

type TrackLoopGridLine = {
  key: string
  baseSec: number
  displaySec: number
  level: 'downbeat' | 'beat'
  style: CSSProperties
  active: boolean
  disabled: boolean
  hoverLabel: string
}

type TrackLoopBoundaryMarker = {
  key: string
  loopKey: string | null
  kind: 'start' | 'end' | 'repeat'
  style: CSSProperties
}

type TrackLoopStatusChip = {
  title: string
  detail?: string
  hint?: string
  tone: 'info' | 'error'
  style?: CSSProperties
}

type TrackLoopRepeatControl = {
  loopKey: string
  style: CSSProperties
  label: string
  decreaseTitle: string
  increaseTitle: string
  clearTitle: string
  canDecrease: boolean
  canIncrease: boolean
  pending: boolean
}

export type TrackLoopOverlayViewModel = {
  blocks: TrackLoopOverlayBlock[]
  boundaryMarkers: TrackLoopBoundaryMarker[]
  gridLines: TrackLoopGridLine[]
  gridEmptyHint: string
  repeatControl: TrackLoopRepeatControl | null
  statusChip: TrackLoopStatusChip | null
  selectedLoopKey: string | null
  preview: boolean
}

type TrackLoopTrackUiState = {
  disabled: boolean
  selecting: boolean
  selectedLoop: boolean
}

type UseMixtapeTrackLoopEditorOptions = {
  t: TranslateFn
  tracks: Ref<MixtapeTrack[]>
  mixtapePlaylistId: Ref<string>
  renderZoomLevel: Ref<number>
  isLoopParamMode: Ref<boolean>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  clearTimelineLayoutCache: () => void
  updateTimelineWidth: (allowAutoFit?: boolean) => void
  scheduleTimelineDraw: () => void
  scheduleFullPreRender: () => void
  scheduleWorkerPreRender: () => void
}

type TrackLoopLineSelectionState = {
  trackId: string
  firstSec: number
  firstDisplaySec: number
}

type TrackLoopTransientStatus = {
  trackId: string
  title: string
  tone: 'info' | 'error'
  detail?: string
  hint?: string
}

type SelectedLoopState = {
  trackId: string
  loopKey: string
  anchorDisplaySec?: number
}

const LOOP_MIN_REPEAT_COUNT = 1
const LOOP_MAX_REPEAT_COUNT = 32
const LOOP_EPSILON = 0.0001
const LOOP_GRID_MIN_SPACING_PX = 14

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const roundSec = (value: number) => Number(Math.max(0, Number(value) || 0).toFixed(4))

const isEditableEventTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName?.toLowerCase() || ''
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

const isLoopControlEventTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element) return false
  return !!element.closest(
    '.mixtape-track-loop__repeat-controls, .mixtape-track-loop__repeat-btn, .mixtape-track-loop__status-chip'
  )
}

export const useMixtapeTrackLoopEditor = (options: UseMixtapeTrackLoopEditorOptions) => {
  const lineSelectionState = ref<TrackLoopLineSelectionState | null>(null)
  const selectedLoopState = ref<SelectedLoopState | null>(null)
  const transientStatus = ref<TrackLoopTransientStatus | null>(null)
  const repeatButtonPendingTrackIds = ref<Record<string, boolean>>({})
  let transientStatusTimer: ReturnType<typeof setTimeout> | null = null

  const triggerPreviewRefresh = () => {
    options.clearTimelineLayoutCache()
    options.updateTimelineWidth(false)
    options.scheduleTimelineDraw()
    options.scheduleFullPreRender()
    options.scheduleWorkerPreRender()
  }

  const triggerCommittedRefresh = () => {
    triggerPreviewRefresh()
    void nextTick(() => {
      options.clearTimelineLayoutCache()
      options.updateTimelineWidth(false)
      options.scheduleTimelineDraw()
    })
  }

  const replaceTrackLoops = (trackId: string, nextLoops: MixtapeTrackLoopSegment[]) => {
    const targetIndex = options.tracks.value.findIndex((track) => track.id === trackId)
    if (targetIndex < 0) return
    const current = options.tracks.value[targetIndex]
    const nextTrack: MixtapeTrack = {
      ...current,
      ...(nextLoops.length
        ? { loopSegments: nextLoops, loopSegment: nextLoops[0] }
        : { loopSegments: undefined, loopSegment: undefined })
    }
    options.tracks.value.splice(targetIndex, 1, nextTrack)
  }

  const resolveTrackBaseRuntime = (track: MixtapeTrack) => {
    const sourceDurationSec = Math.max(
      0,
      Number(options.resolveTrackSourceDurationSeconds(track)) || 0
    )
    const baseTrack: MixtapeTrack = {
      ...track,
      loopSegments: undefined,
      loopSegment: undefined
    }
    return buildTrackRuntimeTempoSnapshot({
      track: baseTrack,
      sourceDurationSec,
      zoom: Number(options.renderZoomLevel.value) || 0
    })
  }

  const resolveTrackDisplayDurationSec = (track: MixtapeTrack) => {
    const rawDisplayDurationSec = Math.max(
      0,
      Number(options.resolveTrackDurationSeconds(track)) || 0
    )
    if (rawDisplayDurationSec > LOOP_EPSILON) return rawDisplayDurationSec
    const baseDurationSec = Math.max(0, Number(resolveTrackBaseRuntime(track).baseDurationSec) || 0)
    const sections = buildMixtapeTrackLoopSections(
      baseDurationSec,
      resolveTrackLoopSegments(track, baseDurationSec)
    )
    return sections.reduce(
      (maxValue, section) => Math.max(maxValue, Number(section.displayEndSec) || 0),
      0
    )
  }

  const resolveLoopSelectionAnchorDisplaySec = (
    item: TimelineTrackLayout,
    event?: MouseEvent
  ): number | undefined => {
    if (!event) return undefined
    const displayDurationSec = resolveTrackDisplayDurationSec(item.track)
    if (displayDurationSec <= LOOP_EPSILON) return undefined
    const host =
      ((event.currentTarget as HTMLElement | null)?.closest('.lane-track') as HTMLElement | null) ||
      ((event.target as HTMLElement | null)?.closest('.lane-track') as HTMLElement | null)
    const hostRect = host?.getBoundingClientRect()
    if (!hostRect || hostRect.width <= 0) return undefined
    const offsetX = clampNumber(event.clientX - hostRect.left, 0, hostRect.width)
    return roundSec((offsetX / hostRect.width) * displayDurationSec)
  }

  const resolveFinestVisibleLevel = (levels: Array<'downbeat' | 'beat'>) => {
    if (levels.includes('beat')) return 'beat'
    return 'downbeat'
  }

  const resolveTrackVisibleGridLines = (track: MixtapeTrack) => {
    const sourceDurationSec = Math.max(
      0,
      Number(options.resolveTrackSourceDurationSeconds(track)) || 0
    )
    const zoom = Number(options.renderZoomLevel.value) || 0
    const runtime = buildTrackRuntimeTempoSnapshot({
      track,
      sourceDurationSec,
      zoom
    })
    const hasSourceGrid = !!runtime.timeMapInput.sourceBeatGridMap
    const useOverviewGrid = zoom < GRID_DOWNBEAT_LINE_ZOOM && hasSourceGrid
    const visibleGridLines = !hasSourceGrid
      ? []
      : useOverviewGrid
        ? runtime.timeMap.buildVisibleGridLines(GRID_DOWNBEAT_LINE_ZOOM)
        : runtime.visibleGridLines
    const finestLevel = resolveFinestVisibleLevel(visibleGridLines.map((line) => line.level))
    let previousDisplayPx = Number.NEGATIVE_INFINITY
    const pxPerSec = BASE_PX_PER_SEC * MIXTAPE_WIDTH_SCALE * Math.max(ZOOM_MIN, zoom)
    const gridLines = visibleGridLines
      .filter((line) => line.level === finestLevel)
      .map((line) => ({
        sec: roundSec(Number(line.sec)),
        sourceSec: roundSec(Number(line.sourceSec)),
        level: line.level
      }))
      .filter(
        (line, index, lines) =>
          Number.isFinite(line.sec) &&
          line.sec >= 0 &&
          line.sec <= Number(runtime.durationSec) + LOOP_EPSILON &&
          (index === 0 || Math.abs(line.sec - lines[index - 1]!.sec) > LOOP_EPSILON)
      )
      .filter((line) => {
        if (!useOverviewGrid) return true
        const displayPx = line.sec * pxPerSec
        if (displayPx - previousDisplayPx < LOOP_GRID_MIN_SPACING_PX) return false
        previousDisplayPx = displayPx
        return true
      }) satisfies SerializedVisibleGridLine[]
    return {
      baseDurationSec: Number(runtime.baseDurationSec),
      gridLines
    }
  }

  const resolveTrackLoopSegments = (track: MixtapeTrack, baseDurationSec?: number) =>
    normalizeMixtapeTrackLoopSegments(track.loopSegments ?? track.loopSegment, baseDurationSec)

  const buildTrackLoopSegmentKey = (segment: MixtapeTrackLoopSegment) =>
    `${Math.round(segment.startSec * 1000)}:${Math.round(segment.endSec * 1000)}`

  const resolveSelectedLoopSegment = (track: MixtapeTrack, baseDurationSec?: number) => {
    const selectedKey =
      selectedLoopState.value?.trackId === track.id ? selectedLoopState.value.loopKey : ''
    if (!selectedKey) return null
    return (
      resolveTrackLoopSegments(track, baseDurationSec).find(
        (segment) => buildTrackLoopSegmentKey(segment) === selectedKey
      ) || null
    )
  }

  const doesLoopOverlapExisting = (
    startSec: number,
    endSec: number,
    loops: MixtapeTrackLoopSegment[]
  ) =>
    loops.some(
      (loop) => startSec < loop.endSec - LOOP_EPSILON && endSec > loop.startSec + LOOP_EPSILON
    )

  const persistTrackLoops = async (trackId: string, loopSegments: MixtapeTrackLoopSegment[]) => {
    const playlistId = String(options.mixtapePlaylistId.value || '').trim()
    if (!playlistId || !window?.electron?.ipcRenderer?.invoke) return
    await window.electron.ipcRenderer.invoke('mixtape:update-track-loops', {
      entries: [
        {
          itemId: trackId,
          loopSegments: loopSegments.map((segment) => ({
            startSec: segment.startSec,
            endSec: segment.endSec,
            repeatCount: segment.repeatCount
          }))
        }
      ]
    })
  }

  const commitLoopMutations = async (
    trackId: string,
    originalLoops: MixtapeTrackLoopSegment[],
    nextLoopsOverride?: MixtapeTrackLoopSegment[]
  ) => {
    const track = options.tracks.value.find((item) => item.id === trackId)
    const nextLoops = nextLoopsOverride ?? (track ? resolveTrackLoopSegments(track) : [])
    try {
      await persistTrackLoops(trackId, nextLoops)
      triggerCommittedRefresh()
    } catch (error) {
      replaceTrackLoops(trackId, originalLoops)
      triggerCommittedRefresh()
      console.error('[mixtape-loop] persist failed', { trackId, error })
    }
  }

  const applyAndCommitTrackLoops = async (
    trackId: string,
    originalLoops: MixtapeTrackLoopSegment[],
    nextLoops: MixtapeTrackLoopSegment[]
  ) => {
    replaceTrackLoops(trackId, nextLoops)
    triggerPreviewRefresh()
    await commitLoopMutations(trackId, originalLoops, nextLoops)
  }

  const clearTransientStatus = () => {
    transientStatus.value = null
    if (transientStatusTimer) {
      clearTimeout(transientStatusTimer)
      transientStatusTimer = null
    }
  }

  const showTransientStatus = (
    trackId: string,
    title: string,
    tone: 'info' | 'error' = 'error',
    options?: { detail?: string; hint?: string; durationMs?: number }
  ) => {
    clearTransientStatus()
    transientStatus.value = {
      trackId,
      title,
      tone,
      detail: options?.detail,
      hint: options?.hint
    }
    transientStatusTimer = setTimeout(() => {
      transientStatus.value = null
      transientStatusTimer = null
      triggerPreviewRefresh()
    }, options?.durationMs ?? 1400)
    triggerPreviewRefresh()
  }

  const clearLineSelection = () => {
    if (!lineSelectionState.value) return
    lineSelectionState.value = null
    clearTransientStatus()
    triggerPreviewRefresh()
  }

  const sanitizeInteractionState = () => {
    const selection = lineSelectionState.value
    if (selection) {
      const track = options.tracks.value.find((item) => item.id === selection.trackId)
      const loops = track ? resolveTrackLoopSegments(track) : []
      if (!track || loops.length) {
        lineSelectionState.value = null
      }
    }
    if (selectedLoopState.value?.trackId) {
      const selectedTrack = options.tracks.value.find(
        (item) => item.id === selectedLoopState.value?.trackId
      )
      if (!selectedTrack || !resolveSelectedLoopSegment(selectedTrack)) {
        selectedLoopState.value = null
      }
    }
    if (
      transientStatus.value &&
      !options.tracks.value.some((item) => item.id === transientStatus.value?.trackId)
    ) {
      clearTransientStatus()
    }
  }

  const resolveSelectionStatusChip = (trackId: string): TrackLoopStatusChip | null => {
    if (transientStatus.value?.trackId === trackId) {
      return {
        title: transientStatus.value.title,
        detail: transientStatus.value.detail,
        hint: transientStatus.value.hint,
        tone: transientStatus.value.tone
      }
    }
    if (lineSelectionState.value?.trackId === trackId) {
      return {
        title: options.t('mixtape.loopSelectionLockedTitle'),
        detail: options.t('mixtape.loopSelectionLockedHint'),
        hint: options.t('mixtape.loopSelectionCancelHint'),
        tone: 'info'
      }
    }
    return null
  }

  const isDisplayGridLineDisabledForNewLoop = (
    displaySec: number,
    loops: MixtapeTrackLoopSegment[],
    baseDurationSec: number
  ) => {
    if (!loops.length) return false
    const sections = buildMixtapeTrackLoopSections(baseDurationSec, loops)
    const loopDisplayRanges = loops.map((loop) => {
      const loopKey = buildTrackLoopSegmentKey(loop)
      const loopSections = sections.filter((section) => section.loopKey === loopKey)
      const startSec = loopSections[0]?.displayStartSec ?? 0
      const endSec = loopSections[loopSections.length - 1]?.displayEndSec ?? startSec
      return { startSec, endSec }
    })
    for (const range of loopDisplayRanges) {
      if (Math.abs(displaySec - range.endSec) <= LOOP_EPSILON) return false
      if (
        displaySec >= range.startSec - LOOP_EPSILON &&
        displaySec <= range.endSec + LOOP_EPSILON
      ) {
        return true
      }
    }
    return false
  }

  const resolveTrackLoopTrackUiState = (track: MixtapeTrack): TrackLoopTrackUiState => {
    const lockedTrackId = lineSelectionState.value?.trackId || ''
    return {
      disabled: options.isLoopParamMode.value && !!lockedTrackId && lockedTrackId !== track.id,
      selecting: lineSelectionState.value?.trackId === track.id,
      selectedLoop:
        options.isLoopParamMode.value &&
        resolveTrackLoopSegments(track).length > 0 &&
        selectedLoopState.value?.trackId === track.id
    }
  }

  const resolveTrackLoopOverlay = (item: TimelineTrackLayout): TrackLoopOverlayViewModel | null => {
    const rawDisplayDurationSec = Math.max(
      0,
      Number(options.resolveTrackDurationSeconds(item.track)) || 0
    )
    const loops = resolveTrackLoopSegments(item.track)
    if (!loops.length && !options.isLoopParamMode.value) return null
    const { baseDurationSec, gridLines } = resolveTrackVisibleGridLines(item.track)
    const sections = buildMixtapeTrackLoopSections(baseDurationSec, loops)
    const fallbackDisplayDurationSec = sections.reduce(
      (maxValue, section) => Math.max(maxValue, Number(section.displayEndSec) || 0),
      0
    )
    const displayDurationSec = Math.max(rawDisplayDurationSec, fallbackDisplayDurationSec)
    const selectionTrackId = lineSelectionState.value?.trackId || ''
    const allowGridSelection =
      options.isLoopParamMode.value && (!selectionTrackId || selectionTrackId === item.track.id)
    const selectedLoopKey =
      options.isLoopParamMode.value && selectedLoopState.value?.trackId === item.track.id
        ? selectedLoopState.value.loopKey
        : null
    const statusChip = resolveSelectionStatusChip(item.track.id)
    const statusChipAnchorSec =
      lineSelectionState.value?.trackId === item.track.id
        ? lineSelectionState.value.firstDisplaySec
        : null
    if (displayDurationSec <= LOOP_EPSILON) {
      return options.isLoopParamMode.value || loops.length > 0 || statusChip
        ? {
            blocks: [],
            boundaryMarkers: [],
            gridLines: [],
            gridEmptyHint: allowGridSelection ? options.t('mixtape.loopGridUnavailableHint') : '',
            repeatControl: null,
            statusChip,
            selectedLoopKey,
            preview:
              lineSelectionState.value?.trackId === item.track.id ||
              Boolean(repeatButtonPendingTrackIds.value[item.track.id])
          }
        : null
    }

    const toStyle = (startSec: number, endSec: number): CSSProperties => ({
      left: `${(startSec / displayDurationSec) * 100}%`,
      width: `${((endSec - startSec) / Math.max(displayDurationSec, 0.0001)) * 100}%`
    })
    const toMarkerStyle = (sec: number): CSSProperties => ({
      left: `${(sec / displayDurationSec) * 100}%`
    })

    const overlayGridLines = allowGridSelection
      ? gridLines.map((line) => {
          const displaySec = line.sec
          const baseSec = loops.length
            ? mapLoopedTrackLocalToBaseLocal(displaySec, baseDurationSec, loops)
            : line.sec
          const disabled = isDisplayGridLineDisabledForNewLoop(displaySec, loops, baseDurationSec)
          return {
            key: `${item.track.id}-grid-${line.level}-${Math.round(displaySec * 1000)}`,
            baseSec,
            displaySec,
            level: line.level,
            style: toMarkerStyle(displaySec),
            disabled,
            hoverLabel: disabled
              ? ''
              : lineSelectionState.value?.trackId === item.track.id
                ? options.t('mixtape.loopGridPickSecondPointAction')
                : options.t('mixtape.loopGridPickFirstPointAction'),
            active:
              lineSelectionState.value?.trackId === item.track.id &&
              Math.abs(lineSelectionState.value.firstDisplaySec - displaySec) <= LOOP_EPSILON
          }
        })
      : []

    const loopDisplayRanges = loops.map((loop) => {
      const loopKey = buildTrackLoopSegmentKey(loop)
      const loopSections = sections.filter((section) => section.loopKey === loopKey)
      return {
        loop,
        loopKey,
        displayStartSec: loopSections[0]?.displayStartSec ?? 0,
        displayEndSec: loopSections[loopSections.length - 1]?.displayEndSec ?? 0
      }
    })
    const selectedLoopRange =
      loopDisplayRanges.find((range) => range.loopKey === selectedLoopKey) || null
    const repeatControlLeft =
      selectedLoopRange &&
      selectedLoopRange.displayEndSec > selectedLoopRange.displayStartSec &&
      displayDurationSec > LOOP_EPSILON
        ? clampNumber(
            ((selectedLoopState.value?.trackId === item.track.id
              ? (selectedLoopState.value.anchorDisplaySec ??
                (selectedLoopRange.displayStartSec + selectedLoopRange.displayEndSec) / 2)
              : (selectedLoopRange.displayStartSec + selectedLoopRange.displayEndSec) / 2) /
              displayDurationSec) *
              100,
            12,
            88
          )
        : 12
    const statusChipLeft =
      statusChipAnchorSec !== null && statusChipAnchorSec !== undefined
        ? clampNumber((statusChipAnchorSec / Math.max(displayDurationSec, 0.0001)) * 100, 12, 88)
        : 12

    return {
      blocks: sections
        .filter((section) => section.kind === 'loop-source' || section.kind === 'loop-repeat')
        .map((section) => ({
          key: `${item.track.id}-${section.key}`,
          loopKey: section.loopKey || '',
          kind: section.kind === 'loop-source' ? 'source' : 'repeat',
          selected: !!selectedLoopKey && section.loopKey === selectedLoopKey,
          style: toStyle(section.displayStartSec, section.displayEndSec)
        })),
      boundaryMarkers: sections
        .filter((section) => section.kind === 'loop-source' || section.kind === 'loop-repeat')
        .flatMap((section, index, list) => {
          const markers: TrackLoopBoundaryMarker[] = []
          if (section.kind === 'loop-source') {
            markers.push({
              key: `${item.track.id}-${section.key}-start`,
              loopKey: section.loopKey,
              kind: 'start',
              style: toMarkerStyle(section.displayStartSec)
            })
          }
          const isLastForLoop = !list[index + 1] || list[index + 1]!.loopKey !== section.loopKey
          markers.push({
            key: `${item.track.id}-${section.key}-${isLastForLoop ? 'end' : 'repeat'}`,
            loopKey: section.loopKey,
            kind: isLastForLoop ? 'end' : 'repeat',
            style: toMarkerStyle(section.displayEndSec)
          })
          return markers
        }),
      gridLines: overlayGridLines,
      gridEmptyHint: allowGridSelection ? options.t('mixtape.loopGridUnavailableHint') : '',
      repeatControl:
        options.isLoopParamMode.value && selectedLoopRange
          ? {
              loopKey: selectedLoopRange.loopKey,
              style: {
                left: `${repeatControlLeft}%`
              },
              label: options.t('mixtape.loopRepeatCountLabel', {
                count: selectedLoopRange.loop.repeatCount
              }),
              decreaseTitle: options.t('mixtape.loopRepeatDecreaseAction'),
              increaseTitle: options.t('mixtape.loopRepeatIncreaseAction'),
              clearTitle: options.t('mixtape.clearLoopAction'),
              canDecrease: selectedLoopRange.loop.repeatCount > LOOP_MIN_REPEAT_COUNT,
              canIncrease: selectedLoopRange.loop.repeatCount < LOOP_MAX_REPEAT_COUNT,
              pending: Boolean(repeatButtonPendingTrackIds.value[item.track.id])
            }
          : null,
      statusChip: statusChip
        ? {
            ...statusChip,
            style: {
              left: `${statusChipLeft}%`,
              transform: 'translateX(-50%)'
            }
          }
        : null,
      selectedLoopKey,
      preview:
        lineSelectionState.value?.trackId === item.track.id ||
        Boolean(repeatButtonPendingTrackIds.value[item.track.id])
    }
  }

  const resolveOverviewTrackLoopBlocks = (item: TimelineTrackLayout) => {
    const overlay = resolveTrackLoopOverlay(item)
    if (!overlay) return []
    return overlay.blocks.map((block) => ({
      key: block.key,
      kind: block.kind,
      style: block.style
    }))
  }

  const handleTrackLoopGridLineClick = (
    item: TimelineTrackLayout,
    baseSec: number,
    displaySec: number,
    disabled: boolean
  ) => {
    if (!options.isLoopParamMode.value) return
    const track = item.track
    const existingLoops = resolveTrackLoopSegments(track)
    const { baseDurationSec, gridLines } = resolveTrackVisibleGridLines(track)
    if (baseDurationSec <= 0 || !gridLines.length) return
    const targetSec = roundSec(clampNumber(baseSec, 0, baseDurationSec))
    const currentSelection = lineSelectionState.value

    if (currentSelection && currentSelection.trackId !== track.id) {
      showTransientStatus(
        currentSelection.trackId,
        options.t('mixtape.loopSelectionCrossTrackError')
      )
      return
    }

    if (disabled) {
      showTransientStatus(track.id, options.t('mixtape.loopSelectionStartBlockedError'))
      return
    }

    if (currentSelection && currentSelection.trackId === track.id) {
      if (Math.abs(currentSelection.firstSec - targetSec) <= LOOP_EPSILON) {
        showTransientStatus(track.id, options.t('mixtape.loopSelectionDuplicatePointError'))
        return
      }
      const nextLoop: MixtapeTrackLoopSegment = {
        startSec: roundSec(Math.min(currentSelection.firstSec, targetSec)),
        endSec: roundSec(Math.max(currentSelection.firstSec, targetSec)),
        repeatCount: LOOP_MIN_REPEAT_COUNT
      }
      if (doesLoopOverlapExisting(nextLoop.startSec, nextLoop.endSec, existingLoops)) {
        showTransientStatus(track.id, options.t('mixtape.loopSelectionOverlapError'))
        return
      }
      lineSelectionState.value = null
      clearTransientStatus()
      const nextLoops = [...existingLoops, nextLoop].sort(
        (left, right) => left.startSec - right.startSec
      )
      selectedLoopState.value = {
        trackId: track.id,
        loopKey: buildTrackLoopSegmentKey(nextLoop),
        anchorDisplaySec: displaySec
      }
      void applyAndCommitTrackLoops(track.id, existingLoops, nextLoops)
      return
    }

    lineSelectionState.value = {
      trackId: track.id,
      firstSec: targetSec,
      firstDisplaySec: displaySec
    }
    selectedLoopState.value = null
    clearTransientStatus()
    triggerPreviewRefresh()
  }

  const handleTrackLoopSelectLoop = (item: TimelineTrackLayout, event?: MouseEvent) => {
    if (!options.isLoopParamMode.value) return
    const loops = resolveTrackLoopSegments(item.track)
    if (!loops.length) return
    const currentSelection = lineSelectionState.value
    if (currentSelection && currentSelection.trackId !== item.track.id) {
      showTransientStatus(
        currentSelection.trackId,
        options.t('mixtape.loopSelectionCrossTrackError')
      )
      return
    }
    const anchorDisplaySec = resolveLoopSelectionAnchorDisplaySec(item, event)
    if (anchorDisplaySec === undefined) return
    const sections = buildMixtapeTrackLoopSections(
      Math.max(0, Number(resolveTrackBaseRuntime(item.track).baseDurationSec) || 0),
      loops
    )
    const matchedSection = sections.find(
      (section) =>
        section.loopKey &&
        anchorDisplaySec >= section.displayStartSec - LOOP_EPSILON &&
        anchorDisplaySec <= section.displayEndSec + LOOP_EPSILON
    )
    if (!matchedSection?.loopKey) return
    if (
      selectedLoopState.value?.trackId === item.track.id &&
      selectedLoopState.value.loopKey === matchedSection.loopKey &&
      selectedLoopState.value.anchorDisplaySec === anchorDisplaySec
    ) {
      return
    }
    selectedLoopState.value = {
      trackId: item.track.id,
      loopKey: matchedSection.loopKey,
      anchorDisplaySec
    }
    clearTransientStatus()
    triggerPreviewRefresh()
  }

  const handleTrackLoopTrackMouseDown = (item: TimelineTrackLayout, event?: MouseEvent) => {
    if (!options.isLoopParamMode.value) return false
    if (isLoopControlEventTarget(event?.target || null)) return false
    const loops = resolveTrackLoopSegments(item.track)
    const currentSelection = lineSelectionState.value
    if (currentSelection && currentSelection.trackId !== item.track.id) {
      showTransientStatus(
        currentSelection.trackId,
        options.t('mixtape.loopSelectionCrossTrackError')
      )
      return true
    }
    if (loops.length === 1 && event) {
      handleTrackLoopSelectLoop(item, event)
      return true
    }
    return loops.length > 0
  }

  const handleTrackLoopRepeatStep = (item: TimelineTrackLayout, step: -1 | 1) => {
    if (!options.isLoopParamMode.value) return
    const loops = resolveTrackLoopSegments(item.track)
    const selectedLoop =
      selectedLoopState.value?.trackId === item.track.id
        ? loops.find((loop) => buildTrackLoopSegmentKey(loop) === selectedLoopState.value?.loopKey)
        : null
    if (!selectedLoop || !selectedLoopState.value) return
    if (repeatButtonPendingTrackIds.value[item.track.id]) return
    const nextRepeatCount = clampNumber(
      selectedLoop.repeatCount + step,
      LOOP_MIN_REPEAT_COUNT,
      LOOP_MAX_REPEAT_COUNT
    )
    if (nextRepeatCount === selectedLoop.repeatCount) return
    const nextLoops = loops.map((loop) =>
      buildTrackLoopSegmentKey(loop) === selectedLoopState.value?.loopKey
        ? {
            ...loop,
            repeatCount: nextRepeatCount
          }
        : loop
    )
    const nextLoop = nextLoops.find(
      (loop) => buildTrackLoopSegmentKey(loop) === selectedLoopState.value?.loopKey
    )
    if (!nextLoop) return
    repeatButtonPendingTrackIds.value = {
      ...repeatButtonPendingTrackIds.value,
      [item.track.id]: true
    }
    void applyAndCommitTrackLoops(item.track.id, loops, nextLoops).finally(() => {
      const nextPending = { ...repeatButtonPendingTrackIds.value }
      delete nextPending[item.track.id]
      repeatButtonPendingTrackIds.value = nextPending
      selectedLoopState.value = {
        trackId: item.track.id,
        loopKey: buildTrackLoopSegmentKey(nextLoop),
        ...(selectedLoopState.value?.anchorDisplaySec !== undefined
          ? { anchorDisplaySec: selectedLoopState.value.anchorDisplaySec }
          : {})
      }
      triggerPreviewRefresh()
    })
  }

  const handleRemoveTrackLoop = async (trackId: string, loopKey?: string) => {
    const track = options.tracks.value.find((item) => item.id === trackId)
    const originalLoops = track ? resolveTrackLoopSegments(track) : []
    const targetLoopKey =
      loopKey ||
      (selectedLoopState.value?.trackId === trackId ? selectedLoopState.value.loopKey : '')
    if (!targetLoopKey) return
    if (lineSelectionState.value?.trackId === trackId) {
      lineSelectionState.value = null
    }
    if (selectedLoopState.value?.trackId === trackId) {
      selectedLoopState.value = null
    }
    clearTransientStatus()
    const nextLoops = originalLoops.filter(
      (loop) => buildTrackLoopSegmentKey(loop) !== targetLoopKey
    )
    replaceTrackLoops(trackId, nextLoops)
    triggerPreviewRefresh()
    await commitLoopMutations(trackId, originalLoops, nextLoops)
  }

  const handleLoopEditorKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || isEditableEventTarget(event.target)) return
    if (!options.isLoopParamMode.value) return
    if (event.key === 'Escape' && lineSelectionState.value) {
      event.preventDefault()
      clearLineSelection()
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleLoopEditorKeydown)
  })

  watch(
    () => options.isLoopParamMode.value,
    (nextIsLoopMode) => {
      if (nextIsLoopMode) return
      lineSelectionState.value = null
      selectedLoopState.value = null
      clearTransientStatus()
      triggerPreviewRefresh()
    }
  )

  watch(
    () =>
      options.tracks.value
        .map(
          (track) =>
            `${track.id}:${buildMixtapeTrackLoopSignature(track.loopSegments ?? track.loopSegment)}`
        )
        .join('|'),
    () => {
      sanitizeInteractionState()
      triggerPreviewRefresh()
      void nextTick(() => {
        options.clearTimelineLayoutCache()
        options.updateTimelineWidth(false)
        options.scheduleTimelineDraw()
      })
    }
  )

  onBeforeUnmount(() => {
    try {
      window.removeEventListener('keydown', handleLoopEditorKeydown)
    } catch {}
    clearTransientStatus()
  })

  return {
    resolveTrackLoopOverlay,
    resolveOverviewTrackLoopBlocks,
    resolveTrackLoopTrackUiState,
    handleTrackLoopGridLineClick,
    handleTrackLoopSelectLoop,
    handleTrackLoopTrackMouseDown,
    handleTrackLoopRepeatStep,
    handleRemoveTrackLoop
  }
}
