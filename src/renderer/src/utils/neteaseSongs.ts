import type { IDir, ISongInfo } from '../../../types/globals'
import {
  NETEASE_DOWNLOADED_UUID,
  NETEASE_GROUP_PREFIX,
  NETEASE_LIBRARY_NAME,
  NETEASE_PLAYLIST_PREFIX,
  buildNeteasePreviewUrl,
  getNeteasePlaylistId,
  isNeteaseGroupUuid,
  isNeteaseNodeUuid,
  isNeteasePlaylistUuid,
  isNeteasePendingPath,
  isNeteasePreviewUrl,
  parseNeteasePendingSongId,
  parseNeteaseSongId
} from '@shared/netease'
import { t } from '@renderer/utils/translate'

/**
 * 网易云库在渲染层的约定。
 *
 * 歌单节点是虚拟的（磁盘上没有目录），uuid 用前缀区分，不查库：
 *   netease:group:<kind>  分组
 *   netease:pl:<id>       歌单
 *
 * 曲目的 filePath 直接写成 frkb-preview URL，播放器不需要知道网易云的存在——
 * 对它来说这就是一个普通音频源，主进程负责流式或读本地文件。
 */

export {
  NETEASE_DOWNLOADED_UUID,
  NETEASE_GROUP_PREFIX,
  NETEASE_LIBRARY_NAME,
  NETEASE_PLAYLIST_PREFIX,
  buildNeteasePreviewUrl,
  getNeteasePlaylistId,
  isNeteaseGroupUuid,
  isNeteaseNodeUuid,
  isNeteasePlaylistUuid,
  isNeteasePendingPath,
  isNeteasePreviewUrl,
  parseNeteasePendingSongId,
  parseNeteaseSongId
}

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round((Number(durationMs) || 0) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export type NeteaseTrackPayload = {
  songId: string
  title: string
  artist: string
  album: string
  durationMs: number
  coverUrl: string
  position: number
  downloaded?: boolean
}

/**
 * 网易云曲目 → 列表行。
 *
 * 注意几个刻意的空值：码率、容器、评级这类信息只有本地文件才有，
 * 这里一律留空而不是造假——列表按"列缺失就隐藏/留空"的既有规则处理。
 */
export function mapNeteaseTrackToSongInfo(track: NeteaseTrackPayload): ISongInfo {
  const displayName =
    track.artist && track.title ? `${track.artist} - ${track.title}` : track.title || track.songId
  return {
    filePath: buildNeteasePreviewUrl(track.songId),
    fileName: displayName,
    fileFormat: '',
    cover: null,
    title: track.title || displayName,
    artist: track.artist || undefined,
    album: track.album || undefined,
    duration: formatDuration(track.durationMs),
    genre: undefined,
    label: undefined,
    bitrate: undefined,
    container: undefined,
    playlistTrackNumber: track.position + 1,
    neteaseSongId: track.songId,
    neteaseDownloaded: track.downloaded === true,
    addedAtMs: undefined
  }
}

/**
 * 这一行是不是「盘上没有文件、只有试听流」的网易云曲目。
 *
 * 判据只看 filePath，不看 `neteaseDownloaded`：歌单视图里的行即使已经下载过，
 * filePath 仍然是 frkb-preview 流地址；只有「查看已下载」视图才把真实路径写进去。
 * 所以凡是需要「拿一个真实文件去干活」的操作（导出、移动到别的库、复制、删除、
 * 在资源管理器里显示）都要先用它挡掉，否则会把一个 URL 或待下载占位路径送进文件系统。
 * SET 里尚未下完的条目（`netease-pending:`）同样没有本地文件，也按这一类处理。
 */
export function isNeteaseStreamSong(song: ISongInfo | null | undefined): boolean {
  const filePath = String(song?.filePath || '')
  return (
    isNeteasePreviewUrl(filePath) ||
    isNeteasePendingPath(filePath) ||
    Boolean(song?.neteasePendingDownload)
  )
}

export type NeteaseDownloadedRowPayload = {
  songId: string
  title: string
  artist: string
  album: string
  durationMs: number
  absPath: string
  bitDepth: number
  sampleRate: number
  sizeBytes: number
  inPlaylist: boolean
}

/**
 * 「查看已下载」的行。
 *
 * 与歌单视图的唯一区别：filePath 是**真实路径**（`.store/xxx.flac`），
 * 所以播放、导出、复制到别的库、在资源管理器里显示全都按普通本地文件走，
 * 不需要为这个视图单开一套行为。fileFormat/bitrate 也从文件本身算，
 * 因为这几首确实有文件可读。
 */
export function mapNeteaseDownloadedRowToSongInfo(row: NeteaseDownloadedRowPayload): ISongInfo {
  const displayName =
    row.artist && row.title ? `${row.artist} - ${row.title}` : row.title || row.songId
  const ext = String(row.absPath || '')
    .split('.')
    .pop()
  // 用文件体积和时长算平均码率。不要用 位深×采样率×2：那是未压缩立体声 PCM，
  // 对 FLAC/MP3 会高一个数量级，而且还写死了双声道。
  const bitrate =
    row.sizeBytes > 0 && row.durationMs > 0
      ? Math.round((row.sizeBytes * 8) / row.durationMs)
      : undefined
  return {
    filePath: String(row.absPath || ''),
    fileName:
      String(row.absPath || '')
        .split(/[/\\]/)
        .pop() || displayName,
    fileFormat: ext ? ext.toUpperCase() : '',
    cover: null,
    title: row.title || displayName,
    artist: row.artist || undefined,
    album: row.album || undefined,
    duration: formatDuration(row.durationMs),
    genre: undefined,
    label: undefined,
    bitrate,
    container: ext ? ext.toUpperCase() : undefined,
    neteaseSongId: row.songId,
    neteaseDownloaded: true
  }
}

type NeteaseGroupPayload = {
  id: string
  title: string
  items: Array<{ playlistId: string; title: string; trackCount: number; coverUrl: string }>
}

/** 歌单曲目数：0 也是有意义的值，只把非数值挡成 undefined，避免树上出现 NaN */
const toTrackCount = (value: unknown): number | undefined => {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : undefined
}

/**
 * 登录/同步成功后，把服务器返回的分组结构贴到树里的 NeteaseLibrary 节点上。
 *
 * 不走整树重载：整树重载会重建所有节点的对象引用，导致展开状态与滚动位置丢失。
 */
/** 主进程给的分组标题是中文写死的，显示时按当前语言翻译 */
export function localizeNeteaseGroupTitle(id: string, fallback = ''): string {
  const key = `netease.groups.${id}`
  const translated = t(key)
  return translated && translated !== key ? translated : fallback || id
}

const LIKED_TITLE_FALLBACKS = new Set(['liked', '我喜欢的音乐', 'Liked songs'])

/**
 * 把树里网易云分组节点的标题换成当前语言。
 * 主进程注入子树时标题是中文，打开库、同步之后都要再走一遍。
 */
export function localizeNeteaseTreeTitles(root: IDir | null | undefined): void {
  const libraryNode = findNeteaseLibraryNode(root)
  if (!libraryNode?.children) return
  for (const child of libraryNode.children) {
    if (isNeteaseGroupUuid(child.uuid)) {
      const id = String(child.uuid).slice(NETEASE_GROUP_PREFIX.length)
      child.dirName = localizeNeteaseGroupTitle(id, String(child.dirName || ''))
      continue
    }
    // 「我喜欢的音乐」被提到一级，uuid 是歌单而不是分组，只能靠标题识别
    if (
      isNeteasePlaylistUuid(child.uuid) &&
      LIKED_TITLE_FALLBACKS.has(String(child.dirName || ''))
    ) {
      child.dirName = localizeNeteaseGroupTitle('liked', String(child.dirName || ''))
    }
  }
}

export function applyNeteaseGroupsToTree(
  root: IDir | null,
  groups: NeteaseGroupPayload[]
): boolean {
  const libraryNode = findNeteaseLibraryNode(root)
  if (!libraryNode) return false
  const children: IDir[] = []
  let order = 0
  for (const group of groups) {
    if (group.id === 'liked' && group.items.length === 1) {
      children.push({
        uuid: `${NETEASE_PLAYLIST_PREFIX}${group.items[0].playlistId}`,
        type: 'songList',
        dirName: localizeNeteaseGroupTitle('liked', group.title || group.items[0].title),
        order: order++,
        trackCount: toTrackCount(group.items[0].trackCount)
      })
      continue
    }
    children.push({
      uuid: `${NETEASE_GROUP_PREFIX}${group.id}`,
      type: 'dir',
      dirName: localizeNeteaseGroupTitle(group.id, group.title),
      order: order++,
      children: group.items.map((item, index) => ({
        uuid: `${NETEASE_PLAYLIST_PREFIX}${item.playlistId}`,
        type: 'songList' as const,
        dirName: item.title,
        order: index,
        trackCount: toTrackCount(item.trackCount)
      }))
    })
  }
  libraryNode.children = children
  return true
}

export function findNeteaseLibraryNode(root: IDir | null | undefined): IDir | null {
  if (!root) return null
  const queue: IDir[] = [root]
  while (queue.length) {
    const node = queue.shift() as IDir
    if (node.type === 'library' && /NeteaseLibrary|网易云音乐/.test(String(node.dirName || ''))) {
      return node
    }
    for (const child of node.children || []) queue.push(child)
  }
  return null
}
