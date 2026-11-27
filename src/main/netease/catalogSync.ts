import { log } from '../log'
import type { SqliteDatabase } from '../libraryDb'
import { neteaseClient, type NeteasePlaylist } from './client'
import { NeteaseApiError } from './errors'
import { ensureNeteaseDirs } from './paths'
import { getListRoot, requireDb } from './library'
import { getLoggedInUserId } from './session'

/**
 * 网易云目录同步。
 *
 * 与 library.ts（本地查询/下载）拆开的边界：这里只负责"从云端拉目录并落库"，
 * 不碰文件系统与下载。
 */

export type NeteasePlaylistSyncState = 'ok' | 'unreadable'

export type NeteaseTreeGroup = {
  id: string
  title: string
  items: Array<{
    playlistId: string
    title: string
    trackCount: number
    coverUrl: string
    syncState: NeteasePlaylistSyncState
  }>
}

export type CatalogSyncResult = {
  account: { userId: string; nickname: string; avatarUrl: string; vipType: number }
  groups: NeteaseTreeGroup[]
  /** 本次同步因隐私/无权限被跳过的歌单；渲染层据此给出汇总提示 */
  skipped: Array<{ playlistId: string; title: string }>
  playlistCount: number
  trackCount: number
  syncedAtMs: number
}

export type CatalogSyncOptions = {
  /** 歌单列表一到就回调，不用等曲目 id / 曲目详情全部拉完 */
  onGroupsReady?: (groups: NeteaseTreeGroup[]) => void
}

/**
 * 拉一次完整目录并落库。
 * 歌单的曲目 id 顺序按 trackIds 原样保存——这是"只按原始顺序显示"的依据。
 *
 * `[netease-diag]` 是为排查用户侧"歌单全部为空 / 自建歌单不可读"保留的低频诊断，
 * 每次同步只输出汇总和异常项；问题收敛后按前缀统一删除。
 */
