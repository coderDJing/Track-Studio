import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'
import type { SeratoWaveformOverviewData } from '@shared/seratoWaveformOverview'

export type SongListWaveformWorkerData =
  | {
      kind: 'mixxx'
      data: MixxxWaveformData
    }
  | {
      kind: 'pioneer'
      data: IPioneerPreviewWaveformData
    }
  | {
      kind: 'compactVisual'
      data: WaveformListPreviewData
    }
  | {
      kind: 'serato'
      data: SeratoWaveformOverviewData
    }
  | null

export type SongListWaveformWorkerIncoming =
  | {
      type: 'attachCanvas'
      payload: {
        canvasId: string
        canvas: OffscreenCanvas
      }
    }
  | {
      type: 'detachCanvas'
      payload: {
        canvasId: string
      }
    }
  | {
      type: 'setData'
      payload: {
        filePath: string
        data: SongListWaveformWorkerData
      }
    }
  | {
      type: 'clearData'
      payload: {
        filePath: string
      }
    }
  | {
      type: 'render'
      payload: {
        canvasId: string
        filePath: string
        width: number
        height: number
        pixelRatio: number
        isHalf: boolean
        backgroundColor: string
        progressColor: string
        playedPercent: number
        durationSec: number
        themeVariant: 'light' | 'dark'
      }
    }
  | {
      type: 'clearCanvas'
      payload: {
        canvasId: string
      }
    }
