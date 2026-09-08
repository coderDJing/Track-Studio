import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { v4 as uuidV4 } from 'uuid'
import { log } from '../log'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'
import store from '../store'
import { getCoreFsDirName } from '../coreLibraries'
import { notifyCuratedFilePathChanged } from '../curatedLibrarySync/identityDb'
import { getCuratedLibraryAbsRoot, isPathInside } from '../curatedLibrarySync/paths'
import { notifyLibraryFsChanged } from '../libraryTreeWatcher'
import { loadLibraryNodes, type LibraryNodeRow } from '../libraryTreeDb'
import { scanSongList } from '../services/scanSongs'
import { findSongListRoot, transferTrackCaches } from '../services/cacheMaintenance'
import { moveFileToRecycleBin } from '../recycleBinService'
import * as LibraryCacheDb from '../libraryCacheDb'
import { normalizeSongHotCues } from '../../shared/hotCues'
import { normalizeSongMemoryCues } from '../../shared/memoryCues'
import { hasUsableSongEnergyAnalysis } from '../../shared/songEnergy'
import {
  hasRequiredSongStructureAnalysis,
  hasUsableKeyAnalysis
} from '../../shared/songAnalysisCompleteness'
import {
  hasUsableSongStructureAnalysis,
  normalizeSongStructureAnalysis
} from '../../shared/songStructure'
import type { ISongInfo } from '../../types/globals'
import { normalizeAddedAtMs } from '../../shared/songAddedAt'
import { normalizeFilePathForComparison } from '../../shared/filePathComparison'
import { buildSetAnalysisSnapshot } from '../services/setAnalysisSnapshot'
import {
  listSetItemsByPlaylist,
  listSetItemsByIds,
  appendSetItems,
  removeSetItemsByIds,
  removeSetItemsByPlaylist,
  reorderSetPlaylistItems,
  countSetItemsByPlaylist,
  countSetItemsByPlaylists,
  findSetItemsByFilePath,
  findSetItemsByFilePaths,
  updateSetItemFilePath,
  updateSetItemAnalysisSnapshot,
  normalizeSetItemOrder,
  type SetItemRecord
} from '../setListDb'

export const SET_CUSTODY_DIR_NAME = '__set_custody__'

type SetMappingWithPlaylistName = SetItemRecord & {
  playlistName: string
}

export function normalizeSetFilePathKey(filePath: string): string {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : ''
  if (!trimmed) return ''
  return normalizeFilePathForComparison(path.normalize(trimmed), process.platform === 'win32')
}

function normalizeRequestedFilePaths(filePaths: string[]): string[] {
  const byKey = new Map<string, string>()
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    if (typeof filePath !== 'string') continue
    const trimmed = filePath.trim()
    const key = normalizeSetFilePathKey(trimmed)
    if (!trimmed || !key || byKey.has(key)) continue
    byKey.set(key, trimmed)
  }
  return [...byKey.values()]
}

const hasFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const hasPositiveInteger = (value: unknown): value is number =>
  hasFiniteNumber(value) && Math.floor(value) === value && value > 0

const hasCompleteKeyAnalysis = (info: Partial<ISongInfo> | null | undefined) =>
  hasUsableKeyAnalysis(info)

function parseSetItemAnalysisJson(raw: unknown): Partial<ISongInfo> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Partial<ISongInfo>
  } catch {
    return null
  }
}

function persistSetAnalysisSnapshotIfChanged(
  item: SetItemRecord,
  snapshot: Record<string, unknown> | null
) {
  const nextJson = snapshot ? JSON.stringify(snapshot) : ''
  if (String(item.analysisJson || '') === nextJson) return
  updateSetItemAnalysisSnapshot(item.id, snapshot)
}