export async function syncCatalog(options: CatalogSyncOptions = {}): Promise<CatalogSyncResult> {
  const startedAt = Date.now()
  const account = await neteaseClient.fetchAccount()
  if (!account) {
    log.warn(
      `[netease-diag] 同步中止：登录态无效 hasMUSIC_U=${neteaseClient.hasCookie('MUSIC_U')} cachedUserId=${getLoggedInUserId() || '(空)'}`
    )
    throw new Error('登录态无效，请重新扫码登录')
  }

  await ensureNeteaseDirs()
  const listRoot = getListRoot()
  const db = requireDb()
  const userId = account.userId

  const playlists = await neteaseClient.listPlaylists(userId)
  const albums = await neteaseClient.listAlbums()
  const all: NeteasePlaylist[] = [...playlists, ...albums]
  const kindCounts = all.reduce<Record<string, number>>((acc, row) => {
    acc[row.kind] = (acc[row.kind] || 0) + 1
    return acc
  }, {})
  log.info(
    `[netease-diag] 同步目录 userId=${userId} nickname=${account.nickname} 歌单=${playlists.length} 专辑=${albums.length} 分类=${JSON.stringify(kindCounts)}`
  )
  if (all.length === 0) {
    log.warn(`[netease-diag] 账号没有返回任何歌单或专辑 userId=${userId}，请核对当前登录账号`)
  }

  const insertPlaylist = db.prepare(
    `INSERT OR REPLACE INTO netease_playlist
       (list_root, user_id, playlist_id, kind, title, cover_url, track_count, sort_index, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  /**
   * 只删**当前账号**的歌单行。
   *
   * 不能按 list_root 清表：`netease_playlist_item` 没有 user_id（歌单 id 全局唯一，
   * 一首歌是否"还在某个歌单里"是跨账号的事实），所以另一账号的歌单行一旦被抹掉，
   * 它的曲目关系就会被孤儿判定当成"已不在歌单"，用户点一次清理就把别人的缓存删了。
   */
  const deletePlaylistsOfUser = db.prepare(
    `DELETE FROM netease_playlist WHERE list_root = ? AND user_id = ?`
  )
  const selectPlaylistIdsOfUser = db.prepare<{ playlist_id: string }>(
    `SELECT playlist_id FROM netease_playlist WHERE list_root = ? AND user_id = ?`
  )
  const deleteItemsOfPlaylist = db.prepare(
    `DELETE FROM netease_playlist_item WHERE list_root = ? AND playlist_id = ?`
  )
  /**
   * 回收「本账号已经没有这张歌单了」的曲目关系。
   *
   * 需要再挡一次"别的账号还有这张歌单"：两个账号收藏同一张歌单时，曲目关系是共用的一份，
   * 一个账号取消收藏不能把另一个账号的也清掉（那会让已下载文件被判成孤儿）。
   */
  const deleteItemsOfPlaylistIfUnclaimed = db.prepare(
    `DELETE FROM netease_playlist_item
      WHERE list_root = ? AND playlist_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM netease_playlist
           WHERE list_root = ? AND playlist_id = ?
        )`
  )
  const countItemsOfPlaylist = db.prepare<{ n: number }>(
    `SELECT COUNT(*) AS n FROM netease_playlist_item WHERE list_root = ? AND playlist_id = ?`
  )
  const selectPlaylistSyncStatesOfUser = db.prepare<{ playlist_id: string; sync_state: string }>(
    `SELECT playlist_id, sync_state FROM netease_playlist WHERE list_root = ? AND user_id = ?`
  )
  const insertItem = db.prepare(
    `INSERT OR REPLACE INTO netease_playlist_item (list_root, playlist_id, song_id, position)
     VALUES (?, ?, ?, ?)`
  )
  const insertAccount = db.prepare(
    `INSERT OR REPLACE INTO netease_account
       (list_root, user_id, nickname, avatar_url, vip_type, last_sync_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  // 先把歌单标题写进库并通知渲染层画树。
  // 曲目关系仍等全部拉完再一次性落库，避免半截写入触发孤儿清理。
  const serverCounts = new Map(all.map((item) => [item.playlistId, item.trackCount]))
  // 第一段先沿用上次的 sync_state：中途若整次中止（非隐私类错误），不能让此前读不了的歌单被重置成 ok
  const previousUnreadable = new Set(
    selectPlaylistSyncStatesOfUser
      .all(listRoot, userId)
      .filter((row) => String(row.sync_state) === 'unreadable')
      .map((row) => String(row.playlist_id))
  )
  db.transaction(() => {
    insertAccount.run(
      listRoot,
      userId,
      account.nickname,
      account.avatarUrl,
      account.vipType,
      Date.now()
    )
    for (let index = 0; index < all.length; index += 1) {
      const item = all[index]
      insertPlaylist.run(
        listRoot,
        userId,
        item.playlistId,
        item.kind,
        item.title,
        item.coverUrl,
        item.trackCount,
        index,
        previousUnreadable.has(item.playlistId) ? 'unreadable' : 'ok'
      )
    }
  })()
  options.onGroupsReady?.(buildGroups(all, serverCounts, previousUnreadable))

  // 先把所有歌单的曲目 id 拉全再落库。
  //
  // 不能边拉边写：删旧数据的那一步一旦执行、后面的网络请求又中断，库里就只剩前几个歌单的
  // 曲目，「已下载」的孤儿判定（"没有任何歌单里有它"）会把这些歌全算成孤儿，
  // 用户一点清理就把缓存删了。
  //
  // 拉取失败分两种，处理方式必须不同：
  //   - 明确取不到（歌单被删 / 转私密 / 无权限 / 403）：跳过这张，**保留它上次的曲目关系**；
  //   - 其他（超时、429、解析失败）：整次中止，一个字节都不写。
  // 用一张"看起来空了"的歌单去覆盖旧数据，就是往孤儿判定里递刀。
  const itemsByPlaylist = new Map<string, string[]>()
  const pendingSongIds = new Set<string>()
  const unreadableIds = new Set<string>()
  const skipped: Array<{ playlistId: string; title: string }> = []
  let trackCount = 0
  let countMismatches = 0
  for (const item of all) {
    try {
      const ids =
        item.kind === 'album'
          ? await neteaseClient.albumTrackIds(item.playlistId)
          : await neteaseClient.playlistTrackIds(item.playlistId)
      itemsByPlaylist.set(item.playlistId, ids)
      for (const id of ids) pendingSongIds.add(id)
      trackCount += ids.length
      if (ids.length !== item.trackCount) countMismatches += 1
      if (ids.length === 0 && item.trackCount > 0) {
        log.warn(
          `[netease-diag] 歌单明细为空但服务器计数为 ${item.trackCount}（id=${item.playlistId} kind=${item.kind} title=「${item.title}」），将按空歌单落库`
        )
      }
    } catch (error) {
      if (error instanceof NeteaseApiError && (error.unavailable || error.noPermission)) {
        // 一张读不了的歌单不能拖垮整次同步：否则后面的歌单一条曲目都写不进去
        log.warn(
          `[netease] 歌单「${item.title}」不可读取（id=${item.playlistId} kind=${item.kind} serverCount=${item.trackCount} status=${error.status} code=${error.code}），保留上次的曲目关系`,
          error
        )
        unreadableIds.add(item.playlistId)
        skipped.push({ playlistId: item.playlistId, title: item.title })
        continue
      }
      log.warn(
        `[netease-diag] 歌单明细拉取失败，整次同步中止（id=${item.playlistId} kind=${item.kind} serverCount=${item.trackCount} status=${error instanceof NeteaseApiError ? error.status : '-'} code=${error instanceof NeteaseApiError ? error.code : '-'}）`,
        error
      )
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`同步中断：拉取歌单「${item.title}」失败（${message}）`, { cause: error })
    }
  }
  log.info(
    `[netease-diag] 明细拉取完成 成功=${itemsByPlaylist.size} 跳过=${skipped.length} 曲目=${trackCount} 与服务器计数不一致=${countMismatches}`
  )

  /** 落库时真正采用的曲目数（跳过拉取的歌单按库里的旧值算），树和库必须同源 */
  const resolvedCounts = new Map<string, number>()
  db.transaction(() => {
    // 本次同步前，这个账号有哪些歌单；用来精确算出"这次真的消失了的歌单"。
    // 不能用"不在 netease_playlist 里"来判断：另一账号的歌单还在表里，那样会误删它的曲目关系。
    const previousIds = new Set(
      selectPlaylistIdsOfUser.all(listRoot, userId).map((row) => String(row.playlist_id))
    )
    deletePlaylistsOfUser.run(listRoot, userId)
    insertAccount.run(
      listRoot,
      userId,
      account.nickname,
      account.avatarUrl,
      account.vipType,
      Date.now()
    )
    for (let index = 0; index < all.length; index += 1) {
      const item = all[index]
      const ids = itemsByPlaylist.get(item.playlistId)
      previousIds.delete(item.playlistId)
      let count: number
      if (ids) {
        deleteItemsOfPlaylist.run(listRoot, item.playlistId)
        for (let position = 0; position < ids.length; position += 1) {
          insertItem.run(listRoot, item.playlistId, ids[position], position)
        }
        // 数量以真正拿到的曲目 id 为准：服务器的 trackCount 含已下架曲目，
        // 拿它当徽标会和右侧列表的实际条数对不上。
        count = ids.length
      } else {
        // 被跳过的歌单：曲目关系还是上次那份，数量也跟着按库里的实际条数算。
        // 不能回退到服务器的 trackCount：库里没有曲目时徽标会和右侧列表（空的）对不上。
        const kept = countItemsOfPlaylist.get(listRoot, item.playlistId)
        count = Number(kept?.n) || 0
      }
      insertPlaylist.run(
        listRoot,
        userId,
        item.playlistId,
        item.kind,
        item.title,
        item.coverUrl,
        count,
        index,
        unreadableIds.has(item.playlistId) ? 'unreadable' : 'ok'
      )
      resolvedCounts.set(item.playlistId, count)
    }
    // 剩下的就是本账号这次真的没了（被删 / 取消收藏）的歌单，它们的曲目关系一起收掉。
    // 别的账号的歌单不在 previousIds 里，永远不会被这一段碰到；
    // 同一张歌单如果还被别的账号收藏着，则保留曲目关系（见 deleteItemsOfPlaylistIfUnclaimed）。
    for (const removedPlaylistId of previousIds) {
      deleteItemsOfPlaylistIfUnclaimed.run(listRoot, removedPlaylistId, listRoot, removedPlaylistId)
    }
  })()

  const groups = buildGroups(all, resolvedCounts, unreadableIds)
  options.onGroupsReady?.(groups)
  await upsertSongDetails(db, listRoot, Array.from(pendingSongIds))

  log.info(
    `[netease-diag] 同步完成 userId=${userId} 歌单=${all.length} 曲目=${trackCount} 不可读=${skipped.length} 耗时=${Date.now() - startedAt}ms`
  )
  return {
    account,
    groups,
    skipped,
    playlistCount: all.length,
    trackCount,
    syncedAtMs: Date.now()
  }
}

