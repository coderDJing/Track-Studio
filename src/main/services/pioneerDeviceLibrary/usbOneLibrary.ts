import type { UsbLibraryMutation, UsbLibrarySnapshot } from './usbWriteModel'
import {
  assertUsbOneLibraryStagedCopy,
  openUsbOneLibraryDatabase,
  quoteUsbSqlIdentifier,
  requireUsbOneLibraryColumns,
  usbOneLibraryRows,
  usbOneLibrarySchema,
  validateUsbOneLibraryIntegrity,
  type UsbOneLibraryColumn,
  type UsbOneLibraryDatabase
} from './usbOneLibraryConnection'
import { replaceUsbOneLibraryCues } from './usbOneLibraryCues'
import {
  isUsbOneLibraryAnlzCueProfile,
  readUsbOneLibraryBankCueIds,
  readUsbOneLibraryDeletedBankCueIds
} from './usbOneLibraryCueProfile'

const baseColumns: Record<string, string[]> = {
  content: ['content_id', 'path', 'analysisDataFilePath', 'image_id'],
  image: ['image_id', 'path'],
  playlist: ['playlist_id', 'sequenceNo', 'name', 'attribute', 'playlist_id_parent'],
  playlist_content: ['playlist_id', 'content_id', 'sequenceNo'],
  property: ['numberOfContents']
}

function imageReferences(db: UsbOneLibraryDatabase, schema: Map<string, UsbOneLibraryColumn[]>) {
  const references: { table: string; column: string }[] = []
  for (const [table, columns] of schema) {
    if (table === 'image') continue
    const keys = usbOneLibraryRows(db, `PRAGMA foreign_key_list(${quoteUsbSqlIdentifier(table)})`)
    const names = new Set(
      columns.filter((column) => /^image_id(?:_|$)/i.test(column.name)).map((column) => column.name)
    )
    keys.filter((key) => key.table === 'image').forEach((key) => names.add(String(key.from)))
    names.forEach((column) => references.push({ table, column }))
  }
  return references
}

function protectedArtwork(
  db: UsbOneLibraryDatabase,
  schema: Map<string, UsbOneLibraryColumn[]>
): string[] {
  const paths = new Set<string>()
  for (const { table, column } of imageReferences(db, schema)) {
    if (table === 'content') continue
    usbOneLibraryRows(
      db,
      `SELECT DISTINCT i.path FROM image i INNER JOIN
      ${quoteUsbSqlIdentifier(table)} r ON r.${quoteUsbSqlIdentifier(column)} = i.image_id`
    ).forEach((row) => {
      if (typeof row.path === 'string' && row.path) paths.add(row.path)
    })
  }
  return [...paths].sort()
}

function pruneDeletedTrackArtwork(
  db: UsbOneLibraryDatabase,
  schema: Map<string, UsbOneLibraryColumn[]>,
  candidatePaths: Set<string>
): void {
  const pathKey = (value: unknown) =>
    String(value ?? '')
      .replace(/\\/g, '/')
      .toLowerCase()
  const references = imageReferences(db, schema)
  const candidates = usbOneLibraryRows(db, 'SELECT image_id, path FROM image').filter((row) =>
    candidatePaths.has(pathKey(row.path))
  )
  const checks = references.map(({ table, column }) =>
    db.prepare(
      `SELECT 1 AS used FROM ${quoteUsbSqlIdentifier(table)} WHERE ${quoteUsbSqlIdentifier(column)} = ? LIMIT 1`
    )
  )
  const remove = db.prepare('DELETE FROM image WHERE image_id = ?')
  for (const row of candidates) {
    if (checks.every((check) => !check.get(row.image_id))) remove.run(row.image_id)
  }
}

