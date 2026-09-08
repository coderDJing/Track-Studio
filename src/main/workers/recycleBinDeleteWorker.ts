import { parentPort } from 'node:worker_threads'
import fs = require('fs-extra')
import path = require('node:path')
import store from '../store'
import { clearSongCacheAnalysisFields } from '../libraryCacheDb/songCache'
import { removeWaveformCacheEntry } from '../libraryCacheDb/waveformCache'
import { removeCompactVisualWaveformCacheEntry } from '../libraryCacheDb/compactVisualWaveformCache'
import { removeUnifiedDisplayWaveformCacheEntry } from '../libraryCacheDb/unifiedDisplayWaveformCache'
import { removeWaveformSurfaceCacheEntry } from '../libraryCacheDb/waveformSurfaceCache'
import { removeMixtapeWaveformCacheEntry } from '../libraryCacheDb/mixtapeWaveformCache'
import { removeMixtapeRawWaveformCacheEntry } from '../libraryCacheDb/mixtapeRawWaveformCache'
import { removeMixtapeStemWaveformCacheByFilePath } from '../libraryCacheDb/mixtapeStemWaveformCache'
import { countCoverIndexByHash, removeCoverIndexEntry } from '../libraryCacheDb/coverIndex'
import { removeMixtapeStemAssetsByFilePath } from '../mixtapeStemDb'

type DeleteEntry = {
  filePath: string
  listRoot: string
  originalPath?: string | null
  originalListRoot?: string | null
}

type WorkerRequest =
  | { id: number; type: 'scan'; rootPath: string }
  | { id: number; type: 'delete'; databaseDir: string; entries: DeleteEntry[] }
  | { id: number; type: 'remove-directories'; directories: string[] }

const scanDirectory = async (rootPath: string) => {
  const filePaths: string[] = []
  const directories: string[] = []
  const rootStat = await fs.stat(rootPath).catch(() => null)
  if (!rootStat?.isDirectory()) return { rootExists: false, filePaths, directories }
  const pending = [rootPath]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(entryPath)
        directories.push(entryPath)
      } else if (entry.isFile()) {
        filePaths.push(entryPath)
      }
    }
  }
  return { rootExists: true, filePaths, directories }
}

const deleteEntries = async (databaseDir: string, entries: DeleteEntry[]) => {
  store.databaseDir = databaseDir
  const results: Array<{ filePath: string; success: boolean; error?: string }> = []
  for (const entry of entries) {
    try {
      await clearTrackCaches(entry.listRoot, entry.filePath, databaseDir).catch(() => {})
      if (
        entry.originalPath &&
        entry.originalListRoot &&
        path.resolve(entry.originalPath) !== path.resolve(entry.filePath)
      ) {
        await purgeCoverCache(entry.originalListRoot, entry.originalPath).catch(() => {})
      }
      if (await fs.pathExists(entry.filePath)) await fs.remove(entry.filePath)
      results.push({ filePath: entry.filePath, success: true })
    } catch (error) {
      results.push({
        filePath: entry.filePath,
        success: false,
        error: error instanceof Error ? error.message : String(error || 'delete failed')
      })
    }
  }
  return results
}

const purgeCoverCache = async (listRoot: string, filePath: string) => {
  const removed = await removeCoverIndexEntry(listRoot, filePath)
  if (!removed) return
  const remaining = await countCoverIndexByHash(listRoot, removed.hash)
  if (remaining !== 0) return
  await fs.remove(path.join(listRoot, '.frkb_covers', `${removed.hash}${removed.ext || '.jpg'}`))
}

const removeStemAssetFiles = async (databaseDir: string, filePath: string) => {
  const libraryRoot = path.join(databaseDir, 'library')
  const cacheRoot = path.join(libraryRoot, '.frkb_cache', 'stems')
  const normalizedCacheRoot = path.resolve(cacheRoot)
  const assets = removeMixtapeStemAssetsByFilePath({ libraryRoot, filePath })
  const paths = assets.flatMap((asset) => [
    asset.vocalPath,
    asset.instPath,
    asset.bassPath,
    asset.drumsPath
  ])
  for (const assetPath of paths) {
    if (!assetPath) continue
    const resolved = path.resolve(assetPath)
    await fs.unlink(resolved).catch(() => {})
    const parent = path.dirname(resolved)
    if (parent.startsWith(`${normalizedCacheRoot}${path.sep}`)) {
      await fs.rmdir(parent).catch(() => {})
    }
  }
}

const clearTrackCaches = async (listRoot: string, filePath: string, databaseDir: string) => {
  await clearSongCacheAnalysisFields(listRoot, filePath)
  await removeWaveformCacheEntry(listRoot, filePath)
  await removeCompactVisualWaveformCacheEntry(listRoot, filePath)
  await removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
  await removeWaveformSurfaceCacheEntry(listRoot, filePath)
  await removeMixtapeWaveformCacheEntry(listRoot, filePath)
  await removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
  await removeMixtapeStemWaveformCacheByFilePath(listRoot, filePath)
  await purgeCoverCache(listRoot, filePath)
  await removeStemAssetFiles(databaseDir, filePath)
}

parentPort?.on('message', async (payload: WorkerRequest) => {
  try {
    if (payload.type === 'scan') {
      parentPort?.postMessage({ id: payload.id, result: await scanDirectory(payload.rootPath) })
      return
    }
    if (payload.type === 'remove-directories') {
      for (const directory of [...payload.directories].sort((a, b) => b.length - a.length)) {
        try {
          await fs.rmdir(directory)
        } catch {}
      }
      parentPort?.postMessage({ id: payload.id, result: true })
      return
    }
    parentPort?.postMessage({
      id: payload.id,
      result: await deleteEntries(payload.databaseDir, payload.entries)
    })
  } catch (error) {
    parentPort?.postMessage({
      id: payload.id,
      error: error instanceof Error ? error.message : String(error || 'recycle bin worker failed')
    })
  }
})
