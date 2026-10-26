import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mainFilePathKey } from '../../filePathComparison'
import { LibraryMergeError } from './types'

type SqliteDatabase = InstanceType<typeof import('better-sqlite3')>

export type LibraryMergeRowTransformContext = {
  sourceDb: SqliteDatabase
  targetDb: SqliteDatabase
  sourceRoot: string
  sourceFilePathToTarget: Map<string, string>
  sourceNodePaths: Array<{ sourceAbs: string; targetAbs: string }>
  nodeUuidMap: Map<string, string>
}

const quoteIdentifier = (value: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new LibraryMergeError('DATABASE_SCHEMA_INVALID', `非法数据库标识符：${value}`)
  }
  return `"${value}"`
}

const getTableColumns = (db: SqliteDatabase, tableName: string): string[] => {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<
    Record<string, unknown>
  >
  return rows
    .map((row) => (typeof row.name === 'string' ? row.name : ''))
    .filter((column): column is string => !!column)
}

const hasTable = (db: SqliteDatabase, tableName: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as Record<string, unknown> | undefined
  return typeof row?.name === 'string'
}

const isPathInside = (parentPath: string, targetPath: string): boolean => {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath))
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

const remapSourcePath = (params: {
  value: unknown
  sourceRoot: string
  sourceFilePathToTarget: Map<string, string>
  sourceNodePaths: Array<{ sourceAbs: string; targetAbs: string }>
}): string | null => {
  const raw = typeof params.value === 'string' ? params.value.trim() : ''
  if (!raw) return null
  const sourceAbs = path.resolve(raw)
  const exactTarget = params.sourceFilePathToTarget.get(mainFilePathKey(sourceAbs))
  if (exactTarget) return exactTarget
  if (!path.isAbsolute(raw) || !isPathInside(params.sourceRoot, sourceAbs)) return raw
  const candidateNodes = [...params.sourceNodePaths].sort(
    (left, right) => right.sourceAbs.length - left.sourceAbs.length
  )
  for (const node of candidateNodes) {
    if (!isPathInside(node.sourceAbs, sourceAbs)) continue
    return path.join(node.targetAbs, path.relative(node.sourceAbs, sourceAbs))
  }
  throw new LibraryMergeError('SOURCE_DATA_INVALID', `来源路径无法重写：${raw}`)
}

const rebaseOptionalJson = (params: {
  raw: unknown
  sourceRoot: string
  sourceFilePathToTarget: Map<string, string>
  sourceNodePaths: Array<{ sourceAbs: string; targetAbs: string }>
  resetStemState?: boolean
  description: string
}): string | null => {
  if (params.raw === null || params.raw === undefined || params.raw === '') return null
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(String(params.raw)) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid json')
    parsed = { ...(value as Record<string, unknown>) }
  } catch {
    throw new LibraryMergeError('SOURCE_DATA_INVALID', `来源库的 ${params.description} 无法解析`)
  }
  if (typeof parsed.filePath === 'string') {
    parsed.filePath = remapSourcePath({
      value: parsed.filePath,
      sourceRoot: params.sourceRoot,
      sourceFilePathToTarget: params.sourceFilePathToTarget,
      sourceNodePaths: params.sourceNodePaths
    })
  }
  if (params.resetStemState) {
    for (const key of [
      'stemError',
      'stemReadyAt',
      'stemModel',
      'stemVersion',
      'stemVocalPath',
      'stemInstPath',
      'stemBassPath',
      'stemDrumsPath'
    ]) {
      delete parsed[key]
    }
    parsed.stemStatus = 'pending'
  }
  return JSON.stringify(parsed)
}

