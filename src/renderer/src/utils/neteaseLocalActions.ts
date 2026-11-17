import type { ISongInfo } from '../../../types/globals'
import type { AudioConvertDialogResult } from '@renderer/components/audioConvertDialog.types'
import { startBpmFix } from '@renderer/utils/bpmFixActions'
import { mapNeteaseSongsToLocalFiles } from '@renderer/utils/neteaseActions'
import {
  isNeteasePendingPath,
  isNeteasePreviewUrl,
  parseNeteasePendingSongId,
  parseNeteaseSongId
} from '@renderer/utils/neteaseSongs'
import { openRekordboxXmlExportForSelectedTracks } from '@renderer/utils/rekordboxXmlExport'

const getFileExtension = (filePath: string) => {
  const normalizedPath = String(filePath || '').toLowerCase()
  return normalizedPath.match(/\.[^\\/.]+$/)?.[0] || ''
}

const isLocalAudioPath = (filePath: string) => {
  const path = String(filePath || '').trim()
  return Boolean(path) && !isNeteasePreviewUrl(path) && !isNeteasePendingPath(path)
}

export const pickNeteaseOutputDir = async (): Promise<string | null> => {
  const folderPath = (await window.electron.ipcRenderer.invoke('select-folder', false)) as
    string[] | string | null
  if (Array.isArray(folderPath) && folderPath[0]) return String(folderPath[0] || '').trim() || null
  if (typeof folderPath === 'string' && folderPath.trim()) return folderPath.trim()
  return null
}

export const startNeteaseAudioConvert = async (
  songs: ISongInfo[],
  allowedSourceExts: string[]
): Promise<void> => {
  const list = Array.isArray(songs) ? songs : []
  if (list.length === 0) return
  const sourceExts = Array.from(
    new Set(
      list
        .filter((song) => isLocalAudioPath(String(song.filePath || '')))
        .map((song) => getFileExtension(String(song.filePath || '')))
        .filter(Boolean)
    )
  )
  const resolvedSourceExts =
    sourceExts.length > 0
      ? sourceExts
      : (allowedSourceExts || []).map((item) => String(item || '').toLowerCase()).filter(Boolean)
  const { default: openConvertDialog } = await import('@renderer/components/audioConvertDialog')
  const dialogResult = (await openConvertDialog({
    sourceExts: resolvedSourceExts,
    lockNewFile: true,
    requireOutputDir: true
  })) as AudioConvertDialogResult
  if (dialogResult === 'cancel' || 'files' in dialogResult) return
  if (dialogResult.strategy !== 'new_file' || !String(dialogResult.outputDir || '').trim()) return
  const mapped = await mapNeteaseSongsToLocalFiles(list)
  if (mapped.length === 0) return
  await window.electron.ipcRenderer.invoke('audio:convert:start', {
    files: mapped.map((song) => song.filePath).filter((filePath) => Boolean(filePath)),
    options: {
      ...dialogResult,
      strategy: 'new_file',
      outputDir: String(dialogResult.outputDir || '').trim()
    }
  })
}

export const startNeteaseBpmFix = async (songs: ISongInfo[]): Promise<void> => {
  const list = Array.isArray(songs) ? songs : []
  if (list.length === 0) return
  const outputDir = await pickNeteaseOutputDir()
  if (!outputDir) return
  const mapped = await mapNeteaseSongsToLocalFiles(list)
  const filePaths = mapped.map((song) => song.filePath).filter((filePath) => Boolean(filePath))
  if (filePaths.length === 0) return
  await startBpmFix({
    filePaths,
    songListUUID: 'external',
    songListPath: outputDir,
    outputDir
  })
}

export const exportNeteaseTracksToRekordboxXml = async (options: {
  tracks: ISongInfo[]
  songListUUID: string
  playlistName?: string
}): Promise<void> => {
  const tracks = Array.isArray(options.tracks) ? options.tracks : []
  if (tracks.length === 0) return
  await openRekordboxXmlExportForSelectedTracks({
    tracks,
    sourceLibraryName: 'NeteaseLibrary',
    songListUUID: options.songListUUID,
    playlistName: options.playlistName,
    lockMode: 'copy',
    prepareTracks: async (selected) => {
      const mapped = await mapNeteaseSongsToLocalFiles(selected)
      return mapped.length > 0 ? mapped : null
    }
  })
}

export const showNeteaseSongInFolder = async (song: ISongInfo): Promise<void> => {
  const filePath = String(song?.filePath || '').trim()
  if (isLocalAudioPath(filePath)) {
    window.electron.ipcRenderer.send('show-item-in-folder', filePath)
    return
  }
  const songId =
    parseNeteasePendingSongId(filePath) ||
    parseNeteaseSongId(filePath) ||
    String(song?.neteaseSongId || '').trim()
  if (!songId) return
  const result = (await window.electron.ipcRenderer.invoke('netease:resolve-local', {
    songIds: [songId]
  })) as { items?: Array<{ filePath?: string }> } | null
  const localPath = String(result?.items?.[0]?.filePath || '').trim()
  if (!localPath) return
  window.electron.ipcRenderer.send('show-item-in-folder', localPath)
}
