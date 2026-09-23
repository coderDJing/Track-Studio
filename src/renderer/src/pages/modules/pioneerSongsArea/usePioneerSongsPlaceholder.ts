import { computed, ref, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import { t } from '@renderer/utils/translate'
import type {
  IPioneerPlaylistTrack,
  ISongInfo,
  ISongsAreaColumn
} from '../../../../../types/globals'

type UsePioneerSongsPlaceholderParams = {
  loading: Ref<boolean>
  isDesktopSource: ComputedRef<boolean>
  isExternalSource: ComputedRef<boolean>
  selectedPlaylistId: ComputedRef<number>
  originalTracks: ShallowRef<IPioneerPlaylistTrack[]>
  visibleSongs: Ref<ISongInfo[]>
  columnData: Ref<ISongsAreaColumn[]>
  emitPioneerSongsAreaLog: (event: string, payload?: Record<string, unknown>) => void
}

export const usePioneerSongsPlaceholder = (params: UsePioneerSongsPlaceholderParams) => {
  const lastLoggedSnapshot = ref('')
  const placeholderText = computed(() => {
    if (params.loading.value) {
      if (params.isExternalSource.value) return t('library.externalLibraryLoadingTracks')
      return params.isDesktopSource.value
        ? t('rekordboxDesktop.loadingPlaylistTracks')
        : t('pioneer.loadingPlaylistTracks')
    }
    if (!params.selectedPlaylistId.value) {
      if (params.isExternalSource.value) return t('library.externalLibrarySelectPlaylist')
      return params.isDesktopSource.value
        ? t('rekordboxDesktop.selectPlaylistPrompt')
        : t('pioneer.selectPlaylistPrompt')
    }
    if (!params.visibleSongs.value.length) {
      if (params.isExternalSource.value) return t('library.externalLibraryEmptyPlaylist')
      return params.isDesktopSource.value
        ? t('rekordboxDesktop.emptyPlaylist')
        : t('pioneer.emptyPlaylist')
    }
    return ''
  })

  watch(
    () => placeholderText.value,
    (value) => {
      const snapshot = JSON.stringify({
        placeholderText: value,
        loading: params.loading.value,
        selectedPlaylistId: params.selectedPlaylistId.value,
        originalTrackCount: params.originalTracks.value.length,
        visibleSongCount: params.visibleSongs.value.length,
        activeFilters: params.columnData.value
          .filter((col) => !!col.filterActive)
          .map((col) => col.key)
      })
      if (snapshot === lastLoggedSnapshot.value) return
      lastLoggedSnapshot.value = snapshot
      params.emitPioneerSongsAreaLog('placeholder-text-changed', {
        placeholderText: value,
        firstOriginalTracks: params.originalTracks.value.slice(0, 5).map((track) => ({
          rowKey: track.rowKey,
          title: track.title,
          filePath: track.filePath
        })),
        firstVisibleSongs: params.visibleSongs.value.slice(0, 5).map((song) => ({
          rowKey: song.mixtapeItemId || song.filePath,
          title: song.title,
          filePath: song.filePath
        }))
      })
    },
    { immediate: true }
  )

  return {
    placeholderText
  }
}
