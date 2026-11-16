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
 * 这一行的 filePath 是 `frkb-preview://` 流地址，磁盘上**没有**这个文件。
 * 菜单主体与普通曲目一致，但落地前会先把流地址换成 `.store/` 里的真实文件。
 * 去掉的项：
 *   - 在文件夹中显示：没有文件可显示；
 *   - 删除曲目 / 删除上方全部：删的是网易云歌单结构，不是本地缓存；
 *   - Rekordbox XML 导出：它只认筛选/精选/SET 这几个核心库，且带移动语义；
 *   - 元数据编辑 / 自动补全 / 指纹 / 转码：元数据权威在网易云 API，`.store` 不是曲库歌曲；
 *   - 修 BPM：要求真实曲库节点，网易云是虚拟节点。
 * 传输动作一律是**复制**：网易云来源只复制不移动（草案 9.6）。
 * 「下载到本地 / 删除本地文件」代替默认菜单里的删除项。
 */
export const createNeteaseStreamMenuArr = (downloaded: boolean): IMenu[][] => {
  const localActions: IMenu[] = downloaded
    ? [{ menuName: 'netease.removeLocalFile' }]
    : [{ menuName: 'netease.downloadToLocal' }]
  return [
    [{ menuName: 'tracks.exportTracks' }],
    [
      { menuName: 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks' },
      { menuName: 'library.writeToSeratoPlaylist' },
      { menuName: 'library.writeToTraktorPlaylist' }
    ],
    [
      ...createFilterCuratedTransferMenus('copy'),
      { menuName: 'library.addToSet' },
      { menuName: 'library.addToMixtape' }
    ],
    localActions,
    createMusicSearchMenuItems(),
    [{ menuName: 'similarTracks.menu' }],
    [{ menuName: 'stemSeparation.menu' }]
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

/**
 * 网易云不提供元数据编辑：元数据权威在网易云 API，本地改 `.store` 标签既不会显示，
 * 导入命名也读的是 `netease_track`，还允许把 `<songId>.ext` 改名而破坏下载索引。
 */
const NETEASE_HIDDEN_MENU_NAMES = new Set([
  'tracks.deleteAllAbove',
  // Rekordbox XML 导出只认筛选/精选/SET 这几个核心库，网易云是虚拟节点。
  'rekordboxXmlExport.menuExportSelectedTracks',
  // 直接暴露 `.store` 会让用户绕过索引改名或删文件。
  'tracks.showInFileExplorer',
  'metadata.autoFillMenu',
  'tracks.editMetadata',
  'tracks.convertFormat',
  'fingerprints.analyzeAndAdd',
  // 网易云行不展示分析结果，清缓存没有意义，还会顺带删掉分轨。
  'tracks.clearTrackCache',
  // 修 BPM 要求真实的曲库节点（uuid + 路径 + nodeType），网易云下载视图是虚拟节点。
  'bpmFix.menu'
])

export const createNeteaseDownloadedMenuArr = (songListUUID: string): IMenu[][] => {
  const groups = createDefaultMenuArr(songListUUID)
    .map((group) =>
      group
        .filter((item) => !NETEASE_HIDDEN_MENU_NAMES.has(item.menuName))
        .map((item) => {
          if (item.menuName === 'tracks.deleteTracks') {
            return { ...item, menuName: 'netease.removeLocalFile' }
          }
          const copyName = COPY_ONLY_MENU_REWRITE[item.menuName]
          return copyName ? { ...item, menuName: copyName } : item
        })
    )
    .filter((group) => group.length > 0)
  return groups
}