function validateReferences(
  db: UsbOneLibraryDatabase,
  schema: Map<string, UsbOneLibraryColumn[]>
): void {
  const references: [string, string, string, string][] = [
    ['cue', 'content_id', 'content', 'content_id'],
    ['history_content', 'content_id', 'content', 'content_id'],
    ['myTag_content', 'content_id', 'content', 'content_id'],
    ['recommendedLike', 'content_id_1', 'content', 'content_id'],
    ['recommendedLike', 'content_id_2', 'content', 'content_id'],
    ['hotCueBankList_cue', 'cue_id', 'cue', 'cue_id']
  ]
  for (const [table, column, target, key] of references) {
    if (!schema.has(table)) continue
    requireUsbOneLibraryColumns(schema, table, [column])
    requireUsbOneLibraryColumns(schema, target, [key])
    const orphans = db
      .prepare(
        `SELECT r.* FROM ${quoteUsbSqlIdentifier(table)} r
      LEFT JOIN ${quoteUsbSqlIdentifier(target)} t ON r.${quoteUsbSqlIdentifier(column)} = t.${quoteUsbSqlIdentifier(key)}
      WHERE r.${quoteUsbSqlIdentifier(column)} IS NOT NULL AND t.${quoteUsbSqlIdentifier(key)} IS NULL`
      )
      .all()
    const deletedBanks =
      table === 'cue' && orphans.length
        ? readUsbOneLibraryDeletedBankCueIds(db, schema)
        : new Set<number>()
    if (orphans.some((row) => !deletedBanks.has(Number(row.cue_id))))
      throw new Error(`OneLibrary 存在悬空引用: ${table}.${column}`)
  }
}

const integer = (value: unknown, label: string, allowZero = false): number => {
  const id = Number(value)
  if (!Number.isInteger(id) || id < (allowZero ? 0 : 1) || id > 0xffffffff) {
    throw new Error(`OneLibrary ${label} 无效`)
  }
  return id
}

function readSnapshot(db: UsbOneLibraryDatabase): UsbLibrarySnapshot {
  const schema = usbOneLibrarySchema(db)
  for (const [table, columns] of Object.entries(baseColumns)) {
    requireUsbOneLibraryColumns(schema, table, columns)
  }
  validateReferences(db, schema)
  // 从整个 content 表读取，不能依赖歌单成员，否则会遗漏“全部曲目”中的独立歌曲。
  const tracks = usbOneLibraryRows(
    db,
    `SELECT c.content_id, c.path, c.analysisDataFilePath,
    i.path AS artworkPath FROM content c LEFT JOIN image i ON i.image_id = c.image_id
    ORDER BY c.content_id`
  ).map((row) => ({
    id: integer(row.content_id, 'content_id'),
    filePath: String(row.path ?? ''),
    analyzePath: String(row.analysisDataFilePath ?? ''),
    artworkPath: String(row.artworkPath ?? '')
  }))
  const playlists = usbOneLibraryRows(
    db,
    'SELECT * FROM playlist ORDER BY sequenceNo, playlist_id'
  ).map((row) => {
    if (row.attribute !== 0 && row.attribute !== 1) {
      throw new Error('检测到未知 OneLibrary 歌单 attribute，拒绝修改')
    }
    return {
      id: integer(row.playlist_id, 'playlist_id'),
      parentId:
        row.playlist_id_parent == null
          ? 0
          : integer(row.playlist_id_parent, 'playlist_id_parent', true),
      name: String(row.name ?? ''),
      isFolder: row.attribute === 1
    }
  })
  const entries = usbOneLibraryRows(
    db,
    'SELECT * FROM playlist_content ORDER BY playlist_id, sequenceNo, content_id'
  ).map((row) => ({
    playlistId: integer(row.playlist_id, 'playlist_content.playlist_id'),
    trackId: integer(row.content_id, 'playlist_content.content_id'),
    entryIndex: integer(row.sequenceNo, 'playlist_content.sequenceNo', true)
  }))
  const trackIds = new Set(tracks.map((track) => track.id))
  const nodes = new Map(playlists.map((playlist) => [playlist.id, playlist]))
  if (
    entries.some(
      (entry) =>
        !trackIds.has(entry.trackId) ||
        !nodes.has(entry.playlistId) ||
        nodes.get(entry.playlistId)!.isFolder
    )
  ) {
    throw new Error('OneLibrary 含有悬空/文件夹歌单成员引用')
  }
  for (const playlist of playlists) {
    const seen = new Set<number>([playlist.id])
    let parent = playlist.parentId
    while (parent) {
      const node = nodes.get(parent)
      if (!node || !node.isFolder || seen.has(parent))
        throw new Error('OneLibrary 歌单树存在悬空、环或非文件夹父节点')
      seen.add(parent)
      parent = node.parentId
    }
  }
  const bankTracks =
    schema.has('hotCueBankList_cue') && schema.has('cue')
      ? usbOneLibraryRows(
          db,
          `SELECT DISTINCT q.content_id FROM hotCueBankList_cue r
      INNER JOIN cue q ON q.cue_id = r.cue_id
      INNER JOIN content c ON c.content_id = q.content_id`
        ).map((row) => Number(row.content_id))
      : []
  return {
    tracks,
    playlists,
    entries,
    protectedArtworkPaths: protectedArtwork(db, schema),
    ...(bankTracks.length ? { protectedTrackIds: bankTracks } : {})
  }
}

