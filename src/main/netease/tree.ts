import { getLibraryDb } from '../libraryDb'
import { getNeteaseRootDir } from './paths'
import { getLoggedInUserId } from './session'
import {
  NETEASE_GROUP_PREFIX,
  NETEASE_PLAYLIST_PREFIX,
  getNeteasePlaylistId
} from '@shared/netease'
import type { NeteaseTreeGroup } from './library'

/**
 * 把网易云虚拟子树挂到 `getLibrary()` 的返回值上。
 *
 * 为什么不写进 `library_nodes`：那张表是真值表，后台 `pruneMissingLibraryNodes`
 * 会按磁盘校验并删掉"目录不存在"的节点。网易云的歌单没有磁盘目录，
 * 写进去必然被下一次对账清掉。所以在返回前注入，磁盘对账永远看不到它们。
 *
 * uuid 约定（渲染层按前缀识别，不查库）：
 *   netease:group:<kind>   → 分组节点（我喜欢的音乐 / 创建的歌单 / 收藏的歌单 / 收藏的专辑）
 *   netease:pl:<id>        → 歌单节点（当作 songList 处理）
 */

export const NETEASE_UUID_PREFIX = 'netease:'
export const NETEASE_TREE_PLAYLIST_PREFIX = NETEASE_PLAYLIST_PREFIX

type TreeNode = {
  uuid: string
  type: string
  dirName: string
  children?: TreeNode[]
  order?: number | null
  /** 渲染层曲目数徽标直接读它：虚拟节点没有磁盘目录，扫不出来 */
  trackCount?: number
}

export function getNeteaseGroupsFromDb(): NeteaseTreeGroup[] {
  const db = getLibraryDb()
  if (!db) return []
  const listRoot = (() => {
    try {
      return getNeteaseRootDir()
    } catch {
      return ''
    }
  })()
  if (!listRoot) return []

  // 只显示当前登录账号的歌单。
  //
  // 换账号时旧账号的歌单行会被保留（曲目关系是跨账号的事实，删了会把已下载文件
  // 误判成孤儿），但树上必须跟 session 里的 user_id 走：未登录不注入子树；
  // 已登录却还没同步完时，宁可暂时为空，也不能露出上一个账号。
  const userId = getLoggedInUserId()
  if (!userId) return []

  const rows = db
    .prepare<{
      playlist_id: string
      kind: string
      title: string
      cover_url: string
      track_count: number
      sort_index: number
    }>(
      `SELECT playlist_id, kind, title, cover_url, track_count, sort_index
         FROM netease_playlist
        WHERE list_root = ?
          AND user_id = ?
        ORDER BY sort_index ASC`
    )
    .all(listRoot, userId)

  const groups: NeteaseTreeGroup[] = []
  const push = (id: string, title: string, kinds: string[]) => {
    const items = rows
      .filter((row) => kinds.includes(row.kind))
      .map((row) => ({
        playlistId: String(row.playlist_id),
        title: String(row.title || ''),
        trackCount: Number(row.track_count) || 0,
        coverUrl: String(row.cover_url || '')
      }))
    if (items.length) groups.push({ id, title, items })
  }
  push('liked', '我喜欢的音乐', ['liked'])
  push('created', '创建的歌单', ['created'])
  push('subscribed', '收藏的歌单', ['subscribed'])
  push('album', '收藏的专辑', ['album'])
  return groups
}

export function getPlaylistIdFromUuid(uuid: string): string {
  return getNeteasePlaylistId(uuid)
}

/**
 * 找到树里的 NeteaseLibrary 节点并补上虚拟子节点。
 * 未登录 / 未同步过时子节点为空——节点本身照常显示，点它触发登录。
 */
export function attachNeteaseSubtree(root: TreeNode | null): void {
  if (!root) return
  const libraryNode = findLibraryNode(root)
  if (!libraryNode) return

  const groups = getNeteaseGroupsFromDb()
  const children: TreeNode[] = []
  let order = 0
  for (const group of groups) {
    if (group.id === 'liked' && group.items.length === 1) {
      // "我喜欢的音乐"只有一个歌单节点，直接挂一级，不套分组
      children.push({
        uuid: `${NETEASE_TREE_PLAYLIST_PREFIX}${group.items[0].playlistId}`,
        type: 'songList',
        // 标题由 getNeteaseGroupsFromDb 给，别在这里再写一份字面量：两处一旦不同就会飘
        dirName: group.title,
        order: order++,
        trackCount: group.items[0].trackCount
      })
      continue
    }
    const groupNode: TreeNode = {
      uuid: `${NETEASE_GROUP_PREFIX}${group.id}`,
      type: 'dir',
      dirName: group.title,
      order: order++,
      children: group.items.map((item, index) => ({
        uuid: `${NETEASE_TREE_PLAYLIST_PREFIX}${item.playlistId}`,
        type: 'songList',
        dirName: item.title,
        order: index,
        trackCount: item.trackCount
      }))
    }
    children.push(groupNode)
  }
  libraryNode.children = children
}

function findLibraryNode(root: TreeNode): TreeNode | null {
  const queue: TreeNode[] = [root]
  while (queue.length) {
    const node = queue.shift() as TreeNode
    if (node.type === 'library' && /NeteaseLibrary|网易云音乐/.test(node.dirName)) return node
    for (const child of node.children || []) queue.push(child)
  }
  return null
}
