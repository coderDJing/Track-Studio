import {
  resolveLibraryTransferActionModeForSongList,
  type LibraryTransferActionMode
} from '@renderer/utils/libraryTransfer'
import { createMusicSearchMenuItems } from '@renderer/utils/musicSearch'
import type { IMenu } from '../../../../../../types/globals'

const RECORDING_LIBRARY_ANALYSIS_MENU_NAMES = new Set([
  'tracks.neteaseSearch',
  'tracks.spotifySearch',
  'similarTracks.menu',
  'metadata.autoFillMenu',
  'fingerprints.analyzeAndAdd',
  'tracks.clearTrackCache',
  'bpmFix.menu'
])

const cloneMenuItem = (item: IMenu): IMenu => ({
  ...item,
  ...(item.children ? { children: item.children.map(cloneMenuItem) } : {})
})

const cloneMenuArr = (source: IMenu[][]): IMenu[][] =>
  source.map((group) => group.map(cloneMenuItem))

const createFilterCuratedTransferMenus = (actionMode: LibraryTransferActionMode): IMenu[] => {
  if (actionMode === 'copy') {
    return [{ menuName: 'library.copyToFilter' }, { menuName: 'library.copyToCurated' }]
  }
  return [
    { menuName: 'library.moveToFilter' },
    { menuName: 'library.moveToCurated' },
    { menuName: 'library.copyToFilter' },
    { menuName: 'library.copyToCurated' }
  ]
}

export const buildSongItemMenuArr = (base: IMenu[][], matchedArtists: string[]) => {
  const next = cloneMenuArr(base)
  if (matchedArtists.length > 0) {
    next.splice(2, 0, [{ menuName: 'library.removeCuratedArtistFavorite' }])
  }
  return next
}

