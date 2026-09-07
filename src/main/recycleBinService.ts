import path = require('path')
import fs = require('fs-extra')
import store from './store'
import { getCoreFsDirName, mapRendererPathToFsPath, resolveLibraryPath } from './utils'
import { log } from './log'
import {
  listRecycleBinRecords,
  getRecycleBinRecord,
  upsertRecycleBinRecord,
  deleteRecycleBinRecord,
  type RecycleBinRecord
} from './recycleBinDb'
import {
  clearTrackCache,
  findSongListRoot,
  purgeCoverCacheForTrack,
  transferTrackCaches
} from './services/cacheMaintenance'
import { findSongListRootByPath } from './libraryTreeDb'
import { stampPlaylistSongsAddedAt } from './services/playlistAddedAt'
import {
  findCuratedSyncFileByAbsPath,
  notifyCuratedFilePathChanged
} from './curatedLibrarySync/identityDb'
import { getCuratedLibraryAbsRoot, isPathInside } from './curatedLibrarySync/paths'
import { notifyLibraryFsChanged } from './libraryTreeWatcher'
import { invalidateKeyAnalysisCache } from './services/keyAnalysisQueue'
import { listMixtapeItemsByFilePath, replaceMixtapeFilePath } from './mixtapeDb'
import { replaceMixtapeStemAssetFilePath } from './mixtapeStemDb'
import { updateSetItemFilePathReferences } from './setListDb'
import { runPlaybackAwareBackgroundFileIo } from './services/playbackForegroundActivity'

type RecycleBinSourceType = 'external' | 'import_dedup' | 'unknown'

type RecycleBinMoveOptions = {
  originalPlaylistPath?: string | null
  sourceType?: RecycleBinSourceType | string | null
  deletedAtMs?: number
  originalFileName?: string | null
  fileId?: string | null
  contentSha256?: string | null
  contentSize?: number | null
}

export type RecycleBinMoveResult = {
  status: 'moved' | 'skipped' | 'failed'
  srcPath: string
  destPath?: string
  destRelativePath?: string
  error?: string
}

type RecycleBinRestoreResult = {
  status: 'restored' | 'missing_playlist' | 'missing_record' | 'missing_file' | 'failed'
  srcPath: string
  destPath?: string
  error?: string
  playlistPath?: string | null
}

type RecordLookup = { record: RecycleBinRecord | null; recordKey: string | null }
type ErrorLike = { code?: unknown; message?: unknown }

const MIXTAPE_VAULT_DIR_NAME = '.mixtape_vault'
const UNIQUE_MOVE_MAX_ATTEMPTS = 64

export type MixtapeMissingResolveSource = 'recycle_bin' | 'mixtape_vault'

type MixtapeMissingResolveResult = {
  resolvedPath: string
  source: MixtapeMissingResolveSource
}

function getLibraryRootAbs(): string | null {
  const root = store.databaseDir
  if (!root) return null
  return path.join(root, 'library')
}

export function getRecycleBinRootAbs(): string | null {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot) return null
  return path.join(libraryRoot, getCoreFsDirName('RecycleBin'))
}

export function getMixtapeVaultRootAbs(): string | null {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot) return null
  return path.join(libraryRoot, getCoreFsDirName('MixtapeLibrary'), MIXTAPE_VAULT_DIR_NAME)
}

