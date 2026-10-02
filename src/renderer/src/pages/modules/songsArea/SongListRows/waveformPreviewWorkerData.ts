import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'
import type { SeratoWaveformOverviewData } from '@shared/seratoWaveformOverview'
import type { SongListWaveformWorkerData } from '@renderer/workers/songListWaveformPreview.types'

export type WaveformCacheEntry =
  | { kind: 'mixxx'; data: MixxxWaveformData }
  | { kind: 'pioneer'; data: IPioneerPreviewWaveformData }
  | { kind: 'compactVisual'; data: WaveformListPreviewData }
  | { kind: 'serato'; data: SeratoWaveformOverviewData }
  | null

export const toWaveformPreviewWorkerData = (
  data: WaveformCacheEntry
): SongListWaveformWorkerData => {
  if (!data) return null
  if (data.kind === 'pioneer') return { kind: 'pioneer', data: data.data }
  if (data.kind === 'compactVisual') return { kind: 'compactVisual', data: data.data }
  if (data.kind === 'serato') return { kind: 'serato', data: data.data }
  return { kind: 'mixxx', data: data.data }
}
