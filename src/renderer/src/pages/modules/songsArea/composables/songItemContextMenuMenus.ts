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
  'tracks.clearTrackCache'
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
    { menuName: 'rekordboxXmlExport.menuExportSelectedTracks' }
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
  [{ menuName: 'stemSeparation.menu' }]
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
  [{ menuName: 'stemSeparation.menu' }]
]

export const withoutRecordingAnalysisMenus = (groups: IMenu[][]): IMenu[][] =>
  groups
    .map((group) =>
      group.filter((item) => !RECORDING_LIBRARY_ANALYSIS_MENU_NAMES.has(item.menuName))
    )
    .filter((group) => group.length > 0)