function mergeSetAnalysisFields(target: ISongInfo, source: Partial<ISongInfo> | null): ISongInfo {
  if (!source) return target
  const next = { ...target }
  if (!hasCompleteKeyAnalysis(next) && hasCompleteKeyAnalysis(source)) {
    next.key = source.key as string
    if (hasPositiveInteger(source.keyAnalysisAlgorithmVersion)) {
      next.keyAnalysisAlgorithmVersion = source.keyAnalysisAlgorithmVersion
    }
  }
  if (!hasUsableSongEnergyAnalysis(next) && hasUsableSongEnergyAnalysis(source)) {
    next.energyScore = source.energyScore
    if (hasPositiveInteger(source.energyAlgorithmVersion)) {
      next.energyAlgorithmVersion = source.energyAlgorithmVersion
    }
  }
  const sourceStructure = normalizeSongStructureAnalysis(source.songStructure)
  if (
    sourceStructure &&
    !hasUsableSongStructureAnalysis(next) &&
    hasUsableSongStructureAnalysis(source) &&
    hasUsableSongStructureAnalysis({ ...next, songStructure: sourceStructure })
  ) {
    next.songStructure = sourceStructure
  }
  if (!Array.isArray(next.hotCues) || next.hotCues.length === 0) {
    const hotCues = normalizeSongHotCues(source.hotCues)
    if (hotCues.length > 0) {
      next.hotCues = hotCues
    }
  }
  if (!Array.isArray(next.memoryCues) || next.memoryCues.length === 0) {
    const memoryCues = normalizeSongMemoryCues(source.memoryCues)
    if (memoryCues.length > 0) {
      next.memoryCues = memoryCues
    }
  }
  return next
}

function createMissingSetSong(item: SetItemRecord): ISongInfo {
  return mergeSetAnalysisFields(
    {
      setItemId: item.id,
      filePath: item.filePath,
      fileName: path.basename(item.filePath),
      fileFormat: path.extname(item.filePath).replace('.', '').toLowerCase(),
      cover: null,
      title: undefined,
      artist: undefined,
      album: undefined,
      duration: '',
      genre: undefined,
      label: undefined,
      bitrate: undefined,
      container: undefined,
      playlistTrackNumber: item.sortOrder,
      addedAtMs: normalizeAddedAtMs(item.createdAtMs),
      fileMissing: true
    },
    parseSetItemAnalysisJson(item.analysisJson)
  )
}

function buildLibraryNodePathMap(rows: LibraryNodeRow[]): Map<string, string> {
  const childrenByParent = new Map<string, LibraryNodeRow[]>()
  for (const row of rows) {
    if (!row.parentUuid) continue
    const list = childrenByParent.get(row.parentUuid)
    if (list) {
      list.push(row)
    } else {
      childrenByParent.set(row.parentUuid, [row])
    }
  }
  const root = rows.find((row) => row.parentUuid === null && row.nodeType === 'root')
  if (!root) return new Map()

  const pathByUuid = new Map<string, string>()
  pathByUuid.set(root.uuid, root.dirName)
  const queue: LibraryNodeRow[] = [root]
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]
    const parentPath = pathByUuid.get(current.uuid)
    if (!parentPath) continue
    const children = childrenByParent.get(current.uuid) || []
    for (const child of children) {
      const childPath = path.join(parentPath, child.dirName)
      pathByUuid.set(child.uuid, childPath)
      queue.push(child)
    }
  }
  return pathByUuid
}

function buildPlaylistRootByUuidMap(): Map<string, string> {
  const rows = loadLibraryNodes(store.databaseDir) || []
  const rootByUuid = new Map<string, string>()
  if (!rows.length || !store.databaseDir) return rootByUuid

  const pathByUuid = buildLibraryNodePathMap(rows)
  for (const row of rows) {
    if (
      row.nodeType !== 'songList' &&
      row.nodeType !== 'mixtapeList' &&
      row.nodeType !== 'setList'
    ) {
      continue
    }
    const relPath = pathByUuid.get(row.uuid)
    if (!relPath) continue
    rootByUuid.set(row.uuid, path.join(store.databaseDir, relPath))
  }
  return rootByUuid
}

function normalizeUniqueText(values: Array<string | null | undefined>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) continue
    const key = process.platform === 'win32' ? text.toLowerCase() : text
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function isPathUnderDirectory(targetPath: string, parentDir: string): boolean {
  const targetKey = normalizeSetFilePathKey(path.resolve(targetPath))
  const parentKey = normalizeSetFilePathKey(path.resolve(parentDir))
  if (!targetKey || !parentKey) return false
  return targetKey === parentKey || targetKey.startsWith(parentKey + path.sep.toLowerCase())
}

