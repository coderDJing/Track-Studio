import libraryUtils from '@renderer/utils/libraryUtils'
import { collectFilesForAudioConvert } from '@renderer/utils/audioConvertActions'
import { collectMissingAnalysisFilesFromSongs } from '@renderer/utils/manualKeyAnalysis'
import { mapMixtapeSnapshotToSongInfo } from '@renderer/composables/mixtape/mixtapeSnapshotSongMapper'
import type { MixtapeAppendSourceEntry } from '@renderer/utils/mixtapePlaylistAppend'
import type { IBatchRenameTrackInput, IDir, IMenu, ISongInfo } from 'src/types/globals'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

const normalizePathKey = (value: string) =>
  normalizeFilePathForComparison(value, isCurrentRendererWindowsPathPlatform())

type ScanSongListResult = {
  scanData?: ISongInfo[]
}

export type SongListTarget = {
  uuid: string
  path: string
  name: string
}

type BuildLibraryContextMenuOptions = {
  dirData: IDir | null
  libraryAreaSelected: string
  libraryName: string
  creatingSongListUUID: string
}

const canShowMissingAnalysisMenu = (
  node: IDir,
  libraryName: string,
  creatingSongListUUID: string
) =>
  (libraryName === 'FilterLibrary' || libraryName === 'CuratedLibrary') &&
  node.dirName !== '' &&
  creatingSongListUUID !== node.uuid &&
  (node.type === 'library' || node.type === 'dir' || node.type === 'songList')

