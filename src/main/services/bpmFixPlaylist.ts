import fs from 'node:fs/promises'
import { statSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import store from '../store'
import { getLibraryDb } from '../libraryDb'
import { findLibraryNodeByPath } from '../libraryTreeDb'
import { getCoreFsDirName } from '../coreLibraries'
import {
  isUnderPath,
  normalizePath,
  resolveCacheFilePath,
  resolveFilePathInput,
  resolveListRootInput
} from '../libraryCacheDb/pathResolvers'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'
import {
  invalidatePlaylistViewSnapshotsByPaths,
  beginPlaylistViewSnapshotMutationByPaths
} from './playlistViewSnapshotService'
import { scheduleCuratedLibrarySyncIfUnderCurated } from '../cloudSyncScheduler'
import { markGlobalSongSearchDirty } from './globalSongSearch'
import type { BpmFixStart, BpmFixSummary } from '../../shared/bpmFix'
import { compactSongListTrackNumbersByFilePaths } from './playlistTrackNumbers'
import { stripMixtapeGridCopies } from './mixtapeAnalysisInfo'

export type BpmFixPlaylist = { root: string; uuid: string; kind: 'physical' | 'set' | 'mixtape' }
export const beginBpmFixPublication = (paths: string[]) =>
  beginPlaylistViewSnapshotMutationByPaths(paths)
export const resolveBpmFixPlaylist = async (input: BpmFixStart): Promise<BpmFixPlaylist> => {
  if (
    !store.databaseDir ||
    typeof input.songListPath !== 'string' ||
    typeof input.songListUUID !== 'string' ||
    !input.songListUUID
  )
    throw new Error('BPM_FIX_INVALID_PLAYLIST')
  const library = await fs.realpath(path.join(store.databaseDir, 'library'))
  const requested = path.isAbsolute(input.songListPath)
    ? input.songListPath
    : path.resolve(store.databaseDir, input.songListPath)
  const root = await fs.realpath(requested)
  if (!isUnderPath(library, root)) throw new Error('BPM_FIX_INVALID_PLAYLIST')
  const node = findLibraryNodeByPath(path.relative(library, root))
  if (
    !node ||
    node.uuid !== input.songListUUID ||
    !['songList', 'setList', 'mixtapeList'].includes(node.nodeType)
  )
    throw new Error('BPM_FIX_INVALID_PLAYLIST')
  const core = path.relative(library, root).split(path.sep)[0]
  const kind =
    core === getCoreFsDirName('SetLibrary')
      ? 'set'
      : core === getCoreFsDirName('MixtapeLibrary')
        ? 'mixtape'
        : 'physical'
  return { root, uuid: node.uuid, kind }
}

export const assertBpmFixPlaylistTrack = (playlist: BpmFixPlaylist, source: string) => {
  const node = findLibraryNodeByPath(
    path.relative(path.join(store.databaseDir, 'library'), playlist.root)
  )
  if (!node || node.uuid !== playlist.uuid) throw new Error('BPM_FIX_INVALID_PLAYLIST')
  if (playlist.kind === 'physical') {
    if (!isUnderPath(playlist.root, source)) throw new Error('BPM_FIX_INVALID_PLAYLIST')
    return
  }
  const db = getLibraryDb()
  const table = playlist.kind === 'set' ? 'set_items' : 'mixtape_items'
  const found = db
    ?.prepare(
      `SELECT id FROM ${table} WHERE playlist_uuid = ? AND LOWER(REPLACE(file_path, '\\', '/')) = LOWER(?) LIMIT 1`
    )
    .get(playlist.uuid, source.replace(/\\/g, '/'))
  if (!found) throw new Error('BPM_FIX_INVALID_PLAYLIST')
}

export const chooseBpmFixDestination = async (
  playlist: BpmFixPlaylist,
  source: string,
  overwrite: boolean,
  format: 'wav' | 'original'
) => {
  const ext = format === 'wav' ? '.wav' : path.extname(source).toLowerCase()
  if (!['.wav', '.mp3', '.flac', '.aif', '.aiff', '.m4a', '.aac', '.ogg', '.opus'].includes(ext))
    throw new Error('BPM_FIX_UNSUPPORTED_FORMAT')
  if (overwrite) return path.join(path.dirname(source), path.parse(source).name + ext)
  const base = path.parse(source).name + '_BPM_fixed'
  for (let i = 0; i < 10000; i++) {
    const candidate = path.join(playlist.root, base + (i ? ` (${i})` : '') + ext)
    try {
      await fs.lstat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('BPM_FIX_OUTPUT_EXISTS')
}

export type BpmFixTimeMap = {
  from: number[]
  to: number[]
  sampleRate: number
  downbeatBeatOffset: number
}
const parseInfo = (value: unknown): Record<string, unknown> => {
  if (!value) return {}
  const parsed: unknown = JSON.parse(String(value))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}
export const transformBpmFixInfo = (
  info: Record<string, unknown>,
  output: string,
  summary: BpmFixSummary,
  map: BpmFixTimeMap
) => {
  const next = { ...info }
  const warp = (sec: number) => {
    const frame = sec * map.sampleRate
    let i = 1
    while (i < map.from.length - 1 && map.from[i] < frame) i++
    const amount = Math.max(
      0,
      Math.min(1, (frame - map.from[i - 1]) / (map.from[i] - map.from[i - 1]))
    )
    return (map.to[i - 1] + amount * (map.to[i] - map.to[i - 1])) / map.sampleRate
  }
  for (const field of ['hotCues', 'memoryCues']) {
    if (Array.isArray(next[field]))
      next[field] = next[field].map((cue: unknown) => {
        if (!cue || typeof cue !== 'object') return cue
        const result = { ...cue } as Record<string, unknown>
        for (const key of ['sec', 'loopEndSec'])
          if (typeof result[key] === 'number') result[key] = warp(result[key])
        return result
      })
  }
  for (const key of [
    'bpm',
    'firstBeatMs',
    'downbeatBeatOffset',
    'barBeatOffset',
    'beatGridSource',
    'beatGridStatus',
    'beatGridAlgorithmVersion',
    'rekordboxGridEntries',
    'externalBeatGridPreference',
    'fingerprint',
    'beatThisEstimatedDrift128Ms',
    'beatThisWindowCount',
    'key',
    'keySource',
    'replayGain',
    'timeBasisOffsetMs'
  ])
    delete next[key]
  for (const key of Object.keys(next)) {
    if (
      key.startsWith('stem') ||
      key.startsWith('energy') ||
      key.startsWith('waveform') ||
      ['songStructure', 'keyAnalysisAlgorithmVersion', 'originalBpm', 'originalKey'].includes(key)
    )
      delete next[key]
  }
  // Encoding can change bitrate, depth, container metadata and duration. Force
  // the normal metadata scan to refresh these while retaining the repaired grid.
  next.analysisOnly = true
  next.filePath = output
  next.fileName = path.basename(output)
  next.fileFormat = path.extname(output).slice(1).toUpperCase()
  next.container = next.fileFormat
  next.duration = `${Math.floor(summary.durationOutSec / 60)}:${String(Math.floor(summary.durationOutSec % 60)).padStart(2, '0')}`
  next.durationSec = summary.durationOutSec
  next.beatGridMap = createSongBeatGridMapV2FromFixedGrid({
    bpm: summary.targetBpm,
    firstBeatMs: summary.gridOffsetSec * 1000,
    downbeatBeatOffset: map.downbeatBeatOffset,
    source: 'manual'
  })
  return next
}

// Called synchronously inside file publication; a database failure rolls the
// audio replacement back. All reads are current DB rows, never view snapshots.
export const commitBpmFixPlaylist = (
  playlist: BpmFixPlaylist,
  source: string,
  output: string,
  overwrite: boolean,
  summary: BpmFixSummary,
  map: BpmFixTimeMap
): string[] => {
  assertBpmFixPlaylistTrack(playlist, source)
  const db = getLibraryDb()
  if (!db) throw new Error('BPM_FIX_INVALID_PLAYLIST')
  const affected = new Set([playlist.uuid])
  const where = "LOWER(REPLACE(file_path, '\\', '/')) = LOWER(?)"
  const sourceKey = source.replace(/\\/g, '/')
  db.transaction(() => {
    const cached = db
      .prepare(
        "SELECT list_root, file_path, info_json FROM song_cache WHERE LOWER(REPLACE(json_extract(info_json, '$.filePath'), '\\', '/')) = LOWER(?)"
      )
      .all(sourceKey)
      .filter(
        (row) =>
          normalizePath(
            resolveCacheFilePath(String(row.list_root), String(row.file_path)) || ''
          ) === normalizePath(source)
      )
    const referenceInfo = () => {
      for (const [table, column] of [
        ['set_items', 'analysis_json'],
        ['mixtape_items', 'info_json']
      ]) {
        const row = db
          .prepare(`SELECT ${column} AS info FROM ${table} WHERE ${where} LIMIT 1`)
          .get(sourceKey)
        if (row?.info) return parseInfo(row.info)
      }
      return {}
    }
    const baseInfo = cached.length ? parseInfo(cached[0].info_json) : referenceInfo()
    const stat = statSync(output)
    const insertCache = (root: string, oldPath?: string, info: Record<string, unknown> = {}) => {
      const rootKey = resolveListRootInput(root)?.key
      const fileKey = resolveFilePathInput(root, output)?.key
      if (!rootKey || !fileKey) throw new Error('BPM_FIX_INVALID_PLAYLIST')
      if (oldPath)
        db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
          rootKey,
          oldPath
        )
      db.prepare(
        'INSERT OR REPLACE INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
      ).run(
        rootKey,
        fileKey,
        stat.size,
        stat.mtimeMs,
        JSON.stringify(transformBpmFixInfo(info, output, summary, map))
      )
    }
    if (overwrite) {
      for (const row of cached) {
        const root = resolveListRootInput(String(row.list_root))?.abs
        if (root) insertCache(root, String(row.file_path), parseInfo(row.info_json))
      }
      if (!cached.length) insertCache(playlist.root, undefined, baseInfo)
      for (const [table, column] of [
        ['set_items', 'analysis_json'],
        ['mixtape_items', 'info_json']
      ]) {
        const rows = db
          .prepare(`SELECT id, playlist_uuid, ${column} AS info FROM ${table} WHERE ${where}`)
          .all(sourceKey)
        const update = db.prepare(`UPDATE ${table} SET file_path = ?, ${column} = ? WHERE id = ?`)
        for (const row of rows) {
          const info = transformBpmFixInfo(parseInfo(row.info), output, summary, map)
          stripMixtapeGridCopies(info)
          update.run(output, JSON.stringify(info), row.id)
          affected.add(String(row.playlist_uuid))
        }
      }
    } else {
      const info = transformBpmFixInfo(baseInfo, output, summary, map)
      insertCache(playlist.root, undefined, baseInfo)
      stripMixtapeGridCopies(info)
      if (playlist.kind !== 'physical') {
        const table = playlist.kind === 'set' ? 'set_items' : 'mixtape_items'
        const order = playlist.kind === 'set' ? 'sort_order' : 'mix_order'
        const column = playlist.kind === 'set' ? 'analysis_json' : 'info_json'
        const max = db
          .prepare(`SELECT COALESCE(MAX(${order}), 0) AS n FROM ${table} WHERE playlist_uuid = ?`)
          .get(playlist.uuid)
        db.prepare(
          `INSERT INTO ${table} (id, playlist_uuid, file_path, ${order}, ${column}, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          playlist.uuid,
          output,
          Number(max?.n || 0) + 1,
          JSON.stringify(info),
          Date.now()
        )
      }
    }
  })()
  return [...affected]
}

export const refreshBpmFixPlaylist = async (paths: string[]) => {
  await compactSongListTrackNumbersByFilePaths(paths)
  invalidatePlaylistViewSnapshotsByPaths(paths)
  markGlobalSongSearchDirty()
  scheduleCuratedLibrarySyncIfUnderCurated(paths)
}