function isCurrentCacheEntry(
  entry: { size: number; mtimeMs: number } | null | undefined,
  stats: { size: number; mtimeMs: number } | null
): boolean {
  if (!entry || !stats) return false
  return (
    Number(entry.size) === stats.size &&
    Number.isFinite(Number(entry.mtimeMs)) &&
    Math.abs(Number(entry.mtimeMs) - stats.mtimeMs) < 1
  )
}

async function readFileStatsForAnalysisSnapshot(
  primaryPath: string,
  fallbackPath = ''
): Promise<{ size: number; mtimeMs: number } | null> {
  for (const filePath of normalizeUniqueText([primaryPath, fallbackPath])) {
    try {
      const fileStats = await fs.stat(filePath)
      return { size: fileStats.size, mtimeMs: fileStats.mtimeMs }
    } catch {}
  }
  return null
}

async function loadSetAnalysisSnapshotFromCache(
  item: SetItemRecord,
  filePath: string,
  statPath: string,
  playlistRootByUuid: Map<string, string>,
  statsOverride?: { size: number; mtimeMs: number } | null
): Promise<{ found: boolean; snapshot: Record<string, unknown> | null }> {
  const stats = statsOverride || (await readFileStatsForAnalysisSnapshot(statPath, filePath))
  const originRoot = item.originPlaylistUuid
    ? playlistRootByUuid.get(item.originPlaylistUuid) || ''
    : ''
  const sourceListRoot = (await findSongListRoot(path.dirname(filePath))) || ''
  const roots = normalizeUniqueText([originRoot, sourceListRoot])
  for (const root of roots) {
    const cached = await LibraryCacheDb.loadSongCacheEntry(root, filePath).catch(() => null)
    if (!cached?.info || !isCurrentCacheEntry(cached, stats)) continue
    return { found: true, snapshot: buildSetAnalysisSnapshot(cached.info) }
  }
  return { found: false, snapshot: null }
}

async function enrichSetSongFromSourceAnalysis(
  item: SetItemRecord,
  song: ISongInfo,
  playlistRootByUuid: Map<string, string>
): Promise<ISongInfo> {
  let next = song
  const stats = await readFileStatsForAnalysisSnapshot(song.filePath)

  const originRoot = item.originPlaylistUuid
    ? playlistRootByUuid.get(item.originPlaylistUuid) || ''
    : ''
  const custodyRoot = getSetCustodyDirAbs()
  const sourceListRoot = (await findSongListRoot(path.dirname(song.filePath))) || ''
  const waveformPreviewListRoot = isPathUnderDirectory(song.filePath, custodyRoot)
    ? custodyRoot
    : originRoot || sourceListRoot
  if (waveformPreviewListRoot) {
    next = {
      ...next,
      waveformPreviewListRoot
    }
  }
  const roots = normalizeUniqueText([waveformPreviewListRoot, originRoot, sourceListRoot])
  const fileCandidates = normalizeUniqueText([song.filePath, item.filePath])
  let foundCurrentCache = false
  for (const root of roots) {
    for (const filePath of fileCandidates) {
      const cached = await LibraryCacheDb.loadSongCacheEntry(root, filePath).catch(() => null)
      if (!cached?.info || !isCurrentCacheEntry(cached, stats)) continue
      foundCurrentCache = true
      next = mergeSetAnalysisFields(next, cached.info)
      persistSetAnalysisSnapshotIfChanged(item, buildSetAnalysisSnapshot(cached.info))
      if (
        hasCompleteKeyAnalysis(next) &&
        hasUsableSongEnergyAnalysis(next) &&
        hasRequiredSongStructureAnalysis(next)
      ) {
        break
      }
    }
    if (
      hasCompleteKeyAnalysis(next) &&
      hasUsableSongEnergyAnalysis(next) &&
      hasRequiredSongStructureAnalysis(next)
    ) {
      break
    }
  }

  return foundCurrentCache
    ? next
    : mergeSetAnalysisFields(next, parseSetItemAnalysisJson(item.analysisJson))
}

function getSetLibraryDirAbs(): string {
  const dbRoot = store.databaseDir
  const setDirName = getCoreFsDirName('SetLibrary')
  return path.join(dbRoot, 'library', setDirName)
}

function getSetCustodyDirAbs(): string {
  return path.join(getSetLibraryDirAbs(), SET_CUSTODY_DIR_NAME)
}

