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
 *   - 在文件夹中显示：仅已下载曲目显示，定位 `.store` 里的具体文件，不为了显示去下载；
 *   - 重新分析曲目：仅已下载曲目显示，解析已有的 `.store` 文件，不为了分析去下载；
 *   - 删除曲目 / 删除上方全部：不绑 Delete；自建歌单和「我喜欢的音乐」另有「从歌单中移除」；
 *   - 元数据编辑 / 自动补全 / 指纹：元数据权威在网易云 API，导入本地库会走正式导入流程。
 * 转码、修 BPM、Rekordbox XML：先让用户确认存放位置，取消则不下载体；生成的是新文件，不覆盖 `.store`。
 * 传输动作一律是**复制**：网易云来源只复制不移动（草案 9.6）。
 * 「下载到本地 / 删除本地文件」代替默认菜单里的删除项。
 */
export const createNeteaseStreamMenuArr = (
  downloaded: boolean,
  options?: { canRemoveFromPlaylist?: boolean }
): IMenu[][] => {
  const localActions: IMenu[] = downloaded
    ? [{ menuName: 'netease.removeLocalFile' }]
    : [{ menuName: 'netease.downloadToLocal' }]
  return [
    [{ menuName: 'tracks.exportTracks' }],
    [
      { menuName: 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks' },
      { menuName: 'rekordboxXmlExport.menuExportSelectedTracks' },
      { menuName: 'library.writeToSeratoPlaylist' },
      { menuName: 'library.writeToTraktorPlaylist' }
    ],
    [
      ...createFilterCuratedTransferMenus('copy'),
      { menuName: 'library.addToSet' },
      { menuName: 'library.addToMixtape' }
    ],
    localActions,
    ...(options?.canRemoveFromPlaylist
      ? [[{ menuName: 'netease.removeFromPlaylist', shortcutKey: 'Delete' }]]
      : []),
    ...(downloaded ? [[{ menuName: 'tracks.showInFileExplorer' }]] : []),
    createMusicSearchMenuItems(),
    [{ menuName: 'similarTracks.menu' }],
    [{ menuName: 'tracks.convertFormat' }],
    ...(downloaded ? [[{ menuName: 'tracks.clearTrackCache' }]] : []),
    [{ menuName: 'stemSeparation.menu' }, { menuName: 'bpmFix.menu' }]
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
  [{ menuName: 'rekordboxXmlExport.menuExportSelectedTracks' }],
  [{ menuName: 'netease.downloadToLocal' }],
  [{ menuName: 'library.removeFromSet' }],
  createMusicSearchMenuItems(),
  [{ menuName: 'tracks.convertFormat' }],
  [{ menuName: 'bpmFix.menu' }]
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
  'metadata.autoFillMenu',
  'tracks.editMetadata',
  'fingerprints.analyzeAndAdd'
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
