import type { ISongInfo } from '../../../types/globals'
import libraryUtils from '@renderer/utils/libraryUtils'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { NETEASE_DOWNLOADED_UUID } from '@shared/netease'

export type LibraryTransferActionMode = 'move' | 'copy'
export type LibraryTransferTarget =
  'FilterLibrary' | 'CuratedLibrary' | 'SetLibrary' | 'MixtapeLibrary'

/** 「查看已下载」的文件在 `.store` 里，按草案 9.6 只能复制、不能移动。 */
export const isNeteaseStoreCopyOnlySource = (songListUUID: string): boolean =>
  String(songListUUID || '') === NETEASE_DOWNLOADED_UUID

export const resolveLibraryTransferActionModeForSongList = (
  songListUUID: string
): LibraryTransferActionMode => {
  if (isNeteaseStoreCopyOnlySource(songListUUID)) return 'copy'
  const node = libraryUtils.getLibraryTreeByUUID(songListUUID)
  if (node?.type === 'mixtapeList' || node?.type === 'setList') return 'copy'
  return 'move'
}

export const resolveLibraryTransferActionModeForPlayback = (
  songListUUID: string,
  song?: ISongInfo | null
): LibraryTransferActionMode => {
  if (isRekordboxExternalPlaybackSource(songListUUID, song || null)) {
    return 'copy'
  }
  return resolveLibraryTransferActionModeForSongList(songListUUID)
}

export const resolveLibraryTransferActionLabelKey = (
  targetLibrary: LibraryTransferTarget,
  actionMode: LibraryTransferActionMode
) => {
  if (targetLibrary === 'MixtapeLibrary') {
    return actionMode === 'copy' ? 'library.addToMixtapeByCopy' : 'library.addToMixtape'
  }
  if (targetLibrary === 'SetLibrary') {
    return 'library.addToSet'
  }
  if (targetLibrary === 'FilterLibrary') {
    return actionMode === 'copy' ? 'library.copyToFilter' : 'library.moveToFilter'
  }
  return actionMode === 'copy' ? 'library.copyToCurated' : 'library.moveToCurated'
}
