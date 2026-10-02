import type { ISongInfo } from 'src/types/globals'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  getRekordboxDetailWaveformRequestChannel,
  isRekordboxExternalPlaybackSource,
  resolveSongExternalWaveformSource
} from '@renderer/utils/rekordboxExternalSource'
import {
  createPioneerDetailRawWaveform,
  type PioneerDetailWaveformData
} from './horizontalBrowsePioneerDetailWaveform'
import {
  loadUnifiedDisplayWaveformData,
  unifiedDisplayWaveformToRawData
} from './horizontalBrowseCompactVisualWaveform'

export const isHorizontalBrowseNativeDetailSong = (
  song: ISongInfo | null | undefined
): song is ISongInfo => isRekordboxExternalPlaybackSource('', song)

export const loadHorizontalBrowseNativeDetailWaveform = async (
  song: ISongInfo,
  options: {
    durationSec: number
  }
): Promise<RawWaveformData | null> => {
  if (!isHorizontalBrowseNativeDetailSong(song)) return null
  const filePath = String(song.filePath || '').trim()
  if (!filePath) return null
  const manualData = await loadUnifiedDisplayWaveformData(filePath, undefined, true).catch(
    () => null
  )
  const manualRaw = manualData ? unifiedDisplayWaveformToRawData(manualData) : null
  if (manualRaw) return manualRaw

  const external = resolveSongExternalWaveformSource(song)
  if (!external) return null
  const response = (await window.electron.ipcRenderer.invoke(
    getRekordboxDetailWaveformRequestChannel(external.sourceKind),
    external.rootPath,
    [external.analyzePath]
  )) as { items?: Array<{ data?: PioneerDetailWaveformData | null }> }
  const detailData = response?.items?.[0]?.data
  return createPioneerDetailRawWaveform(
    detailData?.columns || [],
    options.durationSec,
    detailData?.detailRate ?? detailData?.detail_rate,
    detailData?.style
  )
}