export const buildLibraryContextMenuArr = ({
  dirData,
  libraryAreaSelected,
  libraryName,
  creatingSongListUUID
}: BuildLibraryContextMenuOptions): IMenu[][] => {
  if (!dirData) return []
  if (libraryAreaSelected === 'RecycleBin') {
    return [
      [{ menuName: 'recycleBin.permanentlyDelete' }],
      [{ menuName: 'tracks.showInFileExplorer' }],
      [{ menuName: 'tracks.convertFormat' }, { menuName: 'tracks.convertNonMp3ToMp3' }]
    ]
  }
  if (dirData.type === 'dir') {
    if (libraryAreaSelected === 'MixtapeLibrary') {
      return [
        [
          { menuName: 'library.createStemMixtape' },
          { menuName: 'library.createEqMixtape' },
          { menuName: 'library.createFolder' }
        ],
        [{ menuName: 'common.rename' }, { menuName: 'common.delete' }],
        [{ menuName: 'similarTracks.menu' }]
      ]
    }
    if (libraryAreaSelected === 'SetLibrary') {
      return [
        [{ menuName: 'library.createSetPlaylist' }, { menuName: 'library.createSetFolder' }],
        [{ menuName: 'common.rename' }, { menuName: 'common.delete' }],
        [{ menuName: 'similarTracks.menu' }]
      ]
    }
    return [
      [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
      [{ menuName: 'common.rename' }, { menuName: 'common.delete' }],
      [{ menuName: 'playlist.batchRename' }],
      [{ menuName: 'similarTracks.menu' }],
      ...(canShowMissingAnalysisMenu(dirData, libraryName, creatingSongListUUID)
        ? [[{ menuName: 'tracks.analyzeMissingTracks' }]]
        : [])
    ]
  }
  if (dirData.type === 'mixtapeList') {
    return [
      [{ menuName: 'playlist.autoMix' }],
      [{ menuName: 'common.rename' }, { menuName: 'playlist.deletePlaylist' }],
      [{ menuName: 'similarTracks.menu' }]
    ]
  }
  if (dirData.type === 'setList') {
    return [
      [{ menuName: 'tracks.exportTracks' }],
      [
        { menuName: 'common.rename' },
        { menuName: 'playlist.deletePlaylist' },
        { menuName: 'playlist.emptyPlaylist' }
      ],
      [{ menuName: 'playlist.showInLeftPane' }, { menuName: 'playlist.showInRightPane' }],
      [
        { menuName: 'rekordboxDesktop.menuCreatePlaylistFromPlaylist' },
        { menuName: 'rekordboxXmlExport.menuExportPlaylist' }
      ],
      [{ menuName: 'metadata.autoFillMenu' }, { menuName: 'playlist.batchRename' }],
      [{ menuName: 'tracks.analyzeMissingTracks' }, { menuName: 'tracks.reanalyzePlaylist' }],
      [{ menuName: 'similarTracks.menu' }],
      [{ menuName: 'playlist.calculateSetDuration' }],
      [{ menuName: 'library.addToMixtape' }],
      [{ menuName: 'tracks.convertFormat' }, { menuName: 'tracks.convertNonMp3ToMp3' }]
    ]
  }
  const isCoreLibrary = libraryName === 'FilterLibrary' || libraryName === 'CuratedLibrary'
  return [
    [{ menuName: 'tracks.importTracks' }, { menuName: 'tracks.exportTracks' }],
    [
      { menuName: 'rekordboxDesktop.menuCreatePlaylistFromPlaylist' },
      { menuName: 'rekordboxXmlExport.menuExportPlaylist' }
    ],
    [
      { menuName: 'common.rename' },
      { menuName: 'playlist.deletePlaylist' },
      { menuName: 'playlist.emptyPlaylist' }
    ],
    [{ menuName: 'playlist.showInLeftPane' }, { menuName: 'playlist.showInRightPane' }],
    [{ menuName: 'tracks.showInFileExplorer' }],
    [{ menuName: 'metadata.autoFillMenu' }, { menuName: 'playlist.batchRename' }],
    [{ menuName: 'playlist.fingerprintDeduplicate' }, { menuName: 'fingerprints.analyzeAndAdd' }],
    [{ menuName: 'similarTracks.menu' }],
    ...(dirData.type === 'songList' ? [[{ menuName: 'playlist.calculateSetDuration' }]] : []),
    ...(dirData.type === 'songList' ? [[{ menuName: 'library.addToMixtape' }]] : []),
    [{ menuName: 'tracks.convertFormat' }, { menuName: 'tracks.convertNonMp3ToMp3' }],
    ...(isCoreLibrary
      ? [[{ menuName: 'tracks.analyzeMissingTracks' }, { menuName: 'tracks.reanalyzePlaylist' }]]
      : [])
  ]
}

export const collectSongListUuids = (uuids: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  const traverse = (node: IDir) => {
    if (node.type === 'songList' && !seen.has(node.uuid)) {
      seen.add(node.uuid)
      result.push(node.uuid)
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => traverse(child))
    }
  }
  for (const uuid of uuids) {
    const node = libraryUtils.getLibraryTreeByUUID(uuid)
    if (node) traverse(node)
  }
  return result
}

export const collectSetListUuids = (uuids: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  const traverse = (node: IDir) => {
    if (node.type === 'setList' && !seen.has(node.uuid)) {
      seen.add(node.uuid)
      result.push(node.uuid)
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => traverse(child))
    }
  }
  for (const uuid of uuids) {
    const node = libraryUtils.getLibraryTreeByUUID(uuid)
    if (node) traverse(node)
  }
  return result
}

const collectMixtapeListUuids = (uuids: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  const traverse = (node: IDir) => {
    if (node.type === 'mixtapeList' && !seen.has(node.uuid)) {
      seen.add(node.uuid)
      result.push(node.uuid)
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => traverse(child))
    }
  }
  for (const uuid of uuids) {
    const node = libraryUtils.getLibraryTreeByUUID(uuid)
    if (node) traverse(node)
  }
  return result
}

export const scanSongListsForFiles = async (uuids: string[]): Promise<string[]> => {
  const files: string[] = []
  for (const uuid of uuids) {
    const dirPath = libraryUtils.findDirPathByUuid(uuid)
    const scan = (await window.electron.ipcRenderer.invoke(
      'scanSongList',
      dirPath,
      uuid
    )) as ScanSongListResult | null
    if (Array.isArray(scan?.scanData)) {
      files.push(...scan.scanData.map((s) => s.filePath).filter((item): item is string => !!item))
    }
  }
  return files
}

