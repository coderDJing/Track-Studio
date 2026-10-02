import { onMounted, onUnmounted, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  isHorizontalBrowseNativeDetailSong,
  loadHorizontalBrowseNativeDetailWaveform
} from './loadHorizontalBrowseNativeDetailWaveform'
import {
  loadUnifiedDisplayWaveformData,
  unifiedDisplayWaveformToRawData
} from './horizontalBrowseCompactVisualWaveform'
import { isSameHorizontalBrowseSongFilePath } from './horizontalBrowseShellSongs'

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
    if (isHorizontalBrowseNativeDetailSong(currentSong)) {
      options.previewLoading.value = true
      try {
        const detailRaw = await loadHorizontalBrowseNativeDetailWaveform(currentSong, {
          durationSec: options.resolvePreviewDurationSec()
        })
        if (currentToken !== loadToken || options.song()?.filePath !== filePath) return
        if (detailRaw) {
          options.commitAudioEditSourceRaw(detailRaw)
          options.compactVisualWaveformActive.value = true
          options.scheduleDraw({ preferPreviewStart: true })
        }
      } catch (error) {
        console.error('[external-native-detail-waveform] load failed', error)
      } finally {
        if (currentToken === loadToken) options.previewLoading.value = false
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

  const handleNativeSongWaveformUpdated = (_event: unknown, payload?: { filePath?: string }) => {
    const song = options.song()
    if (!isHorizontalBrowseNativeDetailSong(song)) return
    if (!isSameHorizontalBrowseSongFilePath(song.filePath, payload?.filePath)) return
    const filePath = song.filePath
    void loadUnifiedDisplayWaveformData(filePath, undefined, true)
      .then((data) => {
        if (!isSameHorizontalBrowseSongFilePath(options.song()?.filePath, filePath)) return
        const raw = data ? unifiedDisplayWaveformToRawData(data) : null
        if (!raw) return
        options.commitAudioEditSourceRaw(raw)
        options.compactVisualWaveformActive.value = true
        options.scheduleDraw({ preferPreviewStart: true })
      })
      .catch(() => undefined)
  }

  onMounted(() => {
    window.electron.ipcRenderer.on('song-waveform-updated', handleNativeSongWaveformUpdated)
  })
  onUnmounted(() => {
    window.electron.ipcRenderer.removeListener(
      'song-waveform-updated',
      handleNativeSongWaveformUpdated
    )
  })

  return { loadWaveform, invalidateLoad }
}