export function readUsbOneLibrarySnapshot(databasePath: string): UsbLibrarySnapshot {
  const db = openUsbOneLibraryDatabase(databasePath, true)
  try {
    validateUsbOneLibraryIntegrity(db)
    return readSnapshot(db)
  } finally {
    db.close()
  }
}

function uniqueIds(ids: number[], label: string): number[] {
  ids.forEach((id) => integer(id, label))
  if (new Set(ids).size !== ids.length) throw new Error(`${label} 存在重复 ID`)
  return ids
}

function orderedMembers(db: UsbOneLibraryDatabase, playlistId: number): number[] {
  const ids = usbOneLibraryRows(
    db,
    `SELECT content_id FROM playlist_content
    WHERE playlist_id = ? ORDER BY sequenceNo, content_id`,
    playlistId
  ).map((row) => Number(row.content_id))
  return uniqueIds(ids, '目标歌单成员')
}

function setMemberOrder(db: UsbOneLibraryDatabase, playlistId: number, ids: number[]): void {
  const current = orderedMembers(db, playlistId)
  if (current.length !== ids.length || current.some((id) => !ids.includes(id))) {
    throw new Error('排序必须包含目标歌单的全部成员，不能增加或丢失歌曲')
  }
  if (current.every((id, index) => id === ids[index])) return
  // 先移到现有序号之后，兼容 UNIQUE(playlist_id, sequenceNo)，再排列为 1-based。
  const row = db
    .prepare<unknown[], { value: number }>(
      `SELECT COALESCE(MAX(sequenceNo), 0) AS value
    FROM playlist_content WHERE playlist_id = ?`
    )
    .get(playlistId)!
  const temporaryBase = Number(row.value) + ids.length + 1
  if (!Number.isSafeInteger(temporaryBase + ids.length)) throw new Error('歌单顺序序号溢出')
  const update = db.prepare(
    'UPDATE playlist_content SET sequenceNo = ? WHERE playlist_id = ? AND content_id = ?'
  )
  ids.forEach((id, index) => update.run(temporaryBase + index, playlistId, id))
  ids.forEach((id, index) => update.run(index + 1, playlistId, id))
}

function compactMemberOrder(db: UsbOneLibraryDatabase, playlistId: number): void {
  const ids = orderedMembers(db, playlistId)
  if (!ids.length) return
  const rows = usbOneLibraryRows(
    db,
    'SELECT sequenceNo FROM playlist_content WHERE playlist_id = ? ORDER BY sequenceNo',
    playlistId
  )
  if (rows.every((row, index) => row.sequenceNo === index + 1)) return
  const update = db.prepare(
    'UPDATE playlist_content SET sequenceNo = ? WHERE playlist_id = ? AND content_id = ?'
  )
  const maximum = Math.max(...rows.map((row) => Number(row.sequenceNo))) + ids.length + 1
  ids.forEach((id, index) => update.run(maximum + index, playlistId, id))
  ids.forEach((id, index) => update.run(index + 1, playlistId, id))
}