/**
 * 扫描普通歌单（songList）的完整 ISongInfo 列表（含 artist/title），按 filePath 去重。
 * 供「批量查找相似歌曲」使用：既要当种子，又要拿 artist/title 做「剔除已拥有」。
 */
export const scanSongListsForSongs = async (uuids: string[]): Promise<ISongInfo[]> => {
  const songs: ISongInfo[] = []
  const seen = new Set<string>()
  for (const uuid of uuids) {
    const dirPath = libraryUtils.findDirPathByUuid(uuid)
    const scan = (await window.electron.ipcRenderer.invoke(
      'scanSongList',
      dirPath,
      uuid
    )) as ScanSongListResult | null
    if (!Array.isArray(scan?.scanData)) continue
    for (const song of scan.scanData) {
      if (song?.fileMissing || !song?.filePath) continue
      const key = normalizePathKey(String(song.filePath))
      if (seen.has(key)) continue
      seen.add(key)
      songs.push(song)
    }
  }
  return songs
}

export const loadSetPlaylistSongs = async (playlistUuid: string): Promise<ISongInfo[]> => {
  const result = (await window.electron.ipcRenderer.invoke('setList:load-items', playlistUuid)) as {
    scanData?: ISongInfo[]
  } | null
  return Array.isArray(result?.scanData) ? result.scanData : []
}

const loadMixtapePlaylistSongs = async (playlistUuid: string): Promise<ISongInfo[]> => {
  const result = (await window.electron.ipcRenderer.invoke('mixtape:list', {
    playlistId: playlistUuid
  })) as {
    items?: Array<Record<string, unknown>>
  } | null
  const rawItems = Array.isArray(result?.items) ? result.items : []
  return rawItems.map((item, index) =>
    mapMixtapeSnapshotToSongInfo(item, index, {
      buildDisplayPathByUuid: (uuid) => libraryUtils.buildDisplayPathByUuid(uuid)
    })
  )
}

export const collectOrderedSongsForMixtape = async (
  uuids: string[]
): Promise<MixtapeAppendSourceEntry[]> => {
  const targets: Array<{ uuid: string; type: 'songList' | 'setList' }> = []
  const seen = new Set<string>()
  const traverse = (node: IDir) => {
    if ((node.type === 'songList' || node.type === 'setList') && !seen.has(node.uuid)) {
      seen.add(node.uuid)
      targets.push({ uuid: node.uuid, type: node.type })
      return
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => traverse(child))
    }
  }
  for (const uuid of uuids) {
    const node = libraryUtils.getLibraryTreeByUUID(uuid)
    if (node) traverse(node)
  }

  const entries: MixtapeAppendSourceEntry[] = []
  for (const target of targets) {
    const originPathSnapshot = libraryUtils.buildDisplayPathByUuid(target.uuid)
    let songs: ISongInfo[] = []
    if (target.type === 'setList') {
      songs = await loadSetPlaylistSongs(target.uuid)
    } else {
      const dirPath = libraryUtils.findDirPathByUuid(target.uuid)
      const scan = (await window.electron.ipcRenderer.invoke(
        'scanSongList',
        dirPath,
        target.uuid
      )) as ScanSongListResult | null
      songs = Array.isArray(scan?.scanData) ? scan.scanData : []
    }
    entries.push(
      ...songs.map((song) => ({
        song,
        originPlaylistUuid: target.uuid,
        originPathSnapshot
      }))
    )
  }
  return entries
}

const collectSetPlaylistFiles = async (uuids: string[]): Promise<string[]> => {
  const files: string[] = []
  for (const uuid of uuids) {
    const songs = await loadSetPlaylistSongs(uuid)
    files.push(
      ...songs
        .filter((song) => !song.fileMissing)
        .map((song) => song.filePath)
        .filter((item): item is string => !!item)
    )
  }
  return files
}

export const uniqueFilePaths = (files: string[]) => {
  const byKey = new Map<string, string>()
  for (const filePath of files) {
    const value = String(filePath || '').trim()
    const key = normalizePathKey(value)
    if (!value || byKey.has(key)) continue
    byKey.set(key, value)
  }
  return [...byKey.values()]
}