const copyPlaylistItems = (
  context: LibraryMergeRowTransformContext,
  tableName: 'set_items' | 'mixtape_items'
): number => {
  if (!hasTable(context.sourceDb, tableName) || !hasTable(context.targetDb, tableName)) return 0
  const columns = getTableColumns(context.sourceDb, tableName)
  const targetColumns = new Set(getTableColumns(context.targetDb, tableName))
  if (columns.some((column) => !targetColumns.has(column))) {
    throw new LibraryMergeError('SOURCE_SCHEMA_UNSUPPORTED', `无法迁移 ${tableName} 的字段结构`)
  }
  const selectColumns = columns.map(quoteIdentifier).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  const insert = context.targetDb.prepare(
    `INSERT INTO ${quoteIdentifier(tableName)} (${selectColumns}) VALUES (${placeholders})`
  )
  const rows = context.sourceDb
    .prepare(`SELECT ${selectColumns} FROM ${quoteIdentifier(tableName)}`)
    .all() as Array<Record<string, unknown>>
  let copied = 0
  for (const row of rows) {
    const playlistUuid = typeof row.playlist_uuid === 'string' ? row.playlist_uuid.trim() : ''
    const targetPlaylistUuid = context.nodeUuidMap.get(playlistUuid)
    if (!targetPlaylistUuid) {
      throw new LibraryMergeError('SOURCE_DATA_INVALID', `${tableName} 的歌单映射丢失`)
    }
    const nextRow: Record<string, unknown> = {
      ...row,
      id: randomUUID(),
      playlist_uuid: targetPlaylistUuid
    }
    nextRow.file_path = remapSourcePath({
      value: row.file_path,
      sourceRoot: context.sourceRoot,
      sourceFilePathToTarget: context.sourceFilePathToTarget,
      sourceNodePaths: context.sourceNodePaths
    })
    if (columns.includes('origin_playlist_uuid')) {
      const originUuid =
        typeof row.origin_playlist_uuid === 'string' ? row.origin_playlist_uuid.trim() : ''
      nextRow.origin_playlist_uuid = originUuid ? context.nodeUuidMap.get(originUuid) || null : null
    }
    if (columns.includes('origin_path_snapshot')) {
      nextRow.origin_path_snapshot = remapSourcePath({
        value: row.origin_path_snapshot,
        sourceRoot: context.sourceRoot,
        sourceFilePathToTarget: context.sourceFilePathToTarget,
        sourceNodePaths: context.sourceNodePaths
      })
    }
    if (tableName === 'set_items' && columns.includes('analysis_json')) {
      nextRow.analysis_json = rebaseOptionalJson({
        raw: row.analysis_json,
        sourceRoot: context.sourceRoot,
        sourceFilePathToTarget: context.sourceFilePathToTarget,
        sourceNodePaths: context.sourceNodePaths,
        description: 'set_items.analysis_json'
      })
    }
    if (tableName === 'mixtape_items' && columns.includes('info_json')) {
      nextRow.info_json = rebaseOptionalJson({
        raw: row.info_json,
        sourceRoot: context.sourceRoot,
        sourceFilePathToTarget: context.sourceFilePathToTarget,
        sourceNodePaths: context.sourceNodePaths,
        resetStemState: true,
        description: 'mixtape_items.info_json'
      })
    }
    insert.run(...columns.map((column) => nextRow[column] ?? null))
    copied += 1
  }
  return copied
}

export const mergeSetItems = (context: LibraryMergeRowTransformContext): number =>
  copyPlaylistItems(context, 'set_items')

export const mergeMixtapeItems = (context: LibraryMergeRowTransformContext): number =>
  copyPlaylistItems(context, 'mixtape_items')

export const mergeMixtapeProjects = (context: LibraryMergeRowTransformContext): number => {
  const tableName = 'mixtape_projects'
  if (!hasTable(context.sourceDb, tableName) || !hasTable(context.targetDb, tableName)) return 0
  const columns = getTableColumns(context.sourceDb, tableName)
  const targetColumns = new Set(getTableColumns(context.targetDb, tableName))
  if (columns.some((column) => !targetColumns.has(column))) {
    throw new LibraryMergeError('SOURCE_SCHEMA_UNSUPPORTED', '无法迁移 mixtape_projects 的字段结构')
  }
  const selectColumns = columns.map(quoteIdentifier).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  const insert = context.targetDb.prepare(
    `INSERT INTO ${quoteIdentifier(tableName)} (${selectColumns}) VALUES (${placeholders})`
  )
  const rows = context.sourceDb
    .prepare(`SELECT ${selectColumns} FROM ${quoteIdentifier(tableName)}`)
    .all() as Array<Record<string, unknown>>
  let copied = 0
  for (const row of rows) {
    const sourcePlaylistUuid = typeof row.playlist_uuid === 'string' ? row.playlist_uuid.trim() : ''
    const targetPlaylistUuid = context.nodeUuidMap.get(sourcePlaylistUuid)
    if (!targetPlaylistUuid) {
      throw new LibraryMergeError('SOURCE_DATA_INVALID', 'mixtape_projects 的歌单映射丢失')
    }
    const nextRow: Record<string, unknown> = { ...row, playlist_uuid: targetPlaylistUuid }
    if (columns.includes('info_json')) {
      nextRow.info_json = rebaseOptionalJson({
        raw: row.info_json,
        sourceRoot: context.sourceRoot,
        sourceFilePathToTarget: context.sourceFilePathToTarget,
        sourceNodePaths: context.sourceNodePaths,
        description: 'mixtape_projects.info_json'
      })
    }
    insert.run(...columns.map((column) => nextRow[column] ?? null))
    copied += 1
  }
  return copied
}