const deletionReferences: Record<string, string[]> = {
  playlist_content: ['content_id'],
  history_content: ['content_id'],
  myTag_content: ['content_id'],
  cue: ['content_id'],
  recommendedLike: ['content_id_1', 'content_id_2']
}

function deleteTracks(
  db: UsbOneLibraryDatabase,
  schema: Map<string, UsbOneLibraryColumn[]>,
  ids: number[]
): void {
  if (!ids.length) return
  const candidateArtworkPaths = new Set<string>()
  for (const id of ids) {
    usbOneLibraryRows(
      db,
      `SELECT i.path FROM image i INNER JOIN content c ON c.image_id = i.image_id
      WHERE c.content_id = ?`,
      id
    ).forEach((row) => {
      if (row.path) candidateArtworkPaths.add(String(row.path).replace(/\\/g, '/').toLowerCase())
    })
  }
  for (const [table, columns] of schema) {
    const references = columns.filter((column) => /^content_id(?:_\d+)?$/i.test(column.name))
    if (table !== 'content' && references.length && !deletionReferences[table]) {
      throw new Error(`检测到未支持的 OneLibrary 曲目引用表 ${table}，拒绝删除`)
    }
    const foreignKeys = usbOneLibraryRows(
      db,
      `PRAGMA foreign_key_list(${quoteUsbSqlIdentifier(table)})`
    )
    if (
      table !== 'content' &&
      foreignKeys.some((key) => key.table === 'content') &&
      !deletionReferences[table]
    ) {
      throw new Error(`检测到未支持的 OneLibrary 曲目外键 ${table}，拒绝删除`)
    }
  }
  if (schema.has('hotCueBankList_cue') && schema.has('cue')) {
    requireUsbOneLibraryColumns(schema, 'hotCueBankList_cue', ['cue_id'])
    requireUsbOneLibraryColumns(schema, 'cue', ['cue_id', 'content_id'])
    const remove = db.prepare(`DELETE FROM hotCueBankList_cue WHERE cue_id IN
      (SELECT cue_id FROM cue WHERE content_id = ?)`)
    ids.forEach((id) => remove.run(id))
  }
  for (const [table, references] of Object.entries(deletionReferences)) {
    if (!schema.has(table)) continue
    requireUsbOneLibraryColumns(schema, table, references)
    const remove = db.prepare(
      `DELETE FROM ${quoteUsbSqlIdentifier(table)} WHERE ${references.map((name) => `${quoteUsbSqlIdentifier(name)} = ?`).join(' OR ')}`
    )
    ids.forEach((id) => remove.run(...references.map(() => id)))
  }
  const remove = db.prepare('DELETE FROM content WHERE content_id = ?')
  ids.forEach((id) => remove.run(id))
  pruneDeletedTrackArtwork(db, schema, candidateArtworkPaths)
  db.prepare('UPDATE property SET numberOfContents = (SELECT COUNT(*) FROM content)').run()
}