export const collectSetPlaylistMissingAnalysisFiles = async (
  uuids: string[],
  requiresRuntimeAnalysis: boolean
): Promise<string[]> => {
  const files: string[] = []
  const seen = new Set<string>()
  for (const uuid of uuids) {
    const songs = await loadSetPlaylistSongs(uuid)
    files.push(
      ...collectMissingAnalysisFilesFromSongs(songs, requiresRuntimeAnalysis, seen, {
        includeSongStructure: true
      })
    )
  }
  return files
}

export const collectSetPlaylistTracksForBatchRename = async (
  uuids: string[]
): Promise<IBatchRenameTrackInput[]> => {
  const tracks: IBatchRenameTrackInput[] = []
  let order = 0
  for (const uuid of uuids) {
    const songs = await loadSetPlaylistSongs(uuid)
    for (const song of songs) {
      if (song.fileMissing || !song.filePath) continue
      tracks.push({
        order,
        songListUUID: uuid,
        filePath: song.filePath,
        fileName: song.fileName || '',
        title: song.title,
        artist: song.artist,
        album: song.album,
        genre: song.genre,
        label: song.label,
        duration: song.duration,
        key: song.key,
        bpm: song.bpm
      })
      order += 1
    }
  }
  return tracks
}

export const collectFilesForCurrentTrackOperation = async (operateUuids: string[]) => {
  const songListUuids = collectSongListUuids(operateUuids)
  const setListUuids = collectSetListUuids(operateUuids)
  const songLists = songListUuids.map((uuid) => ({
    songListPath: libraryUtils.findDirPathByUuid(uuid),
    songListUUID: uuid
  }))
  const [songListFiles, setPlaylistFiles] = await Promise.all([
    songLists.length ? collectFilesForAudioConvert(songLists) : Promise.resolve([]),
    setListUuids.length ? collectSetPlaylistFiles(setListUuids) : Promise.resolve([])
  ])
  return [...songListFiles, ...setPlaylistFiles]
}

export const collectSongListTargets = (root: IDir): SongListTarget[] => {
  const result: SongListTarget[] = []
  const traverse = (node: IDir) => {
    if (node.type === 'songList') {
      result.push({
        uuid: node.uuid,
        path: libraryUtils.findDirPathByUuid(node.uuid),
        name: node.dirName
      })
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => traverse(child))
    }
  }
  traverse(root)
  return result
}

/**
 * 为「批量查找相似歌曲」收集完整 ISongInfo 列表：
 * 普通歌单走 scanSongListsForSongs，Set 歌单走 loadSetPlaylistSongs，
 * 混音歌单走 mixtape:list，按 filePath 去重合并。
 * 传入原始 operate UUIDs（库/文件夹/歌单皆可），内部递归展开到歌单。
 */
export const collectSongsForSimilarBatch = async (operateUuids: string[]): Promise<ISongInfo[]> => {
  const songListUuids = collectSongListUuids(operateUuids)
  const setListUuids = collectSetListUuids(operateUuids)
  const mixtapeListUuids = collectMixtapeListUuids(operateUuids)
  const [songListSongs, setSongsArrays, mixtapeSongsArrays] = await Promise.all([
    songListUuids.length ? scanSongListsForSongs(songListUuids) : Promise.resolve([]),
    setListUuids.length
      ? Promise.all(setListUuids.map((uuid) => loadSetPlaylistSongs(uuid)))
      : Promise.resolve([] as ISongInfo[][]),
    mixtapeListUuids.length
      ? Promise.all(mixtapeListUuids.map((uuid) => loadMixtapePlaylistSongs(uuid)))
      : Promise.resolve([] as ISongInfo[][])
  ])
  const merged: ISongInfo[] = [...songListSongs]
  const seen = new Set(songListSongs.map((s) => normalizePathKey(String(s.filePath))))
  for (const arr of [...setSongsArrays, ...mixtapeSongsArrays]) {
    for (const song of arr) {
      if (song?.fileMissing || !song?.filePath) continue
      const key = normalizePathKey(String(song.filePath))
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(song)
    }
  }
  return merged
}
