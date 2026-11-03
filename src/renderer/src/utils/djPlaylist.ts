import type { SongsAreaDjPlaylist, SplitSongsAreaPaneKey, useRuntimeStore } from '../stores/runtime'
import {
  replaceSongsAreaPaneSongList,
  resolveSongsAreaPaneForLibraryClick,
  showSongListInPane
} from './songsAreaSplit'

export const isDjPlaylistKey = (uuid: string) => /^(usb|desktop|serato|traktor):/.test(uuid)

export const djPlaylistKey = ({ browser, externalKind }: SongsAreaDjPlaylist) => {
  const source = browser.selectedSourceKey || browser.selectedSourceRootPath || 'rekordbox'
  return `${externalKind || browser.selectedSourceKind || 'usb'}:${source}:${browser.selectedPlaylistId}`
}

export function syncDjPlaylistTree(runtime: ReturnType<typeof useRuntimeStore>) {
  const navigator = runtime.pioneerDeviceLibrary
  if (navigator.loading || !navigator.selectedSourceKey) return
  for (const state of Object.values(runtime.songsAreaPanels.panes)) {
    const browser = state.djPlaylist?.browser
    if (
      browser &&
      browser.selectedSourceKey === navigator.selectedSourceKey &&
      browser.selectedLibraryType === navigator.selectedLibraryType &&
      browser.treeNodes !== navigator.treeNodes
    )
      browser.treeNodes = navigator.treeNodes
  }
}

export function captureDjPlaylist(
  runtime: ReturnType<typeof useRuntimeStore>,
  playlistId: number
): SongsAreaDjPlaylist {
  return {
    browser: { ...runtime.pioneerDeviceLibrary, selectedPlaylistId: playlistId },
    externalKind:
      runtime.externalDjLibrary.selectedSourceKey === runtime.pioneerDeviceLibrary.selectedSourceKey
        ? runtime.externalDjLibrary.selectedKind
        : null
  }
}

export function openDjPlaylist(
  runtime: ReturnType<typeof useRuntimeStore>,
  playlistId: number,
  splitPane?: SplitSongsAreaPaneKey
) {
  if (playlistId <= 0) return
  const source = captureDjPlaylist(runtime, playlistId)
  const uuid = djPlaylistKey(source)
  if (splitPane) {
    showSongListInPane(runtime, splitPane, uuid, source)
  } else {
    const pane = resolveSongsAreaPaneForLibraryClick(runtime)
    const state = runtime.songsAreaPanels.panes[pane]
    if (state.songListUUID === uuid && state.djPlaylist) {
      state.djPlaylist.browser.treeNodes = source.browser.treeNodes
    } else {
      replaceSongsAreaPaneSongList(runtime, pane, uuid, source)
    }
    runtime.setSongsAreaActivePane(pane)
  }
}
