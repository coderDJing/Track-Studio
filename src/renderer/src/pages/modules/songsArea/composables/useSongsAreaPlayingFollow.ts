import { computed, ref, watch, type ComputedRef } from 'vue'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo } from '../../../../../../types/globals'

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

  const playingSongFilePathForRows = computed(() => {
    const playingSong = runtime.playingData.playingSong
    if (!playingSong) return undefined
    return getRowKey(playingSong)
  })
  const playingSongFilePathsForRows = computed(() => {
    const keys = new Set<string>()
    const mainRowKey = playingSongFilePathForRows.value
    if (mainRowKey) keys.add(mainRowKey)
    const topDeckSong = runtime.horizontalBrowseDecks.topSong
    if (topDeckSong) keys.add(getRowKey(topDeckSong))
    const bottomDeckSong = runtime.horizontalBrowseDecks.bottomSong
    if (bottomDeckSong) keys.add(getRowKey(bottomDeckSong))
    return [...keys]
  })
  const harmonicReferenceKeyForRows = computed(() => {
    if (runtime.mainWindowBrowseMode === 'browser') return ''
    if (runtime.mainWindowBrowseMode === 'edit') {
      return String(runtime.horizontalBrowseDecks.topSong?.key || '').trim()
    }
    const leaderDeck = runtime.horizontalBrowseDecks.leaderDeck
    if (leaderDeck === 'top') {
      return String(runtime.horizontalBrowseDecks.topSong?.key || '').trim()
    }
    if (leaderDeck === 'bottom') {
      return String(runtime.horizontalBrowseDecks.bottomSong?.key || '').trim()
    }
    return ''
  })
  const currentPlayingRowKey = computed(() => {
    if (runtime.mainWindowBrowseMode === 'edit') {
      const topDeckSong = runtime.horizontalBrowseDecks.topSong
      if (topDeckSong) return getRowKey(topDeckSong)
    }
    const playingSong = runtime.playingData.playingSong
    if (!playingSong) return ''
    return getRowKey(playingSong)
  })
  const currentPlayingIndex = computed(() => {
    const rowKey = currentPlayingRowKey.value
    if (!rowKey) return -1
    return songsAreaState.songInfoArr.findIndex((song) => getRowKey(song) === rowKey)
  })
  const showScrollToPlaying = computed(() => {
    return viewState.value === 'list' && currentPlayingIndex.value >= 0
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
