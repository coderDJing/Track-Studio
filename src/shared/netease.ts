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

/** 试听地址前缀；必须带 host，Chromium 把标准 scheme 当成 http 风格 URL，没有 host 的 frkb-preview://?netease= 播不出来 */
export const NETEASE_PREVIEW_PREFIX = 'frkb-preview://netease/?netease='

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

/** 没有对应磁盘目录的网易云 uuid：树上的分组/歌单，以及「查看已下载」虚拟列表 */
export function isNeteaseVirtualUuid(uuid: string | undefined | null): boolean {
  return isNeteaseNodeUuid(uuid) || uuid === NETEASE_DOWNLOADED_UUID
}

export function getNeteasePlaylistId(uuid: string): string {
  return String(uuid || '').slice(NETEASE_PLAYLIST_PREFIX.length)
}

export function buildNeteasePreviewUrl(songId: string): string {
  return `${NETEASE_PREVIEW_PREFIX}${encodeURIComponent(String(songId))}`
}

export function isNeteasePreviewUrl(filePath: string | undefined | null): boolean {
  if (typeof filePath !== 'string' || !filePath.startsWith('frkb-preview:')) return false
  if (filePath.startsWith(NETEASE_PREVIEW_PREFIX)) return true
  // 兼容旧地址 frkb-preview://?netease=<id>（没有 host，部分环境下播不出来）
  return /[?&]netease=/i.test(filePath)
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

/**
 * 从当前打开的网易云歌单移出曲目后，用来就地更新 songsArea 的事件载荷。
 *
 * 歌单视图里的 filePath 始终是 frkb-preview URL（即便已经下载过），
 * `songsArea/optimistic-remove` 也按 filePath 匹配，所以必须发同一套地址，
 * 打开中的列表才会立刻少掉这些行，而不必等用户重进歌单。
 */
export function createNeteaseOpenPlaylistRemovalPayload(
  playlistId: string,
  songIds: readonly string[]
): { listUUID: string; paths: string[] } {
  const id = String(playlistId || '').trim()
  const seen = new Set<string>()
  const paths: string[] = []
  for (const raw of songIds) {
    const songId = String(raw || '').trim()
    if (!songId || seen.has(songId)) continue
    seen.add(songId)
    paths.push(buildNeteasePreviewUrl(songId))
  }
  return {
    listUUID: id ? `${NETEASE_PLAYLIST_PREFIX}${id}` : '',
    paths
  }
}

/** 自己创建的歌单和「我喜欢的音乐」可以增删曲目；收藏的歌单和专辑不行。 */
export function canEditNeteasePlaylistTracks(kind: string | null | undefined): boolean {
  return kind === 'liked' || kind === 'created'
}

/** 自己创建的歌单可以删除；收藏的歌单和专辑是取消收藏。「我喜欢的音乐」不能删。 */
export function canDeleteNeteasePlaylist(kind: string | null | undefined): boolean {
  return kind === 'created' || kind === 'subscribed' || kind === 'album'
}

export type NeteasePlaylistDeletionAction = 'delete' | 'unsubscribe'

export function getNeteasePlaylistDeletionAction(
  kind: string | null | undefined
): NeteasePlaylistDeletionAction | null {
  if (kind === 'created') return 'delete'
  if (kind === 'subscribed' || kind === 'album') return 'unsubscribe'
  return null
}

/** 未设置时视为显示，避免老配置里缺字段时把图标藏掉。 */
export function isNeteaseLibraryIconVisible(
  setting: { showNeteaseLibraryIcon?: boolean } | null | undefined
): boolean {
  return setting?.showNeteaseLibraryIcon !== false
}

export function parseNeteaseSongIdFromStorePath(
  filePath: string | undefined | null
): string | null {
  const raw = String(filePath || '').trim()
  if (!raw) return null
  const normalized = raw.replace(/\\/g, '/')
  const marker = '/.store/'
  let rest = ''
  const index = normalized.lastIndexOf(marker)
  if (index >= 0) {
    rest = normalized.slice(index + marker.length)
  } else if (normalized.startsWith('.store/')) {
    rest = normalized.slice('.store/'.length)
  } else {
    return null
  }
  if (!rest || rest.includes('/')) return null
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return null
  const songId = rest.slice(0, dot).trim()
  if (!songId || songId === '.' || songId.includes('..')) return null
  return songId
}

export type NeteaseSongPathAliasInput = {
  filePath?: string | null
  neteaseLocalPath?: string | null
  neteaseSongId?: string | null
}

export function resolveNeteaseSongIdFromPathAliases(
  input: NeteaseSongPathAliasInput
): string | null {
  const direct = String(input.neteaseSongId || '').trim()
  if (direct) return direct
  return (
    parseNeteaseSongId(input.filePath || '') ||
    parseNeteasePendingSongId(input.filePath || '') ||
    parseNeteaseSongIdFromStorePath(input.filePath) ||
    parseNeteaseSongIdFromStorePath(input.neteaseLocalPath)
  )
}

export function collectNeteaseSongPathAliases(input: NeteaseSongPathAliasInput): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  const add = (value?: string | null) => {
    const next = String(value || '').trim()
    if (!next || seen.has(next)) return
    seen.add(next)
    aliases.push(next)
  }
  add(input.filePath)
  add(input.neteaseLocalPath)
  const songId = resolveNeteaseSongIdFromPathAliases(input)
  if (songId) {
    add(buildNeteasePreviewUrl(songId))
    add(buildNeteasePendingPath(songId))
  }
  return aliases
}

export function neteaseSongMatchesPath(
  song: NeteaseSongPathAliasInput | null | undefined,
  candidatePath: string | undefined | null,
  normalize: (value: string) => string = (value) => value
): boolean {
  if (!song) return false
  const needle = normalize(String(candidatePath || '').trim())
  if (!needle) return false
  for (const alias of collectNeteaseSongPathAliases(song)) {
    if (normalize(alias) === needle) return true
  }
  const candidateId =
    parseNeteaseSongId(candidatePath || '') ||
    parseNeteasePendingSongId(candidatePath || '') ||
    parseNeteaseSongIdFromStorePath(candidatePath)
  const songId = resolveNeteaseSongIdFromPathAliases(song)
  return Boolean(candidateId && songId && candidateId === songId)
}