export function mutateUsbOneLibraryCopy(
  databasePath: string,
  mutation: UsbLibraryMutation,
  rootPath: string
): void {
  assertUsbOneLibraryStagedCopy(databasePath, rootPath)
  const changesLibrary = Boolean(
    mutation.removals.length ||
    mutation.additions.length ||
    mutation.reorders.length ||
    mutation.deleteTrackIds.length ||
    mutation.deletePlaylistIds.length
  )
  // Playlist edits already require a writable private copy. Reuse that connection
  // for validation and mutation instead of deriving the SQLCipher key twice.
  const readonly = !changesLibrary
  let db = openUsbOneLibraryDatabase(databasePath, readonly)
  try {
    validateUsbOneLibraryIntegrity(db)
    const schema = usbOneLibrarySchema(db)
    const snapshot = readSnapshot(db)
    // 在删除之前锁定保存方式；已识别 Bank List SQL 标点独立于普通歌曲 ANLZ 标点。
    const bankCueIds = readUsbOneLibraryBankCueIds(db, schema)
    const anlzOnlyAnalysis = isUsbOneLibraryAnlzCueProfile(db, schema, bankCueIds)
    const tracks = new Set(snapshot.tracks.map((track) => track.id))
    const playlists = new Map(snapshot.playlists.map((playlist) => [playlist.id, playlist]))
    const assertTracks = (ids: number[]) => {
      uniqueIds(ids, 'trackId')
      if (ids.some((id) => !tracks.has(id))) throw new Error('OneLibrary 中未找到目标歌曲')
    }
    const assertPlaylist = (id: number) => {
      integer(id, 'playlistId')
      const node = playlists.get(id)
      if (!node || node.isFolder) throw new Error('OneLibrary 中未找到可编辑的普通歌单')
    }
    const deletedPlaylists = new Set(uniqueIds(mutation.deletePlaylistIds, 'deletePlaylistIds'))
    assertTracks(mutation.deleteTrackIds)
    for (const id of deletedPlaylists) {
      if (!playlists.has(id)) throw new Error('OneLibrary 中未找到要删除的歌单')
    }
    if (
      snapshot.playlists.some(
        (node) => deletedPlaylists.has(node.parentId) && !deletedPlaylists.has(node.id)
      )
    ) {
      throw new Error('删除文件夹时必须包含其所有子歌单')
    }
    for (const change of [...mutation.removals, ...mutation.additions, ...mutation.reorders]) {
      assertPlaylist(change.playlistId)
      assertTracks(change.trackIds)
      if (
        deletedPlaylists.has(change.playlistId) ||
        change.trackIds.some((id) => mutation.deleteTrackIds.includes(id))
      ) {
        throw new Error('歌单变更与删除操作冲突')
      }
    }
    for (const change of [...mutation.cueUpdates, ...mutation.gridUpdates]) {
      assertTracks([change.trackId])
      if (mutation.deleteTrackIds.includes(change.trackId))
        throw new Error('标点/网格变更与歌曲删除冲突')
    }
    for (const change of mutation.gridUpdates) {
      if (!Number.isSafeInteger(change.offsetMs) || Math.abs(change.offsetMs) > 60000) {
        throw new Error('网格平移量必须是 ±60000 范围内的整数毫秒')
      }
    }
    if (mutation.cueUpdates.length && !anlzOnlyAnalysis)
      requireUsbOneLibraryColumns(schema, 'content', ['hasModified', 'cueUpdateCount'])
    if (mutation.gridUpdates.length && !anlzOnlyAnalysis)
      requireUsbOneLibraryColumns(schema, 'content', ['hasModified', 'analysisDataUpdateCount'])
    const onlyAnlzChanges =
      anlzOnlyAnalysis &&
      !mutation.removals.length &&
      !mutation.additions.length &&
      !mutation.reorders.length &&
      !mutation.deleteTrackIds.length &&
      !mutation.deletePlaylistIds.length
    if (onlyAnlzChanges) {
      // 已观测的空 SQL Cue profile 直接编辑标点或网格只改变 ANLZ。
      // 保持只读连接，避免 BEGIN IMMEDIATE 或 journal_mode 切换改写加密数据库文件。
      for (const change of mutation.cueUpdates)
        replaceUsbOneLibraryCues(
          db,
          schema,
          change.trackId,
          change.hotCues,
          change.memoryCues,
          true,
          bankCueIds
        )
      validateUsbOneLibraryIntegrity(db)
      return
    }
    if (readonly) {
      const writableDb = openUsbOneLibraryDatabase(databasePath, false)
      db.close()
      db = writableDb
    }
    // 仅暂存副本改成单文件 rollback journal。原盘的 WAL 模式与 sidecar 不受影响，
    // SQLCipher profile 也不变；拒绝未合并 WAL 的校验已在打开前完成。
    if (db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
      throw new Error('无法将 OneLibrary 暂存副本转换为独立数据库文件')
    }
    db.transaction(() => {
      const changedPlaylists = new Set<number>()
      for (const change of mutation.removals) {
        const current = orderedMembers(db, change.playlistId)
        if (change.trackIds.some((id) => !current.includes(id)))
          throw new Error('要移除的歌曲不在目标歌单')
        const remove = db.prepare(
          'DELETE FROM playlist_content WHERE playlist_id = ? AND content_id = ?'
        )
        change.trackIds.forEach((id) => remove.run(change.playlistId, id))
        changedPlaylists.add(change.playlistId)
      }
      for (const change of mutation.additions) {
        const current = orderedMembers(db, change.playlistId)
        const additions = change.trackIds.filter((id) => !current.includes(id))
        const unknownRequired = schema
          .get('playlist_content')!
          .filter(
            (column) =>
              !baseColumns.playlist_content.includes(column.name) &&
              column.notnull &&
              column.dflt_value == null
          )
        if (additions.length && unknownRequired.length)
          throw new Error('歌单成员表有未知的必填字段，拒绝增加')
        let sequence = Number(
          db
            .prepare<
              unknown[],
              { value: number }
            >('SELECT COALESCE(MAX(sequenceNo), 0) AS value FROM playlist_content WHERE playlist_id = ?')
            .get(change.playlistId)!.value
        )
        const add = db.prepare(
          'INSERT INTO playlist_content (playlist_id, content_id, sequenceNo) VALUES (?, ?, ?)'
        )
        additions.forEach((id) => add.run(change.playlistId, id, ++sequence))
        changedPlaylists.add(change.playlistId)
      }
      for (const change of mutation.reorders) setMemberOrder(db, change.playlistId, change.trackIds)
      const removePlaylistEntries = db.prepare('DELETE FROM playlist_content WHERE playlist_id = ?')
      const removePlaylist = db.prepare('DELETE FROM playlist WHERE playlist_id = ?')
      const remaining = new Set(deletedPlaylists)
      while (remaining.size) {
        const leaves = [...remaining].filter(
          (id) => !snapshot.playlists.some((node) => node.parentId === id && remaining.has(node.id))
        )
        if (!leaves.length) throw new Error('OneLibrary 删除歌单树存在环')
        for (const id of leaves) {
          removePlaylistEntries.run(id)
          removePlaylist.run(id)
          remaining.delete(id)
        }
      }
      const deletedTracks = new Set(mutation.deleteTrackIds)
      snapshot.entries
        .filter(
          (entry) => deletedTracks.has(entry.trackId) && !deletedPlaylists.has(entry.playlistId)
        )
        .forEach((entry) => changedPlaylists.add(entry.playlistId))
      deleteTracks(db, schema, mutation.deleteTrackIds)
      changedPlaylists.forEach((id) => compactMemberOrder(db, id))
      for (const change of mutation.cueUpdates)
        replaceUsbOneLibraryCues(
          db,
          schema,
          change.trackId,
          change.hotCues,
          change.memoryCues,
          anlzOnlyAnalysis,
          bankCueIds
        )
      const updateGrid =
        mutation.gridUpdates.length && !anlzOnlyAnalysis
          ? db.prepare(`UPDATE content SET hasModified = 1,
        analysisDataUpdateCount = COALESCE(analysisDataUpdateCount, 0) + 1 WHERE content_id = ?`)
          : null
      for (const change of mutation.gridUpdates) {
        if (change.offsetMs !== 0) updateGrid?.run(change.trackId)
      }
      readSnapshot(db)
      validateUsbOneLibraryIntegrity(db)
    }).immediate()
    // 暂存副本必须独立包含所有写入，不能留下待提交 WAL 文件。
    if (db.pragma('journal_mode', { simple: true }) === 'wal') db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}
