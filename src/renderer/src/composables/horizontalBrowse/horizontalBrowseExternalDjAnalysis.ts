import type { ISongInfo } from 'src/types/globals'
import { normalizeSongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { isNeteasePendingPath, isNeteasePreviewUrl } from '@shared/netease'
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
  const rawPath = String(song?.filePath || '').trim()
  const filePath =
    rawPath && !isNeteasePreviewUrl(rawPath) && !isNeteasePendingPath(rawPath)
      ? rawPath
      : String(song?.neteaseLocalPath || '').trim()
  if (!filePath || isNeteasePreviewUrl(filePath) || isNeteasePendingPath(filePath)) return
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
