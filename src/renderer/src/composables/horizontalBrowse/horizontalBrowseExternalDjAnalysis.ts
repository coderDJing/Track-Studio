import type { ISongInfo } from 'src/types/globals'
import { normalizeSongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import type { HorizontalBrowseDeckKey } from './horizontalBrowseNativeTransport'

export const resolveExternalDjAnalysisTargets = (song: ISongInfo | null | undefined) => {
  if (song?.externalLibraryKind !== 'serato' && song?.externalLibraryKind !== 'traktor') return null
  const hasGrid = Boolean(normalizeSongBeatGridMapV2(song.beatGridMap, { allowSingleClip: true }))
  return { waveform: true, bpm: !hasGrid }
}

export const queueHorizontalBrowseDeckAnalysis = (
  deck: HorizontalBrowseDeckKey,
  song: ISongInfo | null | undefined,
  defer = false
) => {
  if (isRekordboxExternalPlaybackSource('', song)) return
  const filePath = String(song?.filePath || '').trim()
  if (!filePath) return
  const analysisTargets = resolveExternalDjAnalysisTargets(song)
  window.electron.ipcRenderer.send(
    defer ? 'key-analysis:queue-deck-idle' : 'key-analysis:queue-playing',
    {
      analysisAuthority: 'frkb',
      filePath,
      ...(!defer ? { focusSlot: `horizontal-browse-${deck}` } : {}),
      ...(analysisTargets ? { analysisTargets } : {})
    }
  )
}
