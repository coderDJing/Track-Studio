import type {
  ISongsAreaPaneRuntimeState,
  SongsAreaPaneKey,
  SplitSongsAreaPaneKey
} from '@renderer/stores/runtime'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'

type RuntimeStore = ReturnType<typeof useRuntimeStore>

const cloneSongsAreaPaneState = (
  state: ISongsAreaPaneRuntimeState
): ISongsAreaPaneRuntimeState => ({
  songListUUID: String(state.songListUUID || ''),
  searchQuery: String(state.searchQuery || ''),
  compatibleKeyOnly: !!state.compatibleKeyOnly,
  songInfoArr: Array.isArray(state.songInfoArr) ? [...state.songInfoArr] : [],
  missingWaveformFilePaths: Array.isArray(state.missingWaveformFilePaths)
    ? [...state.missingWaveformFilePaths]
    : [],
  totalSongCount: Number(state.totalSongCount || 0),
  selectedSongFilePath: Array.isArray(state.selectedSongFilePath)
    ? [...state.selectedSongFilePath]
    : [],
  scrollTop: Number.isFinite(state.scrollTop) ? state.scrollTop : 0,
  scrollLeft: Number.isFinite(state.scrollLeft) ? state.scrollLeft : 0,
  columnCacheByMode: Object.fromEntries(
    Object.entries(state.columnCacheByMode || {}).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map((item) => ({ ...item })) : []
    ])
  ) as ISongsAreaPaneRuntimeState['columnCacheByMode']
})

const buildPaneStateWithSongList = (
  source: ISongsAreaPaneRuntimeState,
  songListUUID: string
): ISongsAreaPaneRuntimeState => ({
  ...cloneSongsAreaPaneState(source),
  songListUUID,
  searchQuery: '',
  compatibleKeyOnly: false,
  songInfoArr: [],
  missingWaveformFilePaths: [],
  totalSongCount: 0,
  selectedSongFilePath: [],
  scrollTop: 0,
  scrollLeft: 0
})

const isPanePlaylistUUID = (uuid: string) => {
  const type = libraryUtils.getLibraryTreeByUUID(uuid)?.type
  return type === 'songList' || type === 'setList' || type === 'mixtapeList'
}

const syncPlayingSongListDataFromVisiblePane = (runtime: RuntimeStore) => {
  const playingSongListUUID = String(runtime.playingData.playingSongListUUID || '')
  if (!playingSongListUUID) return

  const paneOrder = runtime.songsAreaPanels.splitEnabled
    ? (['left', 'right', 'single'] as const)
    : (['single', 'left', 'right'] as const)
  const matchedPane = paneOrder.find(
    (pane) => runtime.songsAreaPanels.panes[pane].songListUUID === playingSongListUUID
  )
  if (!matchedPane) return

  runtime.playingData.playingSongListData = runtime.songsAreaPanels.panes[matchedPane].songInfoArr
}

export const getSongsAreaOppositePane = (pane: SplitSongsAreaPaneKey): SplitSongsAreaPaneKey =>
  pane === 'left' ? 'right' : 'left'

export const activateSongsAreaPane = (runtime: RuntimeStore, pane: SongsAreaPaneKey) => {
  runtime.setSongsAreaActivePane(pane)
}

export const clearSongsAreaPaneBySongListUUID = (runtime: RuntimeStore, songListUUID: string) => {
  for (const pane of ['single', 'left', 'right'] as const) {
    if (runtime.songsAreaPanels.panes[pane].songListUUID === songListUUID) {
      runtime.clearSongsAreaPaneState(pane)
    }
  }
}

export const replaceSongsAreaPaneSongList = (
  runtime: RuntimeStore,
  pane: SongsAreaPaneKey,
  songListUUID: string
) => {
  const paneState = runtime.songsAreaPanels.panes[pane]
  const nextState =
    paneState.songListUUID === songListUUID
      ? cloneSongsAreaPaneState(paneState)
      : buildPaneStateWithSongList(paneState, songListUUID)
  runtime.assignSongsAreaPaneState(pane, nextState)
}

export const showSongListInPane = (
  runtime: RuntimeStore,
  pane: SplitSongsAreaPaneKey,
  songListUUID: string
) => {
  const panes = runtime.songsAreaPanels.panes
  const otherPane = getSongsAreaOppositePane(pane)

  if (runtime.songsAreaPanels.splitEnabled) {
    if (panes[pane].songListUUID === songListUUID) {
      runtime.setSongsAreaActivePane(pane)
      syncPlayingSongListDataFromVisiblePane(runtime)
      return
    }
    replaceSongsAreaPaneSongList(runtime, pane, songListUUID)
    runtime.setSongsAreaActivePane(pane)
    syncPlayingSongListDataFromVisiblePane(runtime)
    return
  }

  const singleSnapshot = cloneSongsAreaPaneState(panes.single)
  const currentIsPlaylist = isPanePlaylistUUID(singleSnapshot.songListUUID)
  const preserveSnapshot = currentIsPlaylist ? singleSnapshot : null
  const paneSnapshot =
    currentIsPlaylist && singleSnapshot.songListUUID === songListUUID
      ? singleSnapshot
      : buildPaneStateWithSongList(singleSnapshot, songListUUID)

  // Move the live state object with its mounted view instead of cloning the retained list.
  const retainedPane = singleSnapshot.songListUUID === songListUUID ? pane : otherPane
  if (preserveSnapshot) {
    const spare = panes[retainedPane]
    panes[retainedPane] = panes.single
    panes.single = spare
    if (retainedPane === pane) {
      runtime.assignSongsAreaPaneState(otherPane, preserveSnapshot)
    } else {
      runtime.assignSongsAreaPaneState(pane, paneSnapshot)
    }
  } else {
    runtime.assignSongsAreaPaneState(pane, paneSnapshot)
    runtime.clearSongsAreaPaneState(otherPane)
  }
  runtime.songsAreaPanels.splitEnabled = true
  runtime.setSongsAreaActivePane(pane)
  syncPlayingSongListDataFromVisiblePane(runtime)
}

export const exitSongsAreaSplit = (runtime: RuntimeStore, paneToKeep: SplitSongsAreaPaneKey) => {
  const panes = runtime.songsAreaPanels.panes
  const spare = panes.single
  panes.single = panes[paneToKeep]
  panes[paneToKeep] = spare
  runtime.songsAreaPanels.splitEnabled = false
  runtime.setSongsAreaActivePane('single')
  syncPlayingSongListDataFromVisiblePane(runtime)
}

export const resolveSongsAreaPaneForLibraryClick = (runtime: RuntimeStore): SongsAreaPaneKey => {
  if (!runtime.songsAreaPanels.splitEnabled) return 'single'
  const activePane = runtime.songsAreaPanels.activePane
  if (activePane === 'left' || activePane === 'right') return activePane
  return 'left'
}
