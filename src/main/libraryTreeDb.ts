import fs = require('fs-extra')
import path = require('path')
import { v4 as uuidV4 } from 'uuid'
import store from './store'
import { getLibraryDb, getMetaValue, isSqliteRow, setMetaValue } from './libraryDb'
import { log } from './log'
import {
  normalizeOrder,
  normalizeAudioExtensions,
  readUuidMarker,
  writeUuidMarker,
  decideNodeType,
  getPathDepth,
  isChildNodeType,
  toNodeRow,
  splitPath,
  getDb,
  getRootNode,
  ensureRootNode
} from './libraryTreeDbHelpers'
import type { LibraryNodeType, LibraryNodeRow, LegacyLibraryNode } from './libraryTreeDbHelpers'
import type { SqliteDatabase } from './libraryDb'

export type { LibraryNodeType, LibraryNodeRow, LegacyLibraryNode } from './libraryTreeDbHelpers'

const TREE_MIGRATION_DONE_KEY = 'library_tree_migration_done_v1'
const TREE_MIGRATION_IN_PROGRESS_KEY = 'library_tree_migration_in_progress_v1'
const TREE_ARCHIVE_DONE_KEY = 'library_tree_legacy_archive_done_v1'
const SET_CUSTODY_DIR_NAME = '__set_custody__'
const MAIN_PROCESS_TREE_SCAN_YIELD_EVERY = 128

// 库树核对仍需在主进程协调 SQLite，但目录很多时不能连续占满事件循环；
// 让出一个 macrotask 后，Windows 的窗口拖动和 Electron IPC 能及时被处理。
const yieldToMainProcess = () => new Promise<void>((resolve) => setImmediate(resolve))

export function isLibraryTreeMigrationDone(db: SqliteDatabase): boolean {
  return getMetaValue(db, TREE_MIGRATION_DONE_KEY) === '1'
}

export function isLibraryTreeMigrationInProgress(db: SqliteDatabase): boolean {
  return getMetaValue(db, TREE_MIGRATION_IN_PROGRESS_KEY) === '1'
}

export function setLibraryTreeMigrationDone(db: SqliteDatabase, done: boolean): void {
  setMetaValue(db, TREE_MIGRATION_DONE_KEY, done ? '1' : '0')
}

export function setLibraryTreeMigrationInProgress(db: SqliteDatabase, inProgress: boolean): void {
  setMetaValue(db, TREE_MIGRATION_IN_PROGRESS_KEY, inProgress ? '1' : '0')
}

function isLibraryTreeArchiveDone(db: SqliteDatabase): boolean {
  return getMetaValue(db, TREE_ARCHIVE_DONE_KEY) === '1'
}

function setLibraryTreeArchiveDone(db: SqliteDatabase, done: boolean): void {
  setMetaValue(db, TREE_ARCHIVE_DONE_KEY, done ? '1' : '0')
}

function countLibraryNodes(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare<{ count?: number | string }>('SELECT COUNT(1) as count FROM library_nodes')
      .get()
    return row ? Number(row.count) : 0
  } catch {
    return 0
  }
}

async function readLegacyLibraryNodes(dbRoot: string): Promise<LegacyLibraryNode[] | null> {
  if (!dbRoot) return null
  const libRoot = path.join(dbRoot, 'library')
  const rootDesc = path.join(libRoot, '.description.json')
  if (!(await fs.pathExists(rootDesc))) return null
  let rootJson: unknown = null
  try {
    rootJson = await fs.readJSON(rootDesc)
  } catch {
    rootJson = null
  }
  if (!isSqliteRow(rootJson) || !rootJson.uuid || rootJson.type !== 'root') return null

  const nodes: LegacyLibraryNode[] = [
    {
      uuid: String(rootJson.uuid),
      parentUuid: null,
      dirName: 'library',
      nodeType: 'root',
      order: normalizeOrder(rootJson.order),
      fullPath: libRoot
    }
  ]

  const walk = async (dirPath: string, parentUuid: string) => {
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const childDir = path.join(dirPath, entry.name)
      const descPath = path.join(childDir, '.description.json')
      let desc: unknown = null
      try {
        desc = await fs.readJSON(descPath)
      } catch {
        desc = null
      }
      if (!isSqliteRow(desc) || !desc.uuid || !isChildNodeType(desc.type)) {
        continue
      }
      const node: LegacyLibraryNode = {
        uuid: String(desc.uuid),
        parentUuid,
        dirName: entry.name,
        nodeType: desc.type,
        order: normalizeOrder(desc.order),
        fullPath: childDir
      }
      nodes.push(node)
      await walk(childDir, node.uuid)
    }
  }

  await walk(libRoot, nodes[0].uuid)
  return nodes
}

