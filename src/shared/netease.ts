/**
 * 网易云库的跨进程约定。
 *
 * 歌单节点是**虚拟**的：磁盘上没有对应目录，`library_nodes` 里也没有记录，
 * 它只存在于 `getLibrary()` 的返回值里（主进程注入、渲染层原样使用）。
 * 因此凡是要读盘的地方都必须先认出这些 uuid 并绕开。
 */

export const NETEASE_LIBRARY_NAME = 'NeteaseLibrary'

/** 歌单节点：netease:pl:<playlistId> */
export const NETEASE_PLAYLIST_PREFIX = 'netease:pl:'
/** 分组节点：netease:group:<liked|created|subscribed|album> */
export const NETEASE_GROUP_PREFIX = 'netease:group:'

/** 「查看已下载」虚拟列表：不在树里，只作为 songsArea 的一个列表 uuid 存在 */
export const NETEASE_DOWNLOADED_UUID = '__netease_downloaded__'

/** 试听地址前缀；播放器把它当普通音频 URL，主进程负责流式或读本地文件 */
export const NETEASE_PREVIEW_PREFIX = 'frkb-preview://?netease='

export function isNeteasePlaylistUuid(uuid: string | undefined | null): boolean {
  return typeof uuid === 'string' && uuid.startsWith(NETEASE_PLAYLIST_PREFIX)
}

export function isNeteaseGroupUuid(uuid: string | undefined | null): boolean {
  return typeof uuid === 'string' && uuid.startsWith(NETEASE_GROUP_PREFIX)
}

/** 树里任何一个网易云节点（分组或歌单） */
export function isNeteaseNodeUuid(uuid: string | undefined | null): boolean {
  return isNeteasePlaylistUuid(uuid) || isNeteaseGroupUuid(uuid)
}

export function getNeteasePlaylistId(uuid: string): string {
  return String(uuid || '').slice(NETEASE_PLAYLIST_PREFIX.length)
}

export function buildNeteasePreviewUrl(songId: string): string {
  return `${NETEASE_PREVIEW_PREFIX}${encodeURIComponent(String(songId))}`
}

export function isNeteasePreviewUrl(filePath: string | undefined | null): boolean {
  return typeof filePath === 'string' && filePath.startsWith(NETEASE_PREVIEW_PREFIX)
}

/** 从 frkb-preview URL 里取回 songId；不是网易云地址返回 null */
export function parseNeteaseSongId(filePath: string): string | null {
  if (!isNeteasePreviewUrl(filePath)) return null
  const match = String(filePath).match(/[?&]netease=([^&]+)/i)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/**
 * SET 里「待下载」条目的占位路径。
 *
 * 不含斜杠，Windows 的 path.normalize 不会把它拧成盘符路径；
 * 加载 SET 时必须在 stat 之前认出它，不能当成丢失的本地文件。
 */
export const NETEASE_PENDING_PATH_PREFIX = 'netease-pending:'

export function buildNeteasePendingPath(songId: string): string {
  return `${NETEASE_PENDING_PATH_PREFIX}${String(songId).trim()}`
}

export function isNeteasePendingPath(filePath: string | undefined | null): boolean {
  return typeof filePath === 'string' && filePath.startsWith(NETEASE_PENDING_PATH_PREFIX)
}

export function parseNeteasePendingSongId(filePath: string): string | null {
  if (!isNeteasePendingPath(filePath)) return null
  const id = filePath.slice(NETEASE_PENDING_PATH_PREFIX.length).trim()
  return id || null
}
