import type { Ref } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { RekordboxBeatGridEntry, SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'

export type HorizontalBrowseDirection = 'up' | 'down'
export type HorizontalBrowseWaveformLayout = 'full' | 'top-half' | 'bottom-half'
export type HorizontalBrowseWaveformRenderStyle = 'columns' | 'raw-curve'

export type UseHorizontalBrowseRawWaveformCanvasOptions = {
  song: () => ISongInfo | null
  direction: () => HorizontalBrowseDirection
  cueSeconds: () => number | undefined
  hotCues: () => ISongHotCue[] | null | undefined
  memoryCues: () => ISongMemoryCue[] | null | undefined
  loopRange: () => { startSec: number; endSec: number } | null | undefined
  audioEditSelection?: () => { startSec: number; endSec: number } | null | undefined
  audioEditPendingStartSec?: () => number | null | undefined
  audioEditPendingEndSec?: () => number | null | undefined
  currentSeconds: () => number | undefined
  playbackRate: () => number | undefined
  visualTimeScale: () => number
  waveformGain?: () => number | undefined
  playing: Ref<boolean>
  playbackSyncRevision: Readonly<Ref<number>>
  rawData: Ref<RawWaveformData | null>
  mixxxData: Ref<MixxxWaveformData | null>
  previewStartSec: Ref<number>
  previewZoom: Ref<number>
  previewBpm: Readonly<Ref<number>>
  previewFirstBeatMs: Ref<number>
  previewDownbeatBeatOffset: Ref<number>
  beatGridMap?: () => SongBeatGridMapV2 | null | undefined
  rekordboxGridEntries?: () => RekordboxBeatGridEntry[] | null | undefined
  beatGridEditMode?: () => boolean
  beatGridVisibleFromSec?: () => number | null | undefined
  beatGridSelectedBoundarySec?: () => number | null | undefined
  showGridClipBoundaries?: () => boolean
  previewTimeBasisOffsetMs: Ref<number>
  dragging: Ref<boolean>
  previewLoading: Ref<boolean>
  allowNegativeTimeline: () => boolean
  waveformLayout: () => HorizontalBrowseWaveformLayout
  waveformRenderStyle: () => HorizontalBrowseWaveformRenderStyle
  stableWaveformSource?: () => boolean
  stableRenderRevision?: () => number
  linkedGridActive?: () => boolean
  phaseAwareScrollReuse?: () => boolean
  onPreparingPreviewTimeScale?: (timeScale: number, renderTargetIndex: 0 | 1) => void
  onPresentedPreviewTimeScale?: (timeScale: number) => void
}