async function hasLegacyDescriptionFiles(dbRoot: string): Promise<boolean> {
  if (!dbRoot) return false
  const libRoot = path.join(dbRoot, 'library')
  if (!(await fs.pathExists(libRoot))) return false
  const queue: string[] = [libRoot]
  while (queue.length > 0) {
    const current = queue.shift() as string
    const descPath = path.join(current, '.description.json')
    if (await fs.pathExists(descPath)) return true
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      queue.push(path.join(current, entry.name))
    }
  }
  return false
}

export async function needsLibraryTreeMigration(
  dbRoot: string,
  db?: SqliteDatabase
): Promise<boolean> {
  const dbInstance = db || getDb(dbRoot)
  if (!dbInstance || !dbRoot) return false
  const rootDesc = path.join(dbRoot, 'library', '.description.json')
  const hasDesc = await fs.pathExists(rootDesc)
  if (!hasDesc) return false
  if (!isLibraryTreeMigrationDone(dbInstance)) return true
  return countLibraryNodes(dbInstance) === 0
}

export async function needsLibraryTreeArchive(
  dbRoot: string,
  db?: SqliteDatabase
): Promise<boolean> {
  const dbInstance = db || getDb(dbRoot)
  if (!dbInstance || !dbRoot) return false
  if (isLibraryTreeArchiveDone(dbInstance)) return false
  return await hasLegacyDescriptionFiles(dbRoot)
}

export async function migrateLegacyLibraryTree(
  dbRoot: string,
  db?: SqliteDatabase
): Promise<LegacyLibraryNode[] | null> {
  const dbInstance = db || getDb(dbRoot)
  if (!dbInstance || !dbRoot) return null
  const nodes = await readLegacyLibraryNodes(dbRoot)
  if (!nodes || nodes.length === 0) return null
  try {
    const insert = dbInstance.prepare(
      'INSERT OR REPLACE INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    )
    const wipe = dbInstance.prepare('DELETE FROM library_nodes')
    const run = dbInstance.transaction((items: LegacyLibraryNode[]) => {
      wipe.run()
      for (const node of items) {
        insert.run(node.uuid, node.parentUuid, node.dirName, node.nodeType, node.order)
      }
    })
    run(nodes)
    return nodes
  } catch (error) {
    log.error('[sqlite] library tree migrate failed', error)
    return null
  }
}

export async function archiveLegacyDescriptionFiles(
  nodes: LegacyLibraryNode[],
  db?: SqliteDatabase
): Promise<void> {
  if (!Array.isArray(nodes) || nodes.length === 0) return
  for (const node of nodes) {
    const descPath = path.join(node.fullPath, '.description.json')
    const legacyPath = path.join(node.fullPath, '.description.json.legacy')
    try {
      if (!(await fs.pathExists(descPath))) continue
      if (await fs.pathExists(legacyPath)) continue
      await fs.move(descPath, legacyPath, { overwrite: false })
    } catch (error) {
      log.error('[sqlite] archive legacy description failed', { path: descPath, error })
    }
  }
  const dbInstance = db || getLibraryDb()
  if (dbInstance) {
    setLibraryTreeArchiveDone(dbInstance, true)
  }
}

export async function archiveLegacyDescriptionFilesByRoot(
  dbRoot: string,
  db?: SqliteDatabase
): Promise<void> {
  const nodes = await readLegacyLibraryNodes(dbRoot)
  if (nodes && nodes.length > 0) {
    await archiveLegacyDescriptionFiles(nodes, db)
    return
  }
  if (!dbRoot) return
  const libRoot = path.join(dbRoot, 'library')
  if (!(await fs.pathExists(libRoot))) return
  const queue: string[] = [libRoot]
  while (queue.length > 0) {
    const current = queue.shift() as string
    const descPath = path.join(current, '.description.json')
    const legacyPath = path.join(current, '.description.json.legacy')
    try {
      if (await fs.pathExists(descPath)) {
        if (!(await fs.pathExists(legacyPath))) {
          await fs.move(descPath, legacyPath, { overwrite: false })
        }
      }
    } catch (error) {
      log.error('[sqlite] archive legacy description failed', { path: descPath, error })
    }
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      queue.push(path.join(current, entry.name))
    }
  }
  const dbInstance = db || getLibraryDb()
  if (dbInstance) {
    setLibraryTreeArchiveDone(dbInstance, true)
  }
}

