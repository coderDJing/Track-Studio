import { computed, ref, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { normalizePreviewBpm } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { HORIZONTAL_BROWSE_LOCAL_GRID_BPM_EPSILON } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailMath'
import { publishHorizontalBrowseLinkedGridVisualPhaseSample } from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualPhase'
import { useHorizontalBrowseSongBeatGridLookup } from './useHorizontalBrowseSongBeatGridLookup'
import { resolveHorizontalBrowseWaveformTimeScale } from './horizontalBrowseWaveformTimeScale'

type HorizontalBrowseDetailDirection = 'up' | 'down'
type HorizontalBrowseDetailLayout = 'full' | 'top-half' | 'bottom-half'

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

type HorizontalBrowseDetailPresentationStateParams = {
  song: () => ISongInfo | null
  direction: () => HorizontalBrowseDetailDirection
  gridBpm: () => number | undefined
  linkedGridActive: () => boolean
  linkedGridVisualPending: () => boolean
  waveformLayout: () => HorizontalBrowseDetailLayout
  waveformPlaybackActive: () => boolean
  resolveWaveformCurrentSeconds: () => number
  resolveWaveformPlaybackRate: () => number
  liveTempoPreviewActive: () => boolean
  previewBpm: Ref<number>
  previewFirstBeatMs: Ref<number>
  previewDownbeatBeatOffset: Ref<number>
  previewTimeBasisOffsetMs: Ref<number>
}

export const createHorizontalBrowseDetailPresentationState = (
  params: HorizontalBrowseDetailPresentationStateParams
) => {
  const visualGridBpm = ref(0)
  const visualGridFirstBeatMs = ref(0)
  const visualGridDownbeatBeatOffset = ref(0)
  const visualGridTimeBasisOffsetMs = ref(0)
  let lastAppliedPreviewTimeScale = 1

  const beatGridLookup = useHorizontalBrowseSongBeatGridLookup({
    beatGridMap: () => params.song()?.beatGridMap,
    durationSeconds: () => parseDurationToSeconds(params.song()?.duration)
  })

  const resolveDisplayGridBpm = () => {
    const song = params.song()
    const dynamicBpm = beatGridLookup.resolveBpmAtSeconds(params.resolveWaveformCurrentSeconds())
    if (dynamicBpm !== null) return normalizePreviewBpm(dynamicBpm)
    const songBpm = Number(song?.bpm)
    return Number.isFinite(songBpm) && songBpm > 0 ? normalizePreviewBpm(songBpm) : 0
  }

  const previewRenderBpm = computed(() => {
    const localBpm = Number(params.previewBpm.value)
    if (
      Number.isFinite(localBpm) &&
      localBpm > 0 &&
      Math.abs(localBpm - resolveDisplayGridBpm()) > HORIZONTAL_BROWSE_LOCAL_GRID_BPM_EPSILON
    ) {
      return normalizePreviewBpm(localBpm)
    }
    const gridBpm = Number(params.gridBpm())
    if (Number.isFinite(gridBpm) && gridBpm > 0) {
      return normalizePreviewBpm(gridBpm)
    }
    return localBpm || 0
  })

  const visualGridRenderBpm = computed(() => Number(visualGridBpm.value) || 0)

  const syncVisualGridStateFromPreview = () => {
    visualGridBpm.value = previewRenderBpm.value
    visualGridFirstBeatMs.value = params.previewFirstBeatMs.value
    visualGridDownbeatBeatOffset.value = params.previewDownbeatBeatOffset.value
    visualGridTimeBasisOffsetMs.value = params.previewTimeBasisOffsetMs.value
  }

  const resolveIncomingPreviewTimeScale = (playbackRate = params.resolveWaveformPlaybackRate()) =>
    resolveHorizontalBrowseWaveformTimeScale(playbackRate)

  const resolveCanvasVisualTimeScale = () =>
    params.linkedGridVisualPending() || params.liveTempoPreviewActive()
      ? Math.max(0.25, Number(lastAppliedPreviewTimeScale) || 1)
      : resolveIncomingPreviewTimeScale()

  const publishLinkedGridVisualPhaseSample = () => {
    if (params.waveformLayout() === 'full') return
    if (!params.linkedGridActive()) return
    if (!params.song()?.filePath) return
    publishHorizontalBrowseLinkedGridVisualPhaseSample({
      direction: params.direction(),
      active: true,
      clockActive: params.waveformPlaybackActive(),
      bpm: visualGridRenderBpm.value,
      firstBeatMs: visualGridFirstBeatMs.value,
      downbeatBeatOffset: visualGridDownbeatBeatOffset.value,
      currentSec: params.resolveWaveformCurrentSeconds(),
      playbackRate: params.resolveWaveformPlaybackRate()
    })
  }

  return {
    previewRenderBpm,
    visualGridBpm,
    visualGridFirstBeatMs,
    visualGridDownbeatBeatOffset,
    visualGridTimeBasisOffsetMs,
    visualGridRenderBpm,
    resolveDisplayGridBpm,
    resolveIncomingPreviewTimeScale,
    resolveCanvasVisualTimeScale,
    syncVisualGridStateFromPreview,
    publishLinkedGridVisualPhaseSample,
    getLastAppliedPreviewTimeScale: () => lastAppliedPreviewTimeScale,
    setLastAppliedPreviewTimeScale: (value: number) => {
      lastAppliedPreviewTimeScale = Math.max(0.25, Number(value) || 1)
    }
  }
}