function normalizePathForCompare(value: string): string {
  const normalized = path.resolve(String(value || ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeRelativePathForCompare(value: string): string {
  const normalized = path.normalize(String(value || '')).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeNameForCompare(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function getRecordAbsPath(record: RecycleBinRecord, libraryRoot: string): string {
  if (path.isAbsolute(record.filePath)) return record.filePath
  return path.join(libraryRoot, record.filePath)
}

export function toLibraryRelativePath(absPath: string): string | null {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot || !absPath) return null
  const rel = path.relative(libraryRoot, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

export function normalizeRendererPlaylistPath(rendererPath: string): string | null {
  if (!rendererPath) return null
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot) return null
  const mapped = mapRendererPathToFsPath(rendererPath)
  let absPath = ''
  try {
    absPath = path.isAbsolute(mapped) ? mapped : resolveLibraryPath(rendererPath).absPath
  } catch {
    return null
  }
  const rel = path.relative(libraryRoot, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

async function resolveOriginalPlaylistPathForFile(filePath: string): Promise<string | null> {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot || !filePath) return null
  try {
    const listRoot = await findSongListRootByPath(path.dirname(filePath))
    if (listRoot) {
      const rel = path.relative(libraryRoot, listRoot)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel
    }
  } catch {}
  const fallback = path.relative(libraryRoot, path.dirname(filePath))
  if (!fallback || fallback.startsWith('..') || path.isAbsolute(fallback)) return null
  return fallback
}

export function isInRecycleBinAbsPath(absPath: string): boolean {
  const recycleRoot = getRecycleBinRootAbs()
  if (!recycleRoot || !absPath) return false
  const normalized = path.resolve(absPath)
  const normalizedRoot = path.resolve(recycleRoot)
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep)
}

function parseRenameSeed(baseName: string): { stem: string; index: number | null } {
  const match = String(baseName).match(/^(.*?)(?:\s*\((\d+)\))?$/)
  if (!match) return { stem: baseName, index: null }
  const stem = match[1] ? String(match[1]).trimEnd() : ''
  const index = match[2] ? Number(match[2]) : null
  return { stem: stem || baseName, index: Number.isFinite(index) ? index : null }
}

async function resolveUniqueFileName(dirPath: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  const { stem, index } = parseRenameSeed(base)
  const candidate = path.join(dirPath, fileName)
  if (!(await fs.pathExists(candidate))) return fileName
  let counter = index && index > 0 ? index + 1 : 1
  while (true) {
    const nextName = `${stem}(${counter})${ext}`
    if (!(await fs.pathExists(path.join(dirPath, nextName)))) {
      return nextName
    }
    counter += 1
  }
}

function resolveRecordByPath(filePath: string): RecordLookup {
  if (!filePath) return { record: null, recordKey: null }
  const rel = toLibraryRelativePath(filePath)
  if (rel) {
    const rec = getRecycleBinRecord(rel)
    if (rec) return { record: rec, recordKey: rel }
  }
  const direct = getRecycleBinRecord(filePath)
  if (direct) return { record: direct, recordKey: filePath }
  return { record: null, recordKey: rel || filePath }
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  const maybeError = error && typeof error === 'object' ? (error as ErrorLike) : null
  return String(maybeError?.message || error || '')
}

function isDestinationAlreadyExistsError(error: unknown): boolean {
  const maybeError = error && typeof error === 'object' ? (error as ErrorLike) : null
  const code = String(maybeError?.code || '').toUpperCase()
  if (code === 'EEXIST') return true
  return /dest already exists/i.test(getErrorMessage(error))
}

async function moveFileToUniqueDestination(
  srcPath: string,
  destDir: string,
  desiredName: string
): Promise<string> {
  const sanitizedName =
    path.basename((desiredName || path.basename(srcPath)).trim()) || path.basename(srcPath)
  const directDestPath = path.join(destDir, sanitizedName)
  if (normalizePathForCompare(srcPath) === normalizePathForCompare(directDestPath)) {
    return directDestPath
  }

  for (let attempt = 0; attempt < UNIQUE_MOVE_MAX_ATTEMPTS; attempt += 1) {
    const targetName = await resolveUniqueFileName(destDir, sanitizedName)
    const destPath = path.join(destDir, targetName)
    try {
      await runPlaybackAwareBackgroundFileIo(
        'recycle-bin:fs-move',
        {
          srcPath,
          destPath
        },
        () => fs.move(srcPath, destPath, { overwrite: false })
      )
      return destPath
    } catch (error) {
      if (!isDestinationAlreadyExistsError(error) || !(await fs.pathExists(srcPath))) {
        throw error
      }
    }
  }

  throw new Error('unable to allocate unique destination path')
}

function syncMixtapeFilePathReference(fromPath: string, toPath: string): number {
  const sourcePath = typeof fromPath === 'string' ? fromPath.trim() : ''
  const targetPath = typeof toPath === 'string' ? toPath.trim() : ''
  if (!sourcePath || !targetPath) return 0
  if (normalizePathForCompare(sourcePath) === normalizePathForCompare(targetPath)) return 0
  const result = replaceMixtapeFilePath(sourcePath, targetPath)
  const libraryRoot = getLibraryRootAbs()
  if (libraryRoot) {
    replaceMixtapeStemAssetFilePath({
      libraryRoot,
      oldFilePath: sourcePath,
      newFilePath: targetPath
    })
  }
  return result.updated
}

function syncSetFilePathReference(fromPath: string, toPath: string): number {
  const sourcePath = typeof fromPath === 'string' ? fromPath.trim() : ''
  const targetPath = typeof toPath === 'string' ? toPath.trim() : ''
  if (!sourcePath || !targetPath) return 0
  if (normalizePathForCompare(sourcePath) === normalizePathForCompare(targetPath)) return 0
  return updateSetItemFilePathReferences(sourcePath, targetPath)
}

async function resolveMissingFromRecycleBin(missingPath: string): Promise<string | null> {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot || !missingPath) return null
  const records = listRecycleBinRecords()
  if (!records.length) return null

  const targetAbs = normalizePathForCompare(missingPath)
  const targetBaseName = normalizeNameForCompare(path.basename(missingPath))
  const targetRel = toLibraryRelativePath(missingPath)
  const targetRelNormalized = targetRel ? normalizeRelativePathForCompare(targetRel) : ''
  const targetDirRelNormalized = targetRel
    ? normalizeRelativePathForCompare(path.dirname(targetRel))
    : ''

  const candidates: Array<{ absPath: string; score: number; deletedAtMs: number }> = []
  for (const record of records) {
    const recordPath = typeof record.filePath === 'string' ? record.filePath.trim() : ''
    if (!recordPath) continue
    const absPath = getRecordAbsPath(record, libraryRoot)
    if (!(await fs.pathExists(absPath))) continue

    let score = 0
    const recordAbsNormalized = normalizePathForCompare(absPath)
    if (recordAbsNormalized === targetAbs) score += 240

    const recordFileName = normalizeNameForCompare(path.basename(recordPath))
    const originalFileName = normalizeNameForCompare(record.originalFileName || '')
    if (originalFileName && originalFileName === targetBaseName) score += 120
    if (recordFileName && recordFileName === targetBaseName) score += 80

    const originalPlaylistPath = record.originalPlaylistPath
      ? normalizeRelativePathForCompare(record.originalPlaylistPath)
      : ''
    if (targetDirRelNormalized && originalPlaylistPath === targetDirRelNormalized) {
      score += 60
    }
    if (targetRelNormalized && originalPlaylistPath && originalFileName) {
      const rebuilt = normalizeRelativePathForCompare(
        path.join(record.originalPlaylistPath || '', record.originalFileName || '')
      )
      if (rebuilt === targetRelNormalized) score += 180
    }

    if (score <= 0) continue
    candidates.push({
      absPath,
      score,
      deletedAtMs: Number(record.deletedAtMs) || 0
    })
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.deletedAtMs - a.deletedAtMs
  })
  return candidates[0]?.absPath || null
}

async function resolveMissingFromMixtapeVault(missingPath: string): Promise<string | null> {
  const vaultRoot = getMixtapeVaultRootAbs()
  if (!vaultRoot || !missingPath) return null
  if (!(await fs.pathExists(vaultRoot))) return null

  const targetFileName = path.basename(missingPath)
  if (targetFileName) {
    const exactPath = path.join(vaultRoot, targetFileName)
    if (await fs.pathExists(exactPath)) return exactPath
  }

  const targetExt = path.extname(targetFileName).toLowerCase()
  const targetStem = normalizeNameForCompare(
    parseRenameSeed(path.basename(targetFileName, targetExt)).stem
  )
  const targetName = normalizeNameForCompare(targetFileName)

  let entries: fs.Dirent[] = []
  try {
    entries = await fs.readdir(vaultRoot, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates: Array<{ absPath: string; score: number; mtimeMs: number }> = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const absPath = path.join(vaultRoot, entry.name)
    const ext = path.extname(entry.name).toLowerCase()
    const stem = normalizeNameForCompare(parseRenameSeed(path.basename(entry.name, ext)).stem)
    const nameNormalized = normalizeNameForCompare(entry.name)

    let score = 0
    if (nameNormalized && nameNormalized === targetName) score += 220
    if (targetExt && ext === targetExt) score += 40
    if (targetStem && stem === targetStem) score += 130
    if (score <= 0) continue

    const stat = await fs.stat(absPath).catch(() => null)
    candidates.push({
      absPath,
      score,
      mtimeMs: stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0
    })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.mtimeMs - a.mtimeMs
  })
  return candidates[0]?.absPath || null
}

export async function resolveMissingMixtapeFilePath(
  missingPath: string
): Promise<MixtapeMissingResolveResult | null> {
  const normalizedPath = typeof missingPath === 'string' ? missingPath.trim() : ''
  if (!normalizedPath) return null
  if (await fs.pathExists(normalizedPath)) {
    return null
  }
  const recyclePath = await resolveMissingFromRecycleBin(normalizedPath)
  if (recyclePath) {
    return {
      resolvedPath: recyclePath,
      source: 'recycle_bin'
    }
  }
  const vaultPath = await resolveMissingFromMixtapeVault(normalizedPath)
  if (vaultPath) {
    return {
      resolvedPath: vaultPath,
      source: 'mixtape_vault'
    }
  }
  return null
}

async function moveReferencedMixtapeFileToVault(
  srcPath: string,
  preferredName?: string | null
): Promise<{ moved: boolean; destPath?: string; error?: string }> {
  const sourcePath = typeof srcPath === 'string' ? srcPath.trim() : ''
  if (!sourcePath) return { moved: false, error: 'invalid source path' }
  const vaultRoot = getMixtapeVaultRootAbs()
  if (!vaultRoot) return { moved: false, error: 'vault root unavailable' }
  if (!(await fs.pathExists(sourcePath))) {
    return { moved: false, error: 'source file missing' }
  }
  await fs.ensureDir(vaultRoot)
  const desiredNameRaw =
    (preferredName || path.basename(sourcePath)).trim() || path.basename(sourcePath)
  const desiredName = path.basename(desiredNameRaw)
  const destPath = await moveFileToUniqueDestination(sourcePath, vaultRoot, desiredName)
  try {
    invalidateKeyAnalysisCache([sourcePath, destPath])
  } catch {}
  syncMixtapeFilePathReference(sourcePath, destPath)
  syncSetFilePathReference(sourcePath, destPath)
  return { moved: true, destPath }
}

export async function moveFileToRecycleBin(
  srcPath: string,
  options: RecycleBinMoveOptions = {}
): Promise<RecycleBinMoveResult> {
  const recycleRoot = getRecycleBinRootAbs()
  const libraryRoot = getLibraryRootAbs()
  if (!recycleRoot || !libraryRoot || !srcPath) {
    return { status: 'failed', srcPath, error: 'recycle bin root unavailable' }
  }
  const sourceListRoot = await findSongListRoot(path.dirname(srcPath))
  const fromCurated = isPathInside(srcPath, getCuratedLibraryAbsRoot())
  try {
    if (!(await fs.pathExists(srcPath))) {
      return { status: 'skipped', srcPath }
    }
    await fs.ensureDir(recycleRoot)
    const originalFileName = options.originalFileName || path.basename(srcPath)
    const destPath = await moveFileToUniqueDestination(srcPath, recycleRoot, originalFileName)
    try {
      await runPlaybackAwareBackgroundFileIo(
        'recycle-bin:transfer-track-caches',
        {
          srcPath,
          destPath
        },
        () =>
          transferTrackCaches({
            fromRoot: sourceListRoot,
            toRoot: recycleRoot,
            fromPath: srcPath,
            toPath: destPath
          })
      )
    } catch {}
    try {
      invalidateKeyAnalysisCache([srcPath, destPath])
    } catch {}
    const rel = toLibraryRelativePath(destPath)
    if (!rel) {
      return { status: 'failed', srcPath, destPath, error: 'invalid recycle bin path' }
    }
    const hasOriginalPlaylistPath = Object.prototype.hasOwnProperty.call(
      options,
      'originalPlaylistPath'
    )
    const originalPlaylistPath = hasOriginalPlaylistPath
      ? (options.originalPlaylistPath ?? null)
      : await resolveOriginalPlaylistPathForFile(srcPath)
    const identity = findCuratedSyncFileByAbsPath(srcPath)
    upsertRecycleBinRecord({
      filePath: rel,
      deletedAtMs: options.deletedAtMs ?? Date.now(),
      originalPlaylistPath: originalPlaylistPath ?? null,
      originalFileName: originalFileName ?? null,
      sourceType: options.sourceType ?? null,
      fileId: options.fileId || identity?.fileId || null,
      contentSha256: options.contentSha256 || identity?.contentSha256 || null,
      contentSize: options.contentSize ?? identity?.contentSize ?? null
    })
    syncMixtapeFilePathReference(srcPath, destPath)
    try {
      notifyCuratedFilePathChanged(srcPath, destPath)
    } catch {}
    if (fromCurated) {
      try {
        notifyLibraryFsChanged(destPath)
      } catch {}
    }
    return { status: 'moved', srcPath, destPath, destRelativePath: rel }
  } catch (error) {
    log.error('[recycleBin] move failed', { srcPath, error })
    return { status: 'failed', srcPath, error: getErrorMessage(error) }
  }
}

export async function restoreRecycleBinFile(filePath: string): Promise<RecycleBinRestoreResult> {
  if (!filePath) return { status: 'missing_record', srcPath: filePath }
  const recycleRoot = getRecycleBinRootAbs()
  const libraryRoot = getLibraryRootAbs()
  if (!recycleRoot || !libraryRoot) {
    return { status: 'failed', srcPath: filePath, error: 'recycle bin root unavailable' }
  }
  const { record, recordKey } = resolveRecordByPath(filePath)
  if (!record) return { status: 'missing_record', srcPath: filePath }
  const srcPath = path.isAbsolute(filePath) ? filePath : path.join(libraryRoot, record.filePath)
  try {
    if (!(await fs.pathExists(srcPath))) {
      if (recordKey) deleteRecycleBinRecord(recordKey)
      return { status: 'missing_file', srcPath }
    }
    const playlistRel = record.originalPlaylistPath
    if (!playlistRel) {
      return { status: 'missing_playlist', srcPath, playlistPath: null }
    }
    const destDir = path.join(libraryRoot, playlistRel)
    const destDirStat = await fs.stat(destDir).catch(() => null)
    if (!destDirStat || !destDirStat.isDirectory()) {
      return { status: 'missing_playlist', srcPath, playlistPath: playlistRel }
    }
    const desiredName = record.originalFileName || path.basename(srcPath)
    const destPath = await moveFileToUniqueDestination(srcPath, destDir, desiredName)
    try {
      await transferTrackCaches({
        fromRoot: recycleRoot,
        toRoot: destDir,
        fromPath: srcPath,
        toPath: destPath
      })
    } catch {}
    await stampPlaylistSongsAddedAt({
      listRoot: destDir,
      filePaths: [destPath]
    })
    try {
      invalidateKeyAnalysisCache([srcPath, destPath])
    } catch {}
    syncMixtapeFilePathReference(srcPath, destPath)
    syncSetFilePathReference(srcPath, destPath)
    if (recordKey) deleteRecycleBinRecord(recordKey)
    try {
      notifyCuratedFilePathChanged(srcPath, destPath)
    } catch {}
    if (isPathInside(destPath, getCuratedLibraryAbsRoot())) {
      try {
        notifyLibraryFsChanged(destPath)
      } catch {}
    }
    return { status: 'restored', srcPath, destPath, playlistPath: playlistRel }
  } catch (error) {
    log.error('[recycleBin] restore failed', { srcPath, error })
    return { status: 'failed', srcPath, error: getErrorMessage(error) }
  }
}

export async function permanentlyDeleteFile(filePath: string): Promise<boolean> {
  if (!filePath) return false
  const { record, recordKey } = resolveRecordByPath(filePath)
  const libraryRoot = getLibraryRootAbs()
  const srcPath = path.isAbsolute(filePath)
    ? filePath
    : libraryRoot
      ? path.join(libraryRoot, record?.filePath || filePath)
      : filePath
  let mixtapeRefs = listMixtapeItemsByFilePath(srcPath)
  let legacyRefPath = ''
  if (
    mixtapeRefs.length === 0 &&
    record?.originalPlaylistPath &&
    record?.originalFileName &&
    libraryRoot
  ) {
    const originalPath = path.join(
      libraryRoot,
      record.originalPlaylistPath,
      record.originalFileName
    )
    const legacyRefs = listMixtapeItemsByFilePath(originalPath)
    if (legacyRefs.length > 0) {
      mixtapeRefs = legacyRefs
      legacyRefPath = originalPath
    }
  }
  if (mixtapeRefs.length > 0) {
    try {
      const moveResult = await moveReferencedMixtapeFileToVault(
        srcPath,
        record?.originalFileName || null
      )
      if (!moveResult.moved) {
        if (moveResult.error === 'source file missing') {
          if (recordKey) {
            deleteRecycleBinRecord(recordKey)
          }
          return true
        }
        log.error('[recycleBin] move referenced mixtape file to vault failed', {
          filePath: srcPath,
          error: moveResult.error || 'unknown error'
        })
        return false
      }
      if (legacyRefPath && moveResult.destPath) {
        syncMixtapeFilePathReference(legacyRefPath, moveResult.destPath)
        syncSetFilePathReference(legacyRefPath, moveResult.destPath)
      }
      if (recordKey) {
        deleteRecycleBinRecord(recordKey)
      }
      return true
    } catch (error) {
      log.error('[recycleBin] move referenced mixtape file to vault failed', {
        filePath: srcPath,
        error
      })
      return false
    }
  }
  try {
    await clearTrackCache(srcPath)
  } catch {}
  if (record?.originalPlaylistPath && record?.originalFileName && libraryRoot) {
    const originalPath = path.join(
      libraryRoot,
      record.originalPlaylistPath,
      record.originalFileName
    )
    if (path.resolve(originalPath) !== path.resolve(srcPath)) {
      try {
        await purgeCoverCacheForTrack(originalPath)
      } catch {}
    }
  }
  try {
    if (await fs.pathExists(srcPath)) {
      await fs.remove(srcPath)
    }
  } catch (error) {
    log.error('[recycleBin] delete file failed', { filePath: srcPath, error })
    return false
  }
  if (recordKey) {
    deleteRecycleBinRecord(recordKey)
  }
  return true
}