export async function ensureLibraryTreeBaseline(
  dbRoot: string,
  options: {
    coreDirNames?: {
      FilterLibrary: string
      CuratedLibrary: string
      SetLibrary: string
      MixtapeLibrary: string
      RecordingLibrary: string
      RecycleBin: string
    }
  } = {}
): Promise<void> {
  if (!dbRoot) return
  const db = getDb(dbRoot)
  if (!db) return
  try {
    if (countLibraryNodes(db) > 0) return
    const legacyRoot = path.join(dbRoot, 'library', '.description.json')
    if (await fs.pathExists(legacyRoot)) return
    const root = ensureRootNode(db)
    if (!root) return
    const coreNames = options.coreDirNames || {
      FilterLibrary: 'FilterLibrary',
      CuratedLibrary: 'CuratedLibrary',
      SetLibrary: 'SetLibrary',
      MixtapeLibrary: 'MixtapeLibrary',
      RecordingLibrary: 'RecordingLibrary',
      RecycleBin: 'RecycleBin'
    }
    const filterUuid = uuidV4()
    const curatedUuid = uuidV4()
    const setUuid = uuidV4()
    const mixtapeUuid = uuidV4()
    const recordingUuid = uuidV4()
    const recycleUuid = uuidV4()
    const insert = db.prepare(
      'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    )
    const run = db.transaction(() => {
      insert.run(filterUuid, root.uuid, coreNames.FilterLibrary, 'library', 1)
      insert.run(curatedUuid, root.uuid, coreNames.CuratedLibrary, 'library', 2)
      insert.run(setUuid, root.uuid, coreNames.SetLibrary, 'library', 3)
      insert.run(mixtapeUuid, root.uuid, coreNames.MixtapeLibrary, 'library', 4)
      insert.run(recordingUuid, root.uuid, coreNames.RecordingLibrary, 'library', 5)
      insert.run(recycleUuid, root.uuid, coreNames.RecycleBin, 'library', 6)
    })
    run()
    setLibraryTreeMigrationDone(db, true)
    setLibraryTreeMigrationInProgress(db, false)
  } catch (error) {
    log.error('[sqlite] library tree baseline failed', error)
  }
}

export function loadLibraryNodes(dbRoot?: string): LibraryNodeRow[] | null {
  const db = getDb(dbRoot)
  if (!db) return null
  try {
    const rows = db
      .prepare('SELECT uuid, parent_uuid, dir_name, node_type, sort_order FROM library_nodes')
      .all() as Array<Record<string, unknown>>
    const mapped = rows.map((row) => toNodeRow(row)) as Array<LibraryNodeRow | null>
    return mapped.filter((row): row is LibraryNodeRow => !!row)
  } catch (error) {
    log.error('[sqlite] library nodes load failed', error)
    return null
  }
}

export async function syncLibraryTreeFromDisk(
  dbRoot: string,
  options: {
    coreDirNames?: {
      FilterLibrary: string
      CuratedLibrary: string
      SetLibrary: string
      MixtapeLibrary: string
      RecordingLibrary: string
      RecycleBin: string
    }
    audioExtensions?: string[]
  } = {}
): Promise<{ added: number; removed: number; updated: number }> {
  const db = getDb(dbRoot)
  if (!db || !dbRoot) return { added: 0, removed: 0, updated: 0 }
  const root = ensureRootNode(db)
  if (!root) return { added: 0, removed: 0, updated: 0 }

  const rows = loadLibraryNodes(dbRoot) || []
  const dbByUuid = new Map<string, LibraryNodeRow>()
  for (const row of rows) {
    dbByUuid.set(row.uuid, row)
  }
  const childrenMap = new Map<string, LibraryNodeRow[]>()
  for (const row of rows) {
    if (!row.parentUuid) continue
    const list = childrenMap.get(row.parentUuid)
    if (list) {
      list.push(row)
    } else {
      childrenMap.set(row.parentUuid, [row])
    }
  }

  const rootNode = rows.find((row) => row.uuid === root.uuid) || root
  const dbPathByPath = new Map<string, LibraryNodeRow>()
  const dbPathByUuid = new Map<string, string>()

  dbPathByPath.set(rootNode.dirName, rootNode)
  dbPathByUuid.set(rootNode.uuid, rootNode.dirName)

  const queue: LibraryNodeRow[] = [rootNode]
  for (let i = 0; i < queue.length; i += 1) {
    const parent = queue[i]
    const parentPath = dbPathByUuid.get(parent.uuid)
    if (!parentPath) continue
    const children = childrenMap.get(parent.uuid) || []
    for (const child of children) {
      const childPath = path.join(parentPath, child.dirName)
      if (!dbPathByPath.has(childPath)) {
        dbPathByPath.set(childPath, child)
      }
      dbPathByUuid.set(child.uuid, childPath)
      queue.push(child)
    }
  }

  const coreNames = options.coreDirNames || {
    FilterLibrary: 'FilterLibrary',
    CuratedLibrary: 'CuratedLibrary',
    SetLibrary: 'SetLibrary',
    MixtapeLibrary: 'MixtapeLibrary',
    RecordingLibrary: 'RecordingLibrary',
    RecycleBin: 'RecycleBin'
  }
  const coreOrderMap = new Map<string, number>([
    [coreNames.FilterLibrary, 1],
    [coreNames.CuratedLibrary, 2],
    [coreNames.SetLibrary, 3],
    [coreNames.MixtapeLibrary, 4],
    [coreNames.RecordingLibrary, 5],
    [coreNames.RecycleBin, 6]
  ])
  const coreNameList = Array.from(
    new Set([
      coreNames.FilterLibrary,
      coreNames.CuratedLibrary,
      coreNames.SetLibrary,
      coreNames.MixtapeLibrary,
      coreNames.RecordingLibrary,
      coreNames.RecycleBin
    ])
  ).filter((name) => name && String(name).trim().length > 0)

  const rootDirName = rootNode.dirName
  const libraryRoot = path.join(dbRoot, rootDirName)
  if (!(await fs.pathExists(libraryRoot))) {
    return { added: 0, removed: 0, updated: 0 }
  }
  const normalizeTreeRelPathKey = (relPath: string) => {
    let normalized = path.normalize(relPath)
    if (process.platform === 'win32') normalized = normalized.toLowerCase()
    return normalized
  }
  const setCustodyRelPathKey = normalizeTreeRelPathKey(
    path.join(rootDirName, coreNames.SetLibrary, SET_CUSTODY_DIR_NAME)
  )
  const isInternalSetCustodyRelPath = (relPath: string) => {
    const key = normalizeTreeRelPathKey(relPath)
    return key === setCustodyRelPathKey || key.startsWith(setCustodyRelPathKey + path.sep)
  }

  const audioExts = normalizeAudioExtensions(
    options.audioExtensions || store.settingConfig?.audioExt
  )

  type DiskNode = {
    relPath: string
    parentPath: string | null
    dirName: string
    absPath: string
    nodeType?: LibraryNodeType
    hasSubdirs?: boolean
    hasAudio?: boolean
    diskUuid?: string | null
  }

  const fsNodeMap = new Map<string, DiskNode>()
  fsNodeMap.set(rootDirName, {
    relPath: rootDirName,
    parentPath: null,
    dirName: rootDirName,
    absPath: libraryRoot,
    nodeType: 'root'
  })

  const scanQueue: Array<{ absPath: string; relPath: string }> = []
  for (const coreName of coreNameList) {
    const absPath = path.join(libraryRoot, coreName)
    let stats: fs.Stats | null = null
    try {
      stats = await fs.stat(absPath)
    } catch {
      stats = null
    }
    if (!stats || !stats.isDirectory()) continue
    const relPath = path.join(rootDirName, coreName)
    const diskUuid = await readUuidMarker(absPath)
    fsNodeMap.set(relPath, {
      relPath,
      parentPath: rootDirName,
      dirName: coreName,
      absPath,
      nodeType: 'library',
      diskUuid
    })
    scanQueue.push({ absPath, relPath })
  }

  for (let i = 0; i < scanQueue.length; i += 1) {
    if (i > 0 && i % MAIN_PROCESS_TREE_SCAN_YIELD_EVERY === 0) {
      await yieldToMainProcess()
    }
    const current = scanQueue[i]
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.readdir(current.absPath, { withFileTypes: true })
    } catch {
      entries = []
    }

    let hasSubdirs = false
    let hasAudio = false
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      if (entryIndex > 0 && entryIndex % MAIN_PROCESS_TREE_SCAN_YIELD_EVERY === 0) {
        await yieldToMainProcess()
      }
      const entry = entries[entryIndex]
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        const childAbs = path.join(current.absPath, entry.name)
        const childRel = path.join(current.relPath, entry.name)
        if (isInternalSetCustodyRelPath(childRel)) continue
        hasSubdirs = true
        scanQueue.push({ absPath: childAbs, relPath: childRel })
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (audioExts.has(ext)) hasAudio = true
      }
    }

    const existing = fsNodeMap.get(current.relPath)
    const diskUuid = existing?.diskUuid || (await readUuidMarker(current.absPath))
    const dirName = path.basename(current.relPath)
    const rawParent = path.dirname(current.relPath)
    const parentPath = rawParent === '.' ? rootDirName : rawParent

    fsNodeMap.set(current.relPath, {
      relPath: current.relPath,
      parentPath,
      dirName,
      absPath: current.absPath,
      nodeType: existing?.nodeType,
      hasSubdirs,
      hasAudio,
      diskUuid
    })
  }

  const diskNodes = Array.from(fsNodeMap.values()).filter((node) => node.relPath !== rootDirName)
  diskNodes.sort((a, b) => getPathDepth(a.relPath) - getPathDepth(b.relPath))

  const assignedUuidByPath = new Map<string, string>()
  assignedUuidByPath.set(rootDirName, rootNode.uuid)

  const usedUuids = new Set<string>()
  usedUuids.add(rootNode.uuid)

  const diskUuids = new Set<string>()
  diskUuids.add(rootNode.uuid)

  const markerWrites: Array<{ absPath: string; uuid: string }> = []
  const moveUpdates: Array<{ uuid: string; parentUuid: string; dirName: string }> = []
  const typeUpdates: Array<{ uuid: string; nodeType: LibraryNodeType }> = []
  const inserts: Array<{
    uuid: string
    parentUuid: string
    dirName: string
    nodeType: LibraryNodeType
    order: number | null
    depth: number
  }> = []

  let orderSeed = Date.now()

  for (let nodeIndex = 0; nodeIndex < diskNodes.length; nodeIndex += 1) {
    if (nodeIndex > 0 && nodeIndex % MAIN_PROCESS_TREE_SCAN_YIELD_EVERY === 0) {
      await yieldToMainProcess()
    }
    const node = diskNodes[nodeIndex]
    let diskUuid = node.diskUuid ? String(node.diskUuid).trim() : null
    if (diskUuid && usedUuids.has(diskUuid)) {
      diskUuid = null
    }
    let assignedUuid: string | null = null
    let existingNode: LibraryNodeRow | null = null

    if (diskUuid) {
      const existing = dbByUuid.get(diskUuid)
      if (existing) {
        assignedUuid = diskUuid
        existingNode = existing
      } else {
        const existingByPath = dbPathByPath.get(node.relPath)
        if (existingByPath && !usedUuids.has(existingByPath.uuid)) {
          assignedUuid = existingByPath.uuid
          existingNode = existingByPath
        } else {
          assignedUuid = diskUuid
        }
      }
    }

    if (!assignedUuid) {
      const existingByPath = dbPathByPath.get(node.relPath)
      if (existingByPath && !usedUuids.has(existingByPath.uuid)) {
        assignedUuid = existingByPath.uuid
        existingNode = existingByPath
      } else {
        assignedUuid = uuidV4()
      }
    }

    if (!assignedUuid) continue
    const finalUuid = assignedUuid
    usedUuids.add(finalUuid)
    assignedUuidByPath.set(node.relPath, finalUuid)
    diskUuids.add(finalUuid)

    const parentPath = node.parentPath || rootDirName
    const parentUuid = assignedUuidByPath.get(parentPath)
    if (!parentUuid) continue

    const resolvedExisting = existingNode || dbByUuid.get(finalUuid) || null
    const finalType =
      node.nodeType === 'library'
        ? 'library'
        : decideNodeType(resolvedExisting?.nodeType, !!node.hasSubdirs, !!node.hasAudio)

    if (resolvedExisting) {
      if (resolvedExisting.parentUuid !== parentUuid || resolvedExisting.dirName !== node.dirName) {
        moveUpdates.push({ uuid: resolvedExisting.uuid, parentUuid, dirName: node.dirName })
      }
      if (resolvedExisting.nodeType !== finalType) {
        typeUpdates.push({ uuid: resolvedExisting.uuid, nodeType: finalType })
      }
    } else {
      let order: number | null = null
      if (finalType === 'library') {
        const preset = coreOrderMap.get(node.dirName)
        order = preset ?? orderSeed++
      } else {
        order = orderSeed++
      }
      inserts.push({
        uuid: finalUuid,
        parentUuid,
        dirName: node.dirName,
        nodeType: finalType,
        order,
        depth: getPathDepth(node.relPath)
      })
    }

    if (node.absPath && (!node.diskUuid || node.diskUuid !== finalUuid)) {
      markerWrites.push({ absPath: node.absPath, uuid: finalUuid })
    }
  }

  const toDelete = new Set<string>()
  for (const row of rows) {
    if (row.uuid === rootNode.uuid) continue
    if (!diskUuids.has(row.uuid)) {
      toDelete.add(row.uuid)
    }
  }

  let added = 0
  let removed = 0
  let updated = 0

  // 先写标记文件，再提交数据库事务。
  // 如果标记文件写入成功但事务失败（极端情况），磁盘上会有多余的 .frkb.uuid 文件，
  // 但下次同步会自我修正，不会导致数据丢失或损坏。
  for (let markerIndex = 0; markerIndex < markerWrites.length; markerIndex += 1) {
    if (markerIndex > 0 && markerIndex % MAIN_PROCESS_TREE_SCAN_YIELD_EVERY === 0) {
      await yieldToMainProcess()
    }
    const item = markerWrites[markerIndex]
    await writeUuidMarker(item.absPath, item.uuid)
  }

  try {
    const insertStmt = db.prepare(
      'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    )
    const updateMoveTemp = db.prepare('UPDATE library_nodes SET dir_name = ? WHERE uuid = ?')
    const updateMoveFinal = db.prepare(
      'UPDATE library_nodes SET parent_uuid = ?, dir_name = ? WHERE uuid = ?'
    )
    const updateTypeStmt = db.prepare('UPDATE library_nodes SET node_type = ? WHERE uuid = ?')
    const deleteStmt = db.prepare('DELETE FROM library_nodes WHERE uuid = ?')

    const run = db.transaction(() => {
      for (const move of moveUpdates) {
        updateMoveTemp.run(`__frkb_tmp_${move.uuid}`, move.uuid)
        updated += 1
      }
      for (const node of inserts.sort((left, right) => left.depth - right.depth)) {
        insertStmt.run(node.uuid, node.parentUuid, node.dirName, node.nodeType, node.order)
        added += 1
      }
      for (const move of moveUpdates) {
        updateMoveFinal.run(move.parentUuid, move.dirName, move.uuid)
      }
      for (const upd of typeUpdates) {
        updateTypeStmt.run(upd.nodeType, upd.uuid)
        updated += 1
      }
      for (const uuid of [...toDelete].sort((left, right) => {
        const leftDepth = getPathDepth(dbPathByUuid.get(left) || '')
        const rightDepth = getPathDepth(dbPathByUuid.get(right) || '')
        return rightDepth - leftDepth
      })) {
        if (deleteStmt.run(uuid).changes > 0) removed += 1
      }
    })
    run()
  } catch (error) {
    log.error('[sqlite] library tree sync failed', error)
  }

  return { added, removed, updated }
}