function isSetCustodyFilePath(filePath: string): boolean {
  const fileKey = normalizeSetFilePathKey(path.resolve(filePath || ''))
  const custodyKey = normalizeSetFilePathKey(path.resolve(getSetCustodyDirAbs()))
  return fileKey === custodyKey || fileKey.startsWith(`${custodyKey}${path.sep}`)
}

async function recycleOrphanedSetCustodyFiles(items: SetItemRecord[]): Promise<void> {
  const candidatePaths = normalizeRequestedFilePaths(
    items.map((item) => item.filePath).filter((filePath) => isSetCustodyFilePath(filePath))
  )
  for (const filePath of candidatePaths) {
    try {
      if (findSetItemsByFilePath(filePath).length > 0) continue
      if (!(await fs.pathExists(filePath))) continue
      const result = await moveFileToRecycleBin(filePath, {
        originalPlaylistPath: null,
        sourceType: 'set_custody_orphan'
      })
      if (result.status === 'failed') {
        log.error('[setList] recycle orphan custody file failed', {
          filePath,
          error: result.error
        })
      }
    } catch (error) {
      log.error('[setList] recycle orphan custody file failed', { filePath, error })
    }
  }
}

async function removeSetItemWithCustodyCleanup(id: string): Promise<boolean> {
  const removed = await removeSetItemsByIdsWithCustodyCleanup([id])
  return removed > 0
}

export async function removeSetItemsByIdsWithCustodyCleanup(ids: string[]): Promise<number> {
  const items = listSetItemsByIds(ids)
  const removed = removeSetItemsByIds(ids)
  if (removed > 0) {
    await recycleOrphanedSetCustodyFiles(items)
  }
  return removed
}

export async function removeSetItemsByPlaylistWithCustodyCleanup(
  playlistUuid: string
): Promise<number> {
  const items = listSetItemsByPlaylist(playlistUuid)
  const removed = removeSetItemsByPlaylist(playlistUuid)
  if (removed > 0) {
    await recycleOrphanedSetCustodyFiles(items)
  }
  return removed
}

async function recycleSetItemFilesAndRemoveItems(ids: string[]): Promise<{
  total: number
  success: number
  failed: number
  removedPaths: string[]
  removedSetItemIds: string[]
}> {
  const items = listSetItemsByIds(ids)
  const byFilePath = new Map<string, { filePath: string; itemIds: string[] }>()
  for (const item of items) {
    const key = normalizeSetFilePathKey(item.filePath)
    if (!key) continue
    const group = byFilePath.get(key) || { filePath: item.filePath, itemIds: [] }
    group.itemIds.push(item.id)
    byFilePath.set(key, group)
  }

  const removedPaths: string[] = []
  const removedSetItemIds: string[] = []
  let failed = 0
  for (const group of byFilePath.values()) {
    try {
      const result = await moveFileToRecycleBin(group.filePath, {
        originalPlaylistPath: null,
        sourceType: 'set_export_after_delete'
      })
      if (result.status !== 'moved') {
        failed += group.itemIds.length
        log.error('[setList] recycle set item file failed', {
          filePath: group.filePath,
          status: result.status,
          error: result.error
        })
        continue
      }
      removeSetItemsByIds(group.itemIds)
      removedPaths.push(group.filePath)
      removedSetItemIds.push(...group.itemIds)
    } catch (error) {
      failed += group.itemIds.length
      log.error('[setList] recycle set item file failed', { filePath: group.filePath, error })
    }
  }

  return {
    total: items.length,
    success: removedSetItemIds.length,
    failed,
    removedPaths,
    removedSetItemIds
  }
}

function buildPlaylistUuidToNameMap(): Map<string, string> {
  const nodes = loadLibraryNodes()
  const map = new Map<string, string>()
  if (!nodes) return map
  for (const node of nodes) {
    map.set(node.uuid, node.dirName)
  }
  return map
}

export function findSetReferencesForFiles(filePaths: string[]): SetMappingWithPlaylistName[] {
  const nameMap = buildPlaylistUuidToNameMap()
  const results: SetMappingWithPlaylistName[] = []
  const seen = new Set<string>()
  const items = findSetItemsByFilePaths(normalizeRequestedFilePaths(filePaths))
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    results.push({
      ...item,
      playlistName: nameMap.get(item.playlistUuid) || item.playlistUuid
    })
  }
  return results
}