export const createDefaultMenuArr = (songListUUID: string): IMenu[][] => [
  [{ menuName: 'tracks.exportTracks' }],
  [
    { menuName: 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks' },
    { menuName: 'rekordboxXmlExport.menuExportSelectedTracks' },
    { menuName: 'library.writeToSeratoPlaylist' },
    { menuName: 'library.writeToTraktorPlaylist' }
  ],
  [
    ...createFilterCuratedTransferMenus(resolveLibraryTransferActionModeForSongList(songListUUID)),
    { menuName: 'library.addToSet' },
    { menuName: 'library.addToMixtape' }
  ],
  [
    { menuName: 'tracks.deleteTracks', shortcutKey: 'Delete' },
    { menuName: 'tracks.deleteAllAbove' }
  ],
  [{ menuName: 'tracks.showInFileExplorer' }],
  createMusicSearchMenuItems(),
  [{ menuName: 'similarTracks.menu' }],
  [{ menuName: 'metadata.autoFillMenu' }, { menuName: 'tracks.editMetadata' }],
  [{ menuName: 'fingerprints.analyzeAndAdd' }],
  [{ menuName: 'tracks.convertFormat' }],
  [{ menuName: 'tracks.clearTrackCache' }],
  [{ menuName: 'stemSeparation.menu' }, { menuName: 'bpmFix.menu' }]
]

export const createSetMenuArr = (songListUUID: string): IMenu[][] =>
  createDefaultMenuArr(songListUUID)
    .map((group) =>
      group
        .filter((item) => item.menuName !== 'tracks.deleteAllAbove')
        .map((item) =>
          item.menuName === 'tracks.deleteTracks'
            ? { ...item, menuName: 'library.removeFromSet' }
            : item
        )
    )
    .filter((group) => group.length > 0)

export const createRecycleMenuArr = (): IMenu[][] => [
  [{ menuName: 'recycleBin.restoreToOriginal' }],
  [{ menuName: 'tracks.exportTracks' }],
  [...createFilterCuratedTransferMenus('move')],
  [
    { menuName: 'recycleBin.permanentlyDeleteTracks', shortcutKey: 'Delete' },
    { menuName: 'tracks.deleteAllAbove' }
  ],
  [{ menuName: 'tracks.showInFileExplorer' }],
  createMusicSearchMenuItems(),
  [{ menuName: 'similarTracks.menu' }],
  [{ menuName: 'metadata.autoFillMenu' }, { menuName: 'tracks.editMetadata' }],
  [{ menuName: 'fingerprints.analyzeAndAdd' }],
  [{ menuName: 'tracks.convertFormat' }],
  [{ menuName: 'tracks.clearTrackCache' }],
  [{ menuName: 'stemSeparation.menu' }]
]

export const createMixtapeMenuArr = (): IMenu[][] => [
  [{ menuName: 'tracks.exportTracks' }],
  [
    { menuName: 'library.copyToFilter' },
    { menuName: 'library.copyToCurated' },
    { menuName: 'library.addToSet' },
    { menuName: 'library.addToMixtape' }
  ],
  [{ menuName: 'tracks.deleteTracks', shortcutKey: 'Delete' }],
  [{ menuName: 'tracks.showInFileExplorer' }],
  createMusicSearchMenuItems(),
  [{ menuName: 'similarTracks.menu' }],
  [{ menuName: 'tracks.editMetadata' }],
  [{ menuName: 'tracks.clearTrackCache' }],
  [{ menuName: 'stemSeparation.menu' }, { menuName: 'bpmFix.menu' }]
]

export const withoutRecordingAnalysisMenus = (groups: IMenu[][]): IMenu[][] =>
  groups
    .map((group) =>
      group.filter((item) => !RECORDING_LIBRARY_ANALYSIS_MENU_NAMES.has(item.menuName))
    )
    .filter((group) => group.length > 0)

/**
 * 网易云歌单里的一行。
 *
 * 这一行的 filePath 是 `frkb-preview://` 流地址，磁盘上**没有**这个文件，
 * 所以默认菜单里写 U 盘、复制到库、改名、转码这类项不能出现——点了只会把流地址送进文件系统。
 * 导出可以出现：点了会先下载到 `.store/` 再继续。另外只留加入 SET、下载到本地或删缓存。
 */
export const createNeteaseStreamMenuArr = (downloaded: boolean): IMenu[][] => {
  const localActions: IMenu[] = downloaded
    ? [{ menuName: 'netease.redownload' }, { menuName: 'netease.removeLocalFile' }]
    : [{ menuName: 'netease.downloadToLocal' }]
  return [
    [{ menuName: 'tracks.exportTracks' }],
    localActions,
    [{ menuName: 'library.addToSet' }],
    createMusicSearchMenuItems()
  ]
}

/**
 * SET 里还在待下载（或仍是预览地址）的一行。
 *
 * 磁盘上还没有这份文件，所以在文件夹中显示、转码、分轨、清缓存这些项不能出现。
 * 导出可以出现：点了会先下载到 `.store/` 再继续。从 SET 移除是安全的。
 * 「下载到本地」留给下载失败后重试。
 */
export const createNeteaseSetStreamMenuArr = (): IMenu[][] => [
  [{ menuName: 'tracks.exportTracks' }],
  [{ menuName: 'netease.downloadToLocal' }],
  [{ menuName: 'library.removeFromSet' }],
  createMusicSearchMenuItems()
]

/**
 * 「查看已下载」里的一行。
 *
 * 与歌单视图相反：这里的 filePath 是 `.store` 里的真实文件，导出/复制/分析都能照常做，
 * 唯独"删除"的含义不同——删的是下载缓存，歌单里的这一首不会消失。
 *
 * 传输动作一律降级为**复制**：`.store` 里那份是网易云的下载缓存，移动会把它从缓存目录
 * 搬走（紧接着「已下载」列表就多一条指不到文件的幽灵行），而草案 9.6 的约定是
 * 网易云来源只复制、不移动。
 */
const COPY_ONLY_MENU_REWRITE: Record<string, string> = {
  'library.moveToFilter': 'library.copyToFilter',
  'library.moveToCurated': 'library.copyToCurated'
}

export const createNeteaseDownloadedMenuArr = (songListUUID: string): IMenu[][] => {
  const groups = createDefaultMenuArr(songListUUID)
    .map((group) =>
      group
        .filter((item) => item.menuName !== 'tracks.deleteAllAbove')
        .map((item) => {
          if (item.menuName === 'tracks.deleteTracks') {
            return { ...item, menuName: 'netease.removeLocalFile' }
          }
          const copyName = COPY_ONLY_MENU_REWRITE[item.menuName]
          return copyName ? { ...item, menuName: copyName } : item
        })
    )
    .filter((group) => group.length > 0)
  // 「重新下载」放在删除旁边：这两件事用户是连着想的（删了重下、或换了音质重下）
  const removeIndex = groups.findIndex((group) =>
    group.some((item) => item.menuName === 'netease.removeLocalFile')
  )
  groups.splice(removeIndex >= 0 ? removeIndex + 1 : groups.length, 0, [
    { menuName: 'netease.redownload' }
  ])
  return groups
}