export async function pruneMissingLibraryNodes(dbRoot?: string): Promise<number> {
  const rootDir = dbRoot || store.databaseDir
  if (!rootDir) return 0
  const db = getDb(dbRoot)
  if (!db) return 0

  const rows = loadLibraryNodes(dbRoot) || []
  if (rows.length === 0) return 0

  const root = rows.find((row) => row.parentUuid === null && row.nodeType === 'root')
  if (!root) return 0

  const rootPath = path.join(rootDir, root.dirName)
  if (!(await fs.pathExists(rootPath))) return 0

  const childrenMap = new Map<string, LibraryNodeRow[]>()
  for (const row of rows) {
    if (!row.parentUuid) continue
    const list = childrenMap.get(row.parentUuid)
    if (list) {
      list.push(row)
    } else {
      childrenMap.set(row.parentUuid, [row])
    }
  }

  const missing = new Set<string>()
  const visited = new Set<string>()
  visited.add(root.uuid)

  const addSubtree = (startUuid: string) => {
    const stack = [startUuid]
    while (stack.length > 0) {
      const uuid = stack.pop() as string
      if (uuid === root.uuid) continue
      if (missing.has(uuid)) continue
      missing.add(uuid)
      const children = childrenMap.get(uuid)
      if (!children) continue
      for (const child of children) {
        stack.push(child.uuid)
      }
    }
  }

  const queue: Array<{ node: LibraryNodeRow; absPath: string }> = [
    { node: root, absPath: rootPath }
  ]

  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]
    const children = childrenMap.get(current.node.uuid) || []
    for (const child of children) {
      if (visited.has(child.uuid) || missing.has(child.uuid)) continue
      const childPath = path.join(current.absPath, child.dirName)
      if (child.nodeType === 'library') {
        visited.add(child.uuid)
        queue.push({ node: child, absPath: childPath })
        continue
      }
      let exists = false
      try {
        exists = await fs.pathExists(childPath)
      } catch {
        exists = false
      }
      if (!exists) {
        addSubtree(child.uuid)
        continue
      }
      visited.add(child.uuid)
      queue.push({ node: child, absPath: childPath })
    }
  }

  for (const row of rows) {
    if (row.uuid === root.uuid) continue
    if (missing.has(row.uuid) || visited.has(row.uuid)) continue
    addSubtree(row.uuid)
  }

  if (missing.size === 0) return 0

  try {
    const deleteStmt = db.prepare('DELETE FROM library_nodes WHERE uuid = ?')
    const run = db.transaction((ids: string[]) => {
      for (const id of ids) {
        deleteStmt.run(id)
      }
    })
    run(Array.from(missing))
    return missing.size
  } catch (error) {
    log.error('[sqlite] library node cleanup failed', error)
    return 0
  }
}