type SetCustodyResult = {
  movedMap: Map<string, string>
  sourceStats: Map<string, { size: number; mtimeMs: number }>
  failures: Array<{ filePath: string; error: string }>
}

type SetDeleteProtectionResult = {
  protectedFiles: Array<{
    filePath: string
    movedTo: string
    playlists: string[]
    success: boolean
    error?: string
  }>
  unprotectedFiles: string[]
}

async function moveFilesToSetCustody(filePaths: string[]): Promise<SetCustodyResult> {
  const movedMap = new Map<string, string>()
  const sourceStats = new Map<string, { size: number; mtimeMs: number }>()
  const failures: Array<{ filePath: string; error: string }> = []
  const custodyDir = getSetCustodyDirAbs()
  await fs.ensureDir(custodyDir)
  for (const filePath of filePaths) {
    try {
      if (!(await fs.pathExists(filePath))) {
        failures.push({ filePath, error: 'file not found' })
        continue
      }
      const sourceFsStat = await fs.stat(filePath)
      sourceStats.set(filePath, { size: sourceFsStat.size, mtimeMs: sourceFsStat.mtimeMs })
      const fileName = path.basename(filePath)
      let destPath = path.join(custodyDir, fileName)
      if (await fs.pathExists(destPath)) {
        const ext = path.extname(fileName)
        const base = path.basename(fileName, ext)
        destPath = path.join(custodyDir, `${base}_${uuidV4().slice(0, 8)}${ext}`)
      }
      await fs.move(filePath, destPath, { overwrite: false })
      movedMap.set(filePath, destPath)
      try {
        notifyCuratedFilePathChanged(filePath, destPath)
      } catch {}
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('[setList] move to custody failed', { filePath, error })
      failures.push({ filePath, error: msg })
    }
  }
  return { movedMap, sourceStats, failures }
}

async function updateSetMappingsForMovedFiles(
  movedMap: Map<string, string>,
  sourceStats?: Map<string, { size: number; mtimeMs: number }>
): Promise<number> {
  let updated = 0
  const playlistRootByUuid = buildPlaylistRootByUuidMap()
  const custodyRoot = getSetCustodyDirAbs()
  const transferredCacheKeys = new Set<string>()
  for (const [oldPath, newPath] of movedMap) {
    const sourceStat = sourceStats?.get(oldPath) || null
    const items = findSetItemsByFilePath(oldPath)
    for (const item of items) {
      const snapshotLookup = await loadSetAnalysisSnapshotFromCache(
        item,
        oldPath,
        newPath,
        playlistRootByUuid,
        sourceStat
      )
      if (snapshotLookup.found) {
        persistSetAnalysisSnapshotIfChanged(item, snapshotLookup.snapshot)
      }
      const originRoot = item.originPlaylistUuid
        ? playlistRootByUuid.get(item.originPlaylistUuid) || ''
        : ''
      const sourceListRoot = (await findSongListRoot(path.dirname(oldPath))) || ''
      for (const fromRoot of normalizeUniqueText([originRoot, sourceListRoot])) {
        const transferKey = `${normalizeSetFilePathKey(fromRoot)}::${normalizeSetFilePathKey(oldPath)}::${normalizeSetFilePathKey(newPath)}`
        if (transferredCacheKeys.has(transferKey)) continue
        transferredCacheKeys.add(transferKey)
        await transferTrackCaches({
          fromRoot,
          toRoot: custodyRoot,
          fromPath: oldPath,
          toPath: newPath,
          fromStat: sourceStat
        })
      }
      if (updateSetItemFilePath(item.id, newPath)) {
        updated++
      }
    }
  }
  return updated
}

function findMovedDestination(movedMap: Map<string, string>, filePath: string): string {
  const direct = movedMap.get(filePath)
  if (direct) return direct
  const key = normalizeSetFilePathKey(filePath)
  for (const [sourcePath, destPath] of movedMap) {
    if (normalizeSetFilePathKey(sourcePath) === key) return destPath
  }
  return ''
}

