import { computed, ref, watch, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import {
  PREVIEW_DOWNBEAT_BEAT_INTERVAL,
  formatPreviewBpm,
  normalizeBeatOffset,
  normalizePreviewBpm
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import {
  createSongBeatGridMapV2FromClips,
  createSongBeatGridMapV2FromFixedGrid,
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid,
  type SongBeatGridClipV2,
  type SongBeatGridMapV2
} from '@shared/songBeatGridMapV2'

type DynamicBeatGridTarget =
  | { type: 'clip'; index: number; manual: boolean }
  | { type: 'boundary'; index: number; manual: boolean }

type DynamicBeatGridAdjustmentScope = 'whole' | 'after'

type UseHorizontalBrowseDynamicBeatGridEditParams = {
  enabled: () => boolean
  autoSyncFromSong?: boolean
  song: () => ISongInfo | null
  previewBeatGridMap: Ref<SongBeatGridMapV2 | null>
  previewBpm: Ref<number>
  previewBpmInput: Ref<string>
  previewFirstBeatMs: Ref<number>
  previewDownbeatBeatOffset: Ref<number>
  previewStartSec: Ref<number>
  previewWrapRef: Ref<HTMLDivElement | null>
  resolveCurrentSec: () => number
  resolvePreviewAnchorSec: () => number
  resolvePreviewDurationSec: () => number
  resolveVisibleDurationSec: () => number
  resolveViewportStartSec?: () => number | null | undefined
  clampPreviewStart: (value: number) => number
  playbackActive?: () => boolean
  schedulePreviewDraw: () => void
  forceGridFrameRefresh?: () => void
  schedulePersistGridDefinition: () => void
}

const BOUNDARY_SELECT_HIT_PX = 8
const BOUNDARY_CREATE_NEAR_SEC = 0.05

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const normalizeDurationSec = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

const normalizeSecond = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Number(numeric.toFixed(6)) : 0
}

export const useHorizontalBrowseDynamicBeatGridEdit = (
  params: UseHorizontalBrowseDynamicBeatGridEditParams
) => {
  const selectedTarget = ref<DynamicBeatGridTarget>({ type: 'clip', index: 0, manual: false })
  const adjustmentScope = ref<DynamicBeatGridAdjustmentScope>('whole')
  const selectionFrozenByBpmInput = ref(false)
  let lastSyncedSongFilePath = ''

  const resolveDurationSec = () => normalizeDurationSec(params.resolvePreviewDurationSec())

  const resolveViewportStartSec = () => {
    const renderedStartSec = params.resolveViewportStartSec?.()
    if (typeof renderedStartSec === 'number' && Number.isFinite(renderedStartSec)) {
      return params.clampPreviewStart(renderedStartSec)
    }
    return params.clampPreviewStart(params.previewStartSec.value)
  }

  const resolveDynamicMap = () =>
    normalizeSongBeatGridMapV2(params.previewBeatGridMap.value, {
      durationSec: resolveDurationSec(),
      allowSingleClip: false
    })

  const resolveV2GridMap = () =>
    normalizeSongBeatGridMapV2(params.previewBeatGridMap.value ?? params.song()?.beatGridMap, {
      durationSec: resolveDurationSec(),
      allowSingleClip: true
    })

  const resolveClipIndexAtSec = (map: SongBeatGridMapV2, secInput: number) => {
    const sec = clampNumber(Number(secInput) || 0, 0, resolveDurationSec())
    let index = 0
    for (let candidate = 1; candidate < map.clips.length; candidate += 1) {
      if (map.clips[candidate].startSec > sec) break
      index = candidate
    }
    return index
  }

  const isDynamic = computed(() => resolveDynamicMap() !== null)
  const hasV2GridMap = computed(() => resolveV2GridMap() !== null)
  const wholeAdjustmentActive = computed(() => adjustmentScope.value === 'whole')
  const clipAdjustmentActive = computed(() => adjustmentScope.value === 'after')
  const isBoundarySelected = computed(
    () =>
      isDynamic.value &&
      adjustmentScope.value === 'after' &&
      selectedTarget.value.type === 'boundary'
  )
  const selectedBoundarySec = computed(() => {
    if (!isBoundarySelected.value) return null
    const map = resolveDynamicMap()
    const clip = map?.clips[selectedTarget.value.index]
    return typeof clip?.startSec === 'number' && Number.isFinite(clip.startSec)
      ? clip.startSec
      : null
  })
  const selectedClipVisibleFromSec = computed(() => {
    if (!isDynamic.value || adjustmentScope.value !== 'after') {
      return null
    }
    const map = resolveDynamicMap()
    const targetIndex = selectedTarget.value.index
    const clip = map?.clips[targetIndex]
    if (!clip || targetIndex <= 0) return null
    return typeof clip.startSec === 'number' && Number.isFinite(clip.startSec)
      ? clip.startSec
      : null
  })
  const resolveActiveClipIndex = () => {
    if (adjustmentScope.value !== 'after') return null
    const index = Math.max(0, Math.floor(Number(selectedTarget.value.index) || 0))
    return Number.isFinite(index) ? index : null
  }
  const gridControlsDisabled = computed(() => {
    if (adjustmentScope.value !== 'after') return false
    const map = resolveDynamicMap()
    const index = resolveActiveClipIndex()
    return index === null || !map?.clips[index]
  })

  const syncPreviewFromWholeTarget = () => {
    const map = resolveDynamicMap()
    const projection = projectSongBeatGridMapV2ToFixedGrid(map)
    const bpm = Number(projection?.bpm ?? params.song()?.bpm ?? params.previewBpm.value)
    params.previewBpm.value = normalizePreviewBpm(bpm)
    params.previewBpmInput.value =
      params.previewBpm.value > 0 ? formatPreviewBpm(params.previewBpm.value) : ''
    params.previewFirstBeatMs.value =
      Number(projection?.firstBeatMs ?? params.song()?.firstBeatMs ?? 0) || 0
    params.previewDownbeatBeatOffset.value = normalizeBeatOffset(
      Number(projection?.downbeatBeatOffset ?? params.song()?.downbeatBeatOffset ?? 0),
      PREVIEW_DOWNBEAT_BEAT_INTERVAL
    )
  }

  const resolveEditableMap = () => {
    const durationSec = resolveDurationSec()
    const currentMap =
      normalizeSongBeatGridMapV2(params.previewBeatGridMap.value ?? params.song()?.beatGridMap, {
        durationSec,
        allowSingleClip: true
      }) ??
      createSongBeatGridMapV2FromFixedGrid({
        bpm: params.previewBpm.value || params.song()?.bpm,
        firstBeatMs: params.previewFirstBeatMs.value || params.song()?.firstBeatMs,
        downbeatBeatOffset:
          params.previewDownbeatBeatOffset.value || params.song()?.downbeatBeatOffset,
        source: 'manual'
      })
    return currentMap
  }

  const selectClipBySec = (map: SongBeatGridMapV2, sec: number, manual: boolean) => {
    selectedTarget.value = {
      type: 'clip',
      index: resolveClipIndexAtSec(map, sec),
      manual
    }
  }

  const syncPreviewFromSelectedTarget = () => {
    const map = resolveDynamicMap()
    const selectedIndex = resolveActiveClipIndex()
    if (!map || selectedIndex === null) return
    const clip = map.clips[selectedIndex]
    if (!clip) return
    params.previewBpm.value = normalizePreviewBpm(clip.bpm)
    params.previewBpmInput.value = formatPreviewBpm(params.previewBpm.value)
    params.previewFirstBeatMs.value = Number((clip.anchorSec * 1000).toFixed(3))
    params.previewDownbeatBeatOffset.value = normalizeBeatOffset(
      clip.downbeatBeatOffset,
      PREVIEW_DOWNBEAT_BEAT_INTERVAL
    )
  }

  const applyEditedMap = (
    clips: readonly SongBeatGridClipV2[],
    selectionSec: number,
    manualSelection = true,
    nextScope: DynamicBeatGridAdjustmentScope = adjustmentScope.value
  ) => {
    const durationSec = resolveDurationSec()
    const nextMap = createSongBeatGridMapV2FromClips(clips, 'manual', {
      durationSec,
      allowSingleClip: true
    })
    if (!nextMap) return false
    if (nextMap.clips.length < 2) {
      const projection = projectSongBeatGridMapV2ToFixedGrid(nextMap)
      params.previewBeatGridMap.value = nextMap
      adjustmentScope.value = 'whole'
      selectedTarget.value = { type: 'clip', index: 0, manual: false }
      if (projection) {
        params.previewBpm.value = normalizePreviewBpm(projection.bpm)
        params.previewBpmInput.value = formatPreviewBpm(params.previewBpm.value)
        params.previewFirstBeatMs.value = projection.firstBeatMs
        params.previewDownbeatBeatOffset.value = normalizeBeatOffset(
          projection.downbeatBeatOffset,
          PREVIEW_DOWNBEAT_BEAT_INTERVAL
        )
      }
    } else {
      params.previewBeatGridMap.value = nextMap
      adjustmentScope.value = nextScope
      if (nextScope === 'whole') {
        selectedTarget.value = { type: 'clip', index: 0, manual: false }
        syncPreviewFromWholeTarget()
      } else {
        selectClipBySec(nextMap, selectionSec, manualSelection)
        syncPreviewFromSelectedTarget()
      }
    }
    params.forceGridFrameRefresh?.()
    params.schedulePreviewDraw()
    params.schedulePersistGridDefinition()
    return true
  }

  const updateSelectedClip = (
    updater: (clip: SongBeatGridClipV2) => SongBeatGridClipV2,
    selectionSec?: number
  ) => {
    if (adjustmentScope.value !== 'after') return false
    const currentTarget = selectedTarget.value
    const selectedIndex = resolveActiveClipIndex()
    if (selectedIndex === null) return false
    const map = resolveEditableMap()
    const clip = map?.clips[selectedIndex]
    if (!map || !clip) return false
    const nextClips = map.clips.map((item, index) =>
      index === selectedIndex ? updater(item) : item
    )
    const applied = applyEditedMap(nextClips, selectionSec ?? clip.startSec + 0.0001, true, 'after')
    if (applied && currentTarget.type === 'boundary') {
      selectedTarget.value = currentTarget
      syncPreviewFromSelectedTarget()
      params.schedulePreviewDraw()
    }
    return applied
  }

  const updateWholeGrid = (
    updater: (clip: SongBeatGridClipV2, index: number) => SongBeatGridClipV2,
    selectionSec = 0.0001
  ) => {
    const map = resolveEditableMap()
    if (!map) return false
    const nextClips = map.clips.map((clip, index) => updater(clip, index))
    return applyEditedMap(nextClips, selectionSec, false, 'whole')
  }

  const syncFromSong = () => {
    const songFilePath = String(params.song()?.filePath || '')
    const songFileChanged = songFilePath !== lastSyncedSongFilePath
    lastSyncedSongFilePath = songFilePath
    const previousScope = adjustmentScope.value
    const previousTarget = selectedTarget.value
    const previousPreviewSignature = params.previewBeatGridMap.value?.signature ?? ''
    const map = normalizeSongBeatGridMapV2(params.song()?.beatGridMap, {
      durationSec: resolveDurationSec(),
      allowSingleClip: true
    })
    const canPreserveAfterSelection =
      previousScope === 'after' &&
      !!map &&
      previousTarget.index > 0 &&
      previousTarget.index < map.clips.length
    const shouldKeepLocalAfterEdit =
      !songFileChanged &&
      previousScope === 'after' &&
      previousPreviewSignature !== '' &&
      map?.signature !== previousPreviewSignature
    if (shouldKeepLocalAfterEdit) return
    params.previewBeatGridMap.value = map
    if (!map) {
      adjustmentScope.value = 'whole'
      selectedTarget.value = { type: 'clip', index: 0, manual: false }
      return
    }
    if (canPreserveAfterSelection) {
      adjustmentScope.value = 'after'
      selectedTarget.value = previousTarget
      syncPreviewFromSelectedTarget()
      return
    }
    adjustmentScope.value = 'whole'
    selectedTarget.value = { type: 'clip', index: 0, manual: false }
    syncPreviewFromWholeTarget()
  }

  const syncSelectionToPlayhead = () => {
    if (!params.enabled() || !isDynamic.value) return
    if (adjustmentScope.value !== 'after') return
    if (params.playbackActive?.() === true) return
    if (selectedTarget.value.manual || selectionFrozenByBpmInput.value) return
    const map = resolveDynamicMap()
    if (!map) return
    selectClipBySec(map, params.resolveCurrentSec(), false)
    syncPreviewFromSelectedTarget()
  }

  const resolveClientXContext = (clientX: number) => {
    const wrap = params.previewWrapRef.value
    if (!wrap) return null
    const rect = wrap.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || rect.width <= 0) return null
    const localX = clampNumber(clientX - rect.left, 0, rect.width)
    const rangeDurationSec = Math.max(0.001, params.resolveVisibleDurationSec() || 0)
    const rangeStartSec = resolveViewportStartSec()
    return {
      rect,
      localX,
      rangeDurationSec,
      rangeStartSec,
      targetSec: rangeStartSec + (localX / rect.width) * rangeDurationSec
    }
  }

  const resolveClientXSec = (clientX: number) => resolveClientXContext(clientX)?.targetSec ?? null

  const selectTargetByPointer = (event: PointerEvent) => {
    if (!params.enabled() || !isDynamic.value) return false
    const wrap = params.previewWrapRef.value
    const map = resolveDynamicMap()
    const targetSec = resolveClientXSec(event.clientX)
    if (!wrap || !map || targetSec === null) return false
    const rect = wrap.getBoundingClientRect()
    const rangeDurationSec = Math.max(0.001, params.resolveVisibleDurationSec() || 0)
    const rangeStartSec = resolveViewportStartSec()
    let nearestBoundary: { index: number; distancePx: number } | null = null
    for (let index = 1; index < map.clips.length; index += 1) {
      const x = ((map.clips[index].startSec - rangeStartSec) / rangeDurationSec) * rect.width
      const distancePx = Math.abs(x - (event.clientX - rect.left))
      if (distancePx > BOUNDARY_SELECT_HIT_PX) continue
      if (nearestBoundary && nearestBoundary.distancePx <= distancePx) continue
      nearestBoundary = { index, distancePx }
    }
    if (nearestBoundary) {
      adjustmentScope.value = 'after'
      selectedTarget.value = { type: 'boundary', index: nearestBoundary.index, manual: true }
      params.schedulePreviewDraw()
      return true
    }
    if (isBoundarySelected.value) return false
    if (adjustmentScope.value !== 'after') return false
    const previousTarget = selectedTarget.value
    const nextIndex = resolveClipIndexAtSec(map, targetSec)
    selectedTarget.value = {
      type: 'clip',
      index: nextIndex,
      manual: true
    }
    syncPreviewFromSelectedTarget()
    const changed = previousTarget.type !== 'clip' || previousTarget.index !== nextIndex
    params.schedulePreviewDraw()
    return changed
  }

  const createBoundaryAfterPlayhead = () => {
    if (!params.enabled()) return false
    const durationSec = resolveDurationSec()
    if (durationSec <= 0) return false
    const map = resolveEditableMap()
    if (!map) return false
    const boundarySec = normalizeSecond(clampNumber(params.resolveCurrentSec(), 0, durationSec))
    if (boundarySec <= 0 || boundarySec >= durationSec) return false
    const boundaryCandidates = [
      { sec: 0, index: 0 },
      ...map.clips.slice(1).map((clip, index) => ({ sec: clip.startSec, index: index + 1 })),
      { sec: durationSec, index: map.clips.length }
    ]
    const nearest = boundaryCandidates
      .map((item) => ({ ...item, distance: Math.abs(item.sec - boundarySec) }))
      .sort((left, right) => left.distance - right.distance)[0]
    if (nearest && nearest.distance < BOUNDARY_CREATE_NEAR_SEC) {
      adjustmentScope.value = 'after'
      if (nearest.index > 0 && nearest.index < map.clips.length) {
        selectedTarget.value = { type: 'boundary', index: nearest.index, manual: true }
      } else {
        selectClipBySec(map, boundarySec, true)
      }
      params.schedulePreviewDraw()
      return true
    }
    const sourceClipIndex = resolveClipIndexAtSec(map, boundarySec)
    const sourceClip = map.clips[sourceClipIndex]
    if (!sourceClip) return false
    const phaseGuardSec = (60 / sourceClip.bpm) * 0.0002
    const nextClip = {
      ...sourceClip,
      startSec: boundarySec,
      anchorSec: normalizeSecond(sourceClip.anchorSec + phaseGuardSec)
    }
    const nextClips = [
      ...map.clips.slice(0, sourceClipIndex + 1),
      nextClip,
      ...map.clips.slice(sourceClipIndex + 1)
    ]
    adjustmentScope.value = 'after'
    if (!applyEditedMap(nextClips, boundarySec + 0.0001, true, 'after')) return false
    selectedTarget.value = { type: 'boundary', index: sourceClipIndex + 1, manual: true }
    params.schedulePreviewDraw()
    return true
  }

  const deleteSelectedBoundary = () => {
    if (!isBoundarySelected.value) return false
    const map = resolveDynamicMap()
    const boundaryIndex = selectedTarget.value.index
    if (!map || boundaryIndex <= 0 || boundaryIndex >= map.clips.length) return false
    const leftClip = map.clips[boundaryIndex - 1]
    const nextClips = map.clips.filter((_, index) => index !== boundaryIndex)
    return applyEditedMap(nextClips, leftClip.startSec + 0.0001, true, 'after')
  }

  const setSelectedClipBpm = (bpm: number) =>
    updateSelectedClip((clip) => ({
      ...clip,
      bpm: normalizePreviewBpm(bpm)
    }))

  const setActiveGridBpm = (bpm: number) =>
    adjustmentScope.value === 'after' ? setSelectedClipBpm(bpm) : false

  const shiftSelectedClip = (deltaMs: number) => {
    const currentTarget = selectedTarget.value
    const selectedIndex = resolveActiveClipIndex()
    if (selectedIndex === null) return false
    const deltaSec = Number(deltaMs) / 1000
    if (!Number.isFinite(deltaSec)) return false
    const map = resolveEditableMap()
    const clip = map?.clips[selectedIndex]
    if (!map || !clip) return false
    const nextAnchorSec = normalizeSecond(clip.anchorSec + deltaSec)
    const nextClips = map.clips.map((item, index) =>
      index === selectedIndex
        ? {
            ...item,
            anchorSec: nextAnchorSec
          }
        : item
    )
    const applied = applyEditedMap(nextClips, clip.startSec + 0.0001)
    if (applied && currentTarget.type === 'boundary') {
      selectedTarget.value = currentTarget
      syncPreviewFromSelectedTarget()
      params.schedulePreviewDraw()
    }
    return applied
  }

  const shiftWholeGrid = (deltaMs: number) => {
    const deltaSec = Number(deltaMs) / 1000
    if (!Number.isFinite(deltaSec)) return false
    return updateWholeGrid((clip) => ({
      ...clip,
      anchorSec: normalizeSecond(clip.anchorSec + deltaSec)
    }))
  }

  const shiftActiveGrid = (deltaMs: number) =>
    adjustmentScope.value === 'after' ? shiftSelectedClip(deltaMs) : shiftWholeGrid(deltaMs)

  const setSelectedClipDownbeatLineAtSec = (sec: number) =>
    updateSelectedClip((clip) => {
      const bpm = normalizePreviewBpm(clip.bpm)
      const beatSec = 60 / bpm
      const offset = normalizeBeatOffset(clip.downbeatBeatOffset, PREVIEW_DOWNBEAT_BEAT_INTERVAL)
      return {
        ...clip,
        anchorSec: normalizeSecond(sec - offset * beatSec)
      }
    }, sec)

  const setWholeGridDownbeatLineAtSec = (sec: number) => {
    const map = resolveEditableMap()
    const firstClip = map?.clips[0]
    if (!map || !firstClip) return false
    const bpm = normalizePreviewBpm(firstClip.bpm)
    const beatSec = 60 / bpm
    const offset = normalizeBeatOffset(firstClip.downbeatBeatOffset, PREVIEW_DOWNBEAT_BEAT_INTERVAL)
    const nextAnchorSec = normalizeSecond(sec - offset * beatSec)
    const deltaSec = nextAnchorSec - firstClip.anchorSec
    if (!Number.isFinite(deltaSec)) return false
    return updateWholeGrid(
      (clip) => ({
        ...clip,
        anchorSec: normalizeSecond(clip.anchorSec + deltaSec)
      }),
      sec
    )
  }

  const setActiveGridDownbeatLineAtSec = (sec: number) =>
    adjustmentScope.value === 'after'
      ? setSelectedClipDownbeatLineAtSec(sec)
      : setWholeGridDownbeatLineAtSec(sec)

  const selectWholeAdjustment = () => {
    if (!params.enabled()) return false
    adjustmentScope.value = 'whole'
    selectedTarget.value = { type: 'clip', index: 0, manual: false }
    selectionFrozenByBpmInput.value = false
    syncPreviewFromWholeTarget()
    params.forceGridFrameRefresh?.()
    params.schedulePreviewDraw()
    return true
  }

  if (params.autoSyncFromSong !== false) {
    watch(
      () => [params.song()?.filePath ?? '', params.song()?.beatGridMap?.signature ?? ''] as const,
      () => syncFromSong(),
      { immediate: true }
    )
  }

  watch(
    () =>
      [
        params.playbackActive?.() === true ? null : params.resolveCurrentSec(),
        params.previewBeatGridMap.value?.signature ?? '',
        params.playbackActive?.() === true
      ] as const,
    () => syncSelectionToPlayhead(),
    { flush: 'post' }
  )

  return {
    previewBeatGridMap: params.previewBeatGridMap,
    isDynamic,
    hasV2GridMap,
    adjustmentScope,
    wholeAdjustmentActive,
    clipAdjustmentActive,
    isBoundarySelected,
    selectedBoundarySec,
    selectedClipVisibleFromSec,
    gridControlsDisabled,
    syncFromSong,
    selectWholeAdjustment,
    selectTargetByPointer,
    createBoundaryAfterPlayhead,
    deleteSelectedBoundary,
    setSelectedClipBpm,
    setActiveGridBpm,
    shiftSelectedClip,
    shiftActiveGrid,
    setSelectedClipDownbeatLineAtSec,
    setActiveGridDownbeatLineAtSec,
    syncPreviewFromSelectedTarget,
    freezeSelectionForBpmInput: () => {
      selectionFrozenByBpmInput.value = true
    },
    releaseSelectionForBpmInput: () => {
      selectionFrozenByBpmInput.value = false
      syncSelectionToPlayhead()
    },
    clearHistory: () => {
      selectionFrozenByBpmInput.value = false
      selectedTarget.value = { type: 'clip', index: 0, manual: false }
      adjustmentScope.value = 'whole'
    }
  }
}