export function findLibraryNodeByPath(relPath: string, dbRoot?: string): LibraryNodeRow | null {
  const db = getDb(dbRoot)
  if (!db || !relPath) return null
  const parts = splitPath(relPath)
  if (parts.length === 0) return null
  const root = getRootNode(db)
  if (!root) return null
  const isWin = process.platform === 'win32'
  const equalsPart = (left: string, right: string) =>
    isWin ? String(left).toLowerCase() === String(right).toLowerCase() : left === right
  let index = 0
  if (equalsPart(parts[0], root.dirName)) {
    if (parts.length === 1) return root
    index = 1
  }
  let current: LibraryNodeRow = root
  const stmt = db.prepare(
    isWin
      ? 'SELECT uuid, parent_uuid, dir_name, node_type, sort_order FROM library_nodes WHERE parent_uuid = ? AND dir_name = ? COLLATE NOCASE LIMIT 1'
      : 'SELECT uuid, parent_uuid, dir_name, node_type, sort_order FROM library_nodes WHERE parent_uuid = ? AND dir_name = ? LIMIT 1'
  )
  for (let i = index; i < parts.length; i += 1) {
    const row = stmt.get(current.uuid, parts[i])
    const next = toNodeRow(row)
    if (!next) return null
    current = next
  }
  return current
}

