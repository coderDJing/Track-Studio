import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import {
  createPioneerDetailRawWaveform,
  type PioneerDetailWaveformData
} from './horizontalBrowsePioneerDetailWaveform'
import {
  getRekordboxDetailWaveformRequestChannel,
  isRekordboxExternalPlaybackSource,
  resolveSongExternalWaveformSource
} from '@renderer/utils/rekordboxExternalSource'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'

type SourceLoaderOptions = {
  song: () => ISongInfo | null
  previewLoading: Ref<boolean>
  compactVisualWaveformActive: Ref<boolean>
  previewStartSec: Ref<number>
  clearPendingLocalGridSignature: () => void
  clearDragReleaseHandoff: () => void
  clearPersistTimer: () => void
  clearPlaybackStableFrameRenderTimer: () => void
  resetCompactVisualWaveformStrip: () => void
  invalidateWaveformTiles: () => void
  commitAudioEditSourceRaw: (data: RawWaveformData | null) => void
  resetLiveWaveformData: () => void
  resetGridRenderer: () => void
  clearCanvas: () => void
  syncGridStateFromSongForDisplay: () => void
  resolvePreviewDurationSec: () => number
  scheduleDraw: (options: { preferPreviewStart: true }) => void
  resolvePlaybackAlignedStart: (seconds: number) => number
  resolveWaveformCurrentSeconds: () => number
  requestCompactVisualWaveformStrip: (
    seconds: number,
    options: { force: true; clearIfOutside: true }
  ) => Promise<unknown>
}

export const useHorizontalBrowseRawWaveformSourceLoader = (options: SourceLoaderOptions) => {
  let loadToken = 0
  const invalidateLoad = () => {
    loadToken += 1
  }

  const loadWaveform = async () => {
    const currentSong = options.song()
    const currentToken = ++loadToken
    options.clearPendingLocalGridSignature()
    options.clearDragReleaseHandoff()
    options.clearPersistTimer()
    options.clearPlaybackStableFrameRenderTimer()
    options.resetCompactVisualWaveformStrip()
    options.invalidateWaveformTiles()
    options.previewLoading.value = false
    options.compactVisualWaveformActive.value = false
    options.commitAudioEditSourceRaw(null)
    options.previewStartSec.value = 0
    options.resetLiveWaveformData()
    options.resetGridRenderer()
    options.clearCanvas()

    const filePath = String(currentSong?.filePath || '').trim()
    if (!filePath) {
      options.syncGridStateFromSongForDisplay()
      return
    }
    if (isRekordboxExternalPlaybackSource('', currentSong)) {
      const external = resolveSongExternalWaveformSource(currentSong)
      if (external) {
        try {
          const response = (await window.electron.ipcRenderer.invoke(
            getRekordboxDetailWaveformRequestChannel(external.sourceKind),
            external.rootPath,
            [external.analyzePath]
          )) as { items?: Array<{ data?: PioneerDetailWaveformData | null }> }
          if (currentToken !== loadToken || options.song()?.filePath !== currentSong?.filePath) {
            return
          }
          const detailData = response?.items?.[0]?.data
          const detailRaw = createPioneerDetailRawWaveform(
            detailData?.columns || [],
            options.resolvePreviewDurationSec(),
            detailData?.detailRate ?? detailData?.detail_rate,
            detailData?.style
          )
          if (detailRaw) {
            options.commitAudioEditSourceRaw(detailRaw)
            options.compactVisualWaveformActive.value = true
            options.scheduleDraw({ preferPreviewStart: true })
          }
        } catch {}
      }
      options.syncGridStateFromSongForDisplay()
      return
    }

    try {
      options.previewLoading.value = true
      options.syncGridStateFromSongForDisplay()
      options.previewStartSec.value = options.resolvePlaybackAlignedStart(
        options.resolveWaveformCurrentSeconds()
      )
      options.compactVisualWaveformActive.value = true
      await options.requestCompactVisualWaveformStrip(options.resolveWaveformCurrentSeconds(), {
        force: true,
        clearIfOutside: true
      })
      if (currentToken !== loadToken) return
    } catch {
      if (currentToken !== loadToken) return
      options.previewLoading.value = false
      options.compactVisualWaveformActive.value = true
      options.commitAudioEditSourceRaw(null)
      options.resetGridRenderer()
      options.clearCanvas()
      options.syncGridStateFromSongForDisplay()
    }
  }

  return { loadWaveform, invalidateLoad }
}
