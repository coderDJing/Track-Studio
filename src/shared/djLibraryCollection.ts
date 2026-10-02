import type { IPioneerPlaylistTreeNode } from '../types/globals'

// Rekordbox playlist IDs come from the database; reserve an ID outside its 32-bit IDs.
export const REKORDBOX_COLLECTION_PLAYLIST_ID = Number.MAX_SAFE_INTEGER
export const EXTERNAL_COLLECTION_PLAYLIST_ID = 1

export const createDjLibraryCollectionNode = (id: number): IPioneerPlaylistTreeNode => ({
  id,
  parentId: 0,
  name: '全部曲目',
  isFolder: false,
  isAllTracks: true,
  order: 0,
  sortOrder: 0,
  children: []
})