export function insertLibraryNode(
  node: {
    uuid: string
    parentUuid: string | null
    dirName: string
    nodeType: LibraryNodeType
    order?: number | null
  },
  dbRoot?: string
): boolean {
  const db = getDb(dbRoot)
  if (!db) return false
  try {
    db.prepare(
      'INSERT OR IGNORE INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(node.uuid, node.parentUuid, node.dirName, node.nodeType, normalizeOrder(node.order))
    return true
  } catch (error) {
    log.error('[sqlite] library node insert failed', error)
    return false
  }
}

export function updateLibraryNodeOrder(
  uuid: string,
  order: number | null | undefined,
  dbRoot?: string
): boolean {
  const db = getDb(dbRoot)
  if (!db || !uuid) return false
  try {
    db.prepare('UPDATE library_nodes SET sort_order = ? WHERE uuid = ?').run(
      normalizeOrder(order),
      uuid
    )
    return true
  } catch (error) {
    log.error('[sqlite] library node reorder failed', error)
    return false
  }
}

export function updateLibraryNodeName(uuid: string, dirName: string, dbRoot?: string): boolean {
  const db = getDb(dbRoot)
  if (!db || !uuid || !dirName) return false
  try {
    db.prepare('UPDATE library_nodes SET dir_name = ? WHERE uuid = ?').run(dirName, uuid)
    return true
  } catch (error) {
    log.error('[sqlite] library node rename failed', error)
    return false
  }
}

export function moveLibraryNode(
  uuid: string,
  parentUuid: string,
  dirName: string,
  dbRoot?: string
): boolean {
  const db = getDb(dbRoot)
  if (!db || !uuid || !parentUuid || !dirName) return false
  try {
    db.prepare('UPDATE library_nodes SET parent_uuid = ?, dir_name = ? WHERE uuid = ?').run(
      parentUuid,
      dirName,
      uuid
    )
    return true
  } catch (error) {
    log.error('[sqlite] library node move failed', error)
    return false
  }
}

export function removeLibraryNode(uuid: string, dbRoot?: string): boolean {
  const db = getDb(dbRoot)
  if (!db || !uuid) return false
  try {
    db.prepare('DELETE FROM library_nodes WHERE uuid = ?').run(uuid)
    return true
  } catch (error) {
    log.error('[sqlite] library node delete failed', error)
    return false
  }
}

export function removeLibraryNodesByParentUuid(parentUuid: string, dbRoot?: string): boolean {
  const db = getDb(dbRoot)
  if (!db || !parentUuid) return false
  try {
    db.prepare('DELETE FROM library_nodes WHERE parent_uuid = ?').run(parentUuid)
    return true
  } catch (error) {
    log.error('[sqlite] library node delete by parent failed', error)
    return false
  }
}

export async function findSongListRootByPath(
  startDir: string,
  dbRoot?: string
): Promise<string | null> {
  const rootDir = dbRoot || store.databaseDir
  if (!rootDir || !startDir) return null
  const isWin = process.platform === 'win32'
  const libRoot = path.join(rootDir, 'library')
  const relative = path.relative(
    isWin ? libRoot.toLowerCase() : libRoot,
    isWin ? startDir.toLowerCase() : startDir
  )
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  const parts = splitPath(relative)
  if (parts.length === 0) return null

  const db = getDb(dbRoot)
  if (!db) return null
  const rootNode = getRootNode(db)
  if (!rootNode) return null

  const stmt = db.prepare(
    isWin
      ? 'SELECT uuid, parent_uuid, dir_name, node_type, sort_order FROM library_nodes WHERE parent_uuid = ? AND dir_name = ? COLLATE NOCASE LIMIT 1'
      : 'SELECT uuid, parent_uuid, dir_name, node_type, sort_order FROM library_nodes WHERE parent_uuid = ? AND dir_name = ? LIMIT 1'
  )
  let current = rootNode
  const walked: string[] = []
  let lastSongList: string[] | null = null

  for (const part of parts) {
    const row = stmt.get(current.uuid, part)
    const next = toNodeRow(row)
    if (!next) break
    // 使用库树中的标准目录名，避免大小写漂移导致缓存键不一致
    walked.push(next.dirName)
    if (next.nodeType === 'songList') {
      lastSongList = [...walked]
    }
    current = next
  }

  if (!lastSongList) return null
  return path.join(libRoot, ...lastSongList)
}
