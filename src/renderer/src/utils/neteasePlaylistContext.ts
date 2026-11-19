import type { IDir } from '../../../types/globals'
import {
  NETEASE_GROUP_PREFIX,
  canDeleteNeteasePlaylist as canDeleteNeteasePlaylistKind,
  canEditNeteasePlaylistTracks,
  getNeteasePlaylistDeletionAction as getNeteasePlaylistDeletionActionByKind,
  getNeteasePlaylistId,
  isNeteaseGroupUuid,
  isNeteasePlaylistUuid,
  type NeteasePlaylistDeletionAction
} from '@shared/netease'
import { findNeteaseLibraryNode } from '@renderer/utils/neteaseSongs'

export type NeteasePlaylistContext = {
  playlistId: string
  kind: string
  title: string
}

/**
 * 从当前曲库树里找出这张网易云歌单的类型和标题。
 * 「我喜欢的音乐」会挂在网易云库根下；自建 / 收藏 / 专辑在对应分组里。
 */
export function findNeteasePlaylistContext(
  root: IDir | null | undefined,
  uuid: string | null | undefined
): NeteasePlaylistContext | null {
  if (!isNeteasePlaylistUuid(uuid)) return null
  const libraryNode = findNeteaseLibraryNode(root)
  if (!libraryNode) return null
  const playlistId = getNeteasePlaylistId(String(uuid))
  if (!playlistId) return null

  for (const child of libraryNode.children || []) {
    if (child.uuid === uuid) {
      return {
        playlistId,
        kind: 'liked',
        title: String(child.dirName || '')
      }
    }
    if (!isNeteaseGroupUuid(child.uuid)) continue
    const kind = String(child.uuid).slice(NETEASE_GROUP_PREFIX.length)
    for (const item of child.children || []) {
      if (item.uuid !== uuid) continue
      return {
        playlistId,
        kind,
        title: String(item.dirName || '')
      }
    }
  }
  return null
}

export function canRemoveTracksFromNeteasePlaylist(
  root: IDir | null | undefined,
  uuid: string | null | undefined
): boolean {
  return canEditNeteasePlaylistTracks(findNeteasePlaylistContext(root, uuid)?.kind)
}

export function canDeleteNeteasePlaylist(
  root: IDir | null | undefined,
  uuid: string | null | undefined
): boolean {
  return canDeleteNeteasePlaylistKind(findNeteasePlaylistContext(root, uuid)?.kind)
}

export function getNeteasePlaylistDeletionAction(
  root: IDir | null | undefined,
  uuid: string | null | undefined
): NeteasePlaylistDeletionAction | null {
  return getNeteasePlaylistDeletionActionByKind(findNeteasePlaylistContext(root, uuid)?.kind)
}
