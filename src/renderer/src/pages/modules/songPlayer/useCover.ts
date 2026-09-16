import { ref, onUnmounted } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'

type BufferLikeData = {
  type?: unknown
  data?: unknown
}

export type CoverSaveSnapshot = {
  blobUrl: string
  songTitle: string
  artist: string
  format: string
}

export const saveCoverBlobAs = (snapshot: CoverSaveSnapshot) => {
  let extension = 'jpg'
  if (snapshot.format) {
    if (snapshot.format.includes('png')) extension = 'png'
    else if (snapshot.format.includes('jpeg') || snapshot.format.includes('jpg')) extension = 'jpg'
  }
  const suggestedName = `${snapshot.artist} - ${snapshot.songTitle}.${extension}`
  const link = document.createElement('a')
  link.href = snapshot.blobUrl
  link.download = suggestedName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

export const showSaveCoverContextMenu = async (
  event: MouseEvent,
  snapshot: CoverSaveSnapshot | null
) => {
  if (!snapshot?.blobUrl) return
  const menuArr = [[{ menuName: 'tracks.saveCoverAs', shortcutKey: '' }]]
  const result = await rightClickMenu({ menuArr, clickEvent: event })
  if (result !== 'cancel' && result.menuName === 'tracks.saveCoverAs') {
    saveCoverBlobAs(snapshot)
  }
}

export function useCover(runtime: ReturnType<typeof useRuntimeStore>) {
  const coverBlobUrl = ref('')
  const songInfoShow = ref(false)
  const isShowingContextMenu = ref(false)
  const contextMenuCoverSnapshot = ref<CoverSaveSnapshot | null>(null)
  let songInfoHideTimer: ReturnType<typeof setTimeout> | null = null
  let isCoverHovered = false
  let isSongInfoHovered = false

  const clearSongInfoHideTimer = () => {
    if (!songInfoHideTimer) return
    clearTimeout(songInfoHideTimer)
    songInfoHideTimer = null
  }

  const scheduleSongInfoHide = () => {
    clearSongInfoHideTimer()
    songInfoHideTimer = setTimeout(() => {
      songInfoHideTimer = null
      if (isCoverHovered || isSongInfoHovered || isShowingContextMenu.value) return
      songInfoShow.value = false
    }, 200)
  }

  const disposeCoverUrl = () => {
    if (coverBlobUrl.value && coverBlobUrl.value.startsWith('blob:')) {
      URL.revokeObjectURL(coverBlobUrl.value)
    }
    coverBlobUrl.value = ''
  }

  const toUint8Array = (raw: unknown): Uint8Array | null => {
    if (!raw) return null
    if (raw instanceof Uint8Array) return raw
    if (Array.isArray(raw)) return new Uint8Array(raw as number[])
    if (raw && typeof raw === 'object') {
      const data = raw as BufferLikeData
      if (Array.isArray(data.data)) {
        return new Uint8Array(data.data)
      }
    }
    return null
  }

  const applyCoverBytes = (bytes: Uint8Array, format?: string) => {
    disposeCoverUrl()
    const cloned = bytes.slice()
    const blob = new Blob([cloned], {
      type: format || 'image/jpeg'
    })
    coverBlobUrl.value = URL.createObjectURL(blob)
  }

  const setCoverByIPC = async (filePath: string) => {
    const preferLargerThumb = await fetchCoverFromCache(filePath, 512)
    if (preferLargerThumb) return

    const fallbackThumb = await fetchCoverFromCache(filePath, 256)
    if (fallbackThumb) return

    const stillCurrent = filePath === runtime.playingData.playingSong?.filePath
    if (stillCurrent) {
      disposeCoverUrl()
    }
  }

  const fetchCoverFromCache = async (filePath: string, size: number = 256): Promise<boolean> => {
    try {
      const songListUUID = runtime.playingData.playingSongListUUID
      const rootDir = songListUUID ? libraryUtils.findDirPathByUuid(songListUUID) : undefined
      const thumb = await window.electron.ipcRenderer.invoke(
        'getSongCoverThumb',
        filePath,
        size,
        rootDir || ''
      )
      if (!thumb || filePath !== runtime.playingData.playingSong?.filePath) {
        return false
      }
      if (thumb.data) {
        const bytes = toUint8Array(thumb.data)
        if (bytes && bytes.length > 0) {
          applyCoverBytes(bytes, thumb.format)
          return true
        }
      }
      if (thumb.dataUrl && typeof thumb.dataUrl === 'string') {
        disposeCoverUrl()
        coverBlobUrl.value = thumb.dataUrl
        return true
      }
      disposeCoverUrl()
      return false
    } catch (cacheError) {
      disposeCoverUrl()
      return false
    }
  }

  const handleSongMetadataUpdated = (payload: { filePath?: string }) => {
    const filePath = payload?.filePath
    if (!filePath) return
    if (runtime.playingData.playingSong?.filePath === filePath) {
      setCoverByIPC(filePath)
    }
  }

  const handleCoverMouseEnter = () => {
    isCoverHovered = true
    clearSongInfoHideTimer()
    songInfoShow.value = true
  }

  const handleCoverMouseLeave = () => {
    isCoverHovered = false
    scheduleSongInfoHide()
  }

  const handleSongInfoMouseEnter = () => {
    isSongInfoHovered = true
    clearSongInfoHideTimer()
  }

  const handleSongInfoMouseLeave = () => {
    isSongInfoHovered = false
    scheduleSongInfoHide()
  }

  const saveCoverAs = () => {
    if (!contextMenuCoverSnapshot.value) return
    saveCoverBlobAs(contextMenuCoverSnapshot.value)
  }

  const showCoverContextMenu = async (event: MouseEvent) => {
    if (!coverBlobUrl.value) return

    setTimeout(async () => {
      isShowingContextMenu.value = true
      clearSongInfoHideTimer()
      const currentSong = runtime.playingData.playingSong
      if (currentSong && coverBlobUrl.value) {
        contextMenuCoverSnapshot.value = {
          blobUrl: coverBlobUrl.value,
          songTitle: currentSong.title || t('tracks.unknownTrack'),
          artist: currentSong.artist || t('tracks.unknownArtist'),
          format: 'image/jpeg'
        }
      }

      await showSaveCoverContextMenu(event, contextMenuCoverSnapshot.value)
      isShowingContextMenu.value = false
      contextMenuCoverSnapshot.value = null
      scheduleSongInfoHide()
    }, 0)
  }

  onUnmounted(() => {
    clearSongInfoHideTimer()
    disposeCoverUrl()
    emitter.off('songMetadataUpdated', handleSongMetadataUpdated)
  })

  emitter.on('songMetadataUpdated', handleSongMetadataUpdated)

  return {
    coverBlobUrl,
    songInfoShow,
    isShowingContextMenu,
    contextMenuCoverSnapshot,
    setCoverByIPC,
    handleCoverMouseEnter,
    handleCoverMouseLeave,
    handleSongInfoMouseEnter,
    handleSongInfoMouseLeave,
    showCoverContextMenu,
    saveCoverAs,
    disposeCoverUrl
  }
}