/** 拉曲目元数据并写库；调用方保证 songId 已去重 */
export async function upsertSongDetails(
  db: SqliteDatabase,
  listRoot: string,
  songIds: string[]
): Promise<void> {
  if (songIds.length === 0) return
  const details = await neteaseClient.songDetails(songIds)
  log.info(`[netease-diag] 曲目元数据 请求=${songIds.length} 返回=${details.size}`)
  const statement = db.prepare(
    `INSERT OR REPLACE INTO netease_track
       (list_root, song_id, title, artist, album, duration_ms, cover_url, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const now = Date.now()
  db.transaction(() => {
    for (const song of details.values()) {
      statement.run(
        listRoot,
        song.songId,
        song.title,
        song.artist,
        song.album,
        song.durationMs,
        song.coverUrl,
        now
      )
    }
  })()
}

function buildGroups(
  playlists: NeteasePlaylist[],
  countsByPlaylist: Map<string, number>,
  unreadableIds: Set<string>
): NeteaseTreeGroup[] {
  const toItems = (rows: NeteasePlaylist[]) =>
    rows.map((row) => ({
      playlistId: row.playlistId,
      title: row.title,
      // 与落库同源：以真正写进库的曲目数为准
      trackCount: countsByPlaylist.get(row.playlistId) ?? row.trackCount,
      coverUrl: row.coverUrl,
      syncState: unreadableIds.has(row.playlistId) ? ('unreadable' as const) : ('ok' as const)
    }))

  const groups: NeteaseTreeGroup[] = []
  const liked = playlists.filter((item) => item.kind === 'liked')
  if (liked.length) groups.push({ id: 'liked', title: '我喜欢的音乐', items: toItems(liked) })
  groups.push({
    id: 'created',
    title: '创建的歌单',
    items: toItems(playlists.filter((item) => item.kind === 'created'))
  })
  groups.push({
    id: 'subscribed',
    title: '收藏的歌单',
    items: toItems(playlists.filter((item) => item.kind === 'subscribed'))
  })
  const albums = playlists.filter((item) => item.kind === 'album')
  if (albums.length) groups.push({ id: 'album', title: '收藏的专辑', items: toItems(albums) })
  return groups
}