export async function protectSetReferencedFilesForDeletion(
  filePaths: string[]
): Promise<SetDeleteProtectionResult> {
  const normalizedPaths = normalizeRequestedFilePaths(filePaths)
  if (normalizedPaths.length === 0) {
    return { protectedFiles: [], unprotectedFiles: [] }
  }

  const references = findSetReferencesForFiles(normalizedPaths)
  const refsByFile = new Map<string, SetMappingWithPlaylistName[]>()
  for (const ref of references) {
    const key = normalizeSetFilePathKey(ref.filePath)
    const list = refsByFile.get(key) || []
    list.push(ref)
    refsByFile.set(key, list)
  }

  const protectedPaths: string[] = []
  const unprotectedPaths: string[] = []
  for (const filePath of normalizedPaths) {
    if (refsByFile.has(normalizeSetFilePathKey(filePath))) {
      protectedPaths.push(filePath)
    } else {
      unprotectedPaths.push(filePath)
    }
  }

  let movedMap = new Map<string, string>()
  const custodyFailures: Array<{ filePath: string; error: string }> = []
  if (protectedPaths.length > 0) {
    const custodyResult = await moveFilesToSetCustody(protectedPaths)
    movedMap = custodyResult.movedMap
    custodyFailures.push(...custodyResult.failures)
    await updateSetMappingsForMovedFiles(movedMap, custodyResult.sourceStats)
    if (
      [...movedMap.keys()].some((filePath) => isPathInside(filePath, getCuratedLibraryAbsRoot()))
    ) {
      notifyLibraryFsChanged()
    }
  }

  const protectedFiles = protectedPaths.map((filePath) => {
    const key = normalizeSetFilePathKey(filePath)
    const refs = refsByFile.get(key) || []
    const playlists = [...new Set(refs.map((r) => r.playlistName))]
    const failed = custodyFailures.find((f) => normalizeSetFilePathKey(f.filePath) === key)
    const movedTo = findMovedDestination(movedMap, filePath)
    return {
      filePath,
      movedTo: movedTo || filePath,
      playlists,
      success: !failed && !!movedTo,
      error: failed?.error
    }
  })

  return { protectedFiles, unprotectedFiles: unprotectedPaths }
}

