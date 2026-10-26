import { computed, ref, watch, type ComputedRef } from 'vue'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo } from '../../../../../../types/globals'
import { useHarmonicReferenceKey } from '@renderer/composables/useHarmonicReferenceKey'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'
import { createSongRowPlaybackLookup } from '@renderer/utils/songRowPlaybackIdentity'

type SongsAreaViewState = 'welcome' | 'blank' | 'loading' | 'list'

// 当前播放行高亮、和声参考调，以及「滚到正在播放」的手动/自动跟随。
export function useSongsAreaPlayingFollow(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  viewState: ComputedRef<SongsAreaViewState>
  getRowKey: (song: ISongInfo) => string
  scrollToIndex: (index: number) => void
  scrollToIndexIfNeeded: (index: number) => void
}) {
  const { runtime, songsAreaState, viewState, getRowKey, scrollToIndex, scrollToIndexIfNeeded } =
    params

  const normalizePath = (filePath: string) =>
    normalizeFilePathForComparison(
      filePath,
      isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
    )
  const playingRowLookup = computed(() =>
    createSongRowPlaybackLookup(songsAreaState.songInfoArr, getRowKey, normalizePath)
  )
  const resolvePlayingRowKeys = (song: ISongInfo | null | undefined) => playingRowLookup.value(song)
  const playingSongFilePathForRows = computed(
    () => resolvePlayingRowKeys(runtime.playingData.playingSong)[0]
  )
  const playingSongFilePathsForRows = computed(() => {
    return [
      ...new Set([
        ...resolvePlayingRowKeys(runtime.playingData.playingSong),
        ...resolvePlayingRowKeys(runtime.horizontalBrowseDecks.topSong),
        ...resolvePlayingRowKeys(runtime.horizontalBrowseDecks.bottomSong)
      ])
    ]
  })
  const harmonicReferenceKeyForRows = useHarmonicReferenceKey(runtime)
  const currentPlayingRowKey = computed(() => {
    if (runtime.mainWindowBrowseMode === 'edit') {
      const topDeckSong = runtime.horizontalBrowseDecks.topSong
      if (topDeckSong) return resolvePlayingRowKeys(topDeckSong)[0] || ''
    }
    const playingSong = runtime.playingData.playingSong
    if (!playingSong) return ''
    return resolvePlayingRowKeys(playingSong)[0] || ''
  })
  const currentPlayingIndex = computed(() => {
    const rowKey = currentPlayingRowKey.value
    if (!rowKey) return -1
    return songsAreaState.songInfoArr.findIndex((song) => getRowKey(song) === rowKey)
  })
  const showScrollToPlaying = computed(() => {
    return (
      runtime.mainWindowBrowseMode !== 'horizontal' &&
      viewState.value === 'list' &&
      currentPlayingIndex.value >= 0
    )
  })

  const lastAutoScrollKey = ref('')
  const autoScrollPresence = computed(() => (currentPlayingIndex.value >= 0 ? '1' : '0'))
  const autoScrollIndexToken = computed(() =>
    currentPlayingIndex.value >= 0 ? String(currentPlayingIndex.value) : 'missing'
  )
  const autoScrollKey = computed(() => {
    const listUUID = songsAreaState.songListUUID || ''
    return `${listUUID}|${currentPlayingRowKey.value}|${autoScrollPresence.value}|${autoScrollIndexToken.value}`
  })
  const autoScrollTriggerKey = computed(() => {
    if (!runtime.setting.autoScrollToCurrentSong) return ''
    return autoScrollKey.value
  })

  watch(
    () => autoScrollTriggerKey.value,
    (key) => {
      if (!key) {
        lastAutoScrollKey.value = ''
        return
      }
      if (currentPlayingIndex.value < 0) return
      if (key === lastAutoScrollKey.value) return
      if (runtime.playingData.playingSongListUUID !== songsAreaState.songListUUID) return
      lastAutoScrollKey.value = key
      scrollToIndexIfNeeded(currentPlayingIndex.value)
    },
    { flush: 'post' }
  )

  const handleScrollToPlaying = () => {
    if (currentPlayingIndex.value < 0) return
    scrollToIndex(currentPlayingIndex.value)
  }

  return {
    playingSongFilePathForRows,
    playingSongFilePathsForRows,
    harmonicReferenceKeyForRows,
    showScrollToPlaying,
    handleScrollToPlaying
  }
}
