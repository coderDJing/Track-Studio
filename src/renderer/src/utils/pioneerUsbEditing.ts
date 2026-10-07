import type { ISongInfo } from 'src/types/globals'
import type { PioneerUsbSongEdit, PioneerUsbSongEditResponse } from '@shared/pioneerUsbEditing'
import { showPioneerUsbWriteError, prepareAndApplyPioneerUsbWrite } from './pioneerUsbWrite'
import { t } from './translate'
import emitter from './mitt'

export const isEditablePioneerUsbSong = (song: ISongInfo | null | undefined): boolean =>
  Boolean(
    song?.externalSourceKind === 'usb' &&
    song.pioneerUsbSource?.rootPath &&
    ['deviceLibrary', 'oneLibrary'].includes(song.pioneerUsbSource.libraryType) &&
    Number.isSafeInteger(song.pioneerUsbSource.trackId) &&
    song.pioneerUsbSource.trackId > 0
  )

export const canEditSongCues = (song: ISongInfo | null | undefined) =>
  Boolean(
    song?.filePath &&
    song.externalSourceKind !== 'desktop' &&
    (song.externalSourceKind !== 'usb' || isEditablePioneerUsbSong(song))
  )

/** The source travels with the loaded song; changing the browser selection cannot redirect a save. */
export const editPioneerUsbSong = async (song: ISongInfo, edit: PioneerUsbSongEdit) => {
  if (!isEditablePioneerUsbSong(song) || !song.pioneerUsbSource) return null
  try {
    const response = (await window.electron.ipcRenderer.invoke('pioneer-device-library:edit-song', {
      source: { ...song.pioneerUsbSource },
      filePath: song.filePath,
      edit: JSON.parse(JSON.stringify(edit))
    })) as PioneerUsbSongEditResponse
    if (!response.ok) throw new Error(response.error)
    emitter.emit('pioneerUsb/changed', { rootPath: song.pioneerUsbSource.rootPath })
    return response.result
  } catch (error) {
    await showPioneerUsbWriteError(error)
    return null
  }
}

export const deletePioneerUsbSong = async (song: ISongInfo): Promise<boolean> => {
  if (!isEditablePioneerUsbSong(song) || !song.pioneerUsbSource) return false
  const result = await prepareAndApplyPioneerUsbWrite(
    {
      rootPath: song.pioneerUsbSource.rootPath,
      libraryType: song.pioneerUsbSource.libraryType,
      operation: { kind: 'delete-tracks', trackIds: [song.pioneerUsbSource.trackId] }
    },
    `${t('tracks.deleteTracks')}: ${song.title || song.fileName}`
  )
  if (!result) return false
  emitter.emit('pioneerUsb/changed', { rootPath: song.pioneerUsbSource.rootPath })
  return true
}