export function registerSetListHandlers() {
  ipcMain.handle('setList:load-items', async (_e, playlistUuid: string) => {
    try {
      const items = listSetItemsByPlaylist(playlistUuid)
      if (items.length === 0) return { scanData: [], songListUUID: playlistUuid }

      const audioExts = store.settingConfig?.audioExt || []
      const existingPaths: string[] = []
      const missingIndices = new Set<number>()

      for (let i = 0; i < items.length; i++) {
        const absPath = path.isAbsolute(items[i].filePath)
          ? items[i].filePath
          : path.join(store.databaseDir || '', 'library', items[i].filePath)
        if (await fs.pathExists(absPath)) {
          existingPaths.push(absPath)
        } else {
          missingIndices.add(i)
        }
      }

      const scanned: ISongInfo[] = []
      if (existingPaths.length > 0) {
        const result = await scanSongList(existingPaths, audioExts, playlistUuid)
        scanned.push(...result.scanData)
      }

      const scanByPath = new Map<string, ISongInfo>()
      for (const song of scanned) {
        const normalized = normalizeSetFilePathKey(song.filePath)
        scanByPath.set(normalized, song)
      }

      const playlistRootByUuid = buildPlaylistRootByUuidMap()
      const ordered: ISongInfo[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (missingIndices.has(i)) {
          ordered.push(createMissingSetSong(item))
          continue
        }
        const absPath = path.isAbsolute(item.filePath)
          ? item.filePath
          : path.join(store.databaseDir || '', 'library', item.filePath)
        const normalized = normalizeSetFilePathKey(absPath)
        const scannedSong = scanByPath.get(normalized)
        if (!scannedSong) {
          ordered.push(createMissingSetSong(item))
          continue
        }
        ordered.push(
          await enrichSetSongFromSourceAnalysis(
            item,
            {
              ...scannedSong,
              setItemId: item.id,
              playlistTrackNumber: item.sortOrder,
              addedAtMs: normalizeAddedAtMs(item.createdAtMs)
            },
            playlistRootByUuid
          )
        )
      }

      return { scanData: ordered, songListUUID: playlistUuid }
    } catch (error) {
      log.error('[setList] load-items failed', error)
      return { scanData: [], songListUUID: playlistUuid }
    }
  })

  ipcMain.handle(
    'setList:append-items',
    async (
      _e,
      payload: {
        playlistUuid: string
        items: Array<{
          filePath: string
          originPlaylistUuid?: string | null
          originPathSnapshot?: string | null
          analysis?: Record<string, unknown> | null
        }>
      }
    ) => {
      try {
        assertLibraryMergeMutationAllowed()
        const { playlistUuid, items } = payload || {}
        if (!playlistUuid || !Array.isArray(items) || items.length === 0) {
          return []
        }
        return appendSetItems(
          playlistUuid,
          items.map((item) => ({
            filePath: item.filePath,
            originPlaylistUuid: item.originPlaylistUuid,
            originPathSnapshot: item.originPathSnapshot,
            analysis: buildSetAnalysisSnapshot(item.analysis || null)
          }))
        )
      } catch (error) {
        log.error('[setList] append-items failed', error)
        return []
      }
    }
  )

  ipcMain.handle('setList:remove-item', async (_e, id: string) => {
    try {
      assertLibraryMergeMutationAllowed()
      return await removeSetItemWithCustodyCleanup(id)
    } catch (error) {
      log.error('[setList] remove-item failed', error)
      return false
    }
  })

  ipcMain.handle('setList:remove-items', async (_e, ids: string[]) => {
    try {
      assertLibraryMergeMutationAllowed()
      return await removeSetItemsByIdsWithCustodyCleanup(ids)
    } catch (error) {
      log.error('[setList] remove-items failed', error)
      return 0
    }
  })

  ipcMain.handle('setList:clear-playlist', async (_e, playlistUuid: string) => {
    try {
      assertLibraryMergeMutationAllowed()
      return await removeSetItemsByPlaylistWithCustodyCleanup(playlistUuid)
    } catch (error) {
      log.error('[setList] clear playlist failed', error)
      return 0
    }
  })

  ipcMain.handle('setList:recycle-item-files', async (_e, ids: string[]) => {
    try {
      assertLibraryMergeMutationAllowed()
      return await recycleSetItemFilesAndRemoveItems(ids)
    } catch (error) {
      log.error('[setList] recycle item files failed', error)
      return { total: 0, success: 0, failed: 0, removedPaths: [], removedSetItemIds: [] }
    }
  })

  ipcMain.handle(
    'setList:reorder',
    async (_e, payload: { playlistUuid: string; orderedIds: string[] }) => {
      try {
        assertLibraryMergeMutationAllowed()
        const { playlistUuid, orderedIds } = payload || {}
        if (!playlistUuid || !Array.isArray(orderedIds)) {
          return false
        }
        const success = reorderSetPlaylistItems(playlistUuid, orderedIds)
        if (success) {
          normalizeSetItemOrder(playlistUuid)
        }
        return success
      } catch (error) {
        log.error('[setList] reorder failed', error)
        return false
      }
    }
  )

  ipcMain.handle('setList:count', async (_e, playlistUuid: string) => {
    try {
      return countSetItemsByPlaylist(playlistUuid)
    } catch (error) {
      log.error('[setList] count failed', error)
      return 0
    }
  })

  ipcMain.handle('setList:batchCount', async (_e, playlistUuids?: string[]) => {
    try {
      const uuids = Array.isArray(playlistUuids)
        ? playlistUuids.filter((uuid): uuid is string => typeof uuid === 'string' && !!uuid.trim())
        : []
      return countSetItemsByPlaylists(uuids)
    } catch (error) {
      log.error('[setList] batch count failed', error)
      return {}
    }
  })

  ipcMain.handle('setList:check-refs', async (_e, filePaths: string[]) => {
    try {
      const normalizedPaths = normalizeRequestedFilePaths(filePaths)
      return findSetReferencesForFiles(normalizedPaths)
    } catch (error) {
      log.error('[setList] check-refs failed', error)
      return []
    }
  })

  ipcMain.handle(
    'setList:protect-delete',
    async (_e, filePaths: string[]): Promise<SetDeleteProtectionResult> => {
      try {
        assertLibraryMergeMutationAllowed()
        return await protectSetReferencedFilesForDeletion(filePaths)
      } catch (error) {
        log.error('[setList] protect-delete failed', error)
        return { protectedFiles: [], unprotectedFiles: filePaths }
      }
    }
  )
}
