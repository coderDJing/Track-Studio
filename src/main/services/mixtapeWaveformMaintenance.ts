import path from 'node:path'
import fs = require('fs-extra')
import { clearTrackCache, findMixtapeCacheRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import { listMixtapeFilePathsInUse } from '../mixtapeDb'
import { getMixtapeVaultRootAbs, isUnderPath } from './libraryStemAssetStorage'
import { mainFilePathKey } from '../filePathComparison'

const normalizeUniquePaths = (values: unknown[]): string[] => {
  if (!Array.isArray(values)) return []
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  )
}

export async function cleanupMixtapeWaveformCache(filePaths: string[]): Promise<void> {
  const normalizedPaths = normalizeUniquePaths(filePaths)
  if (normalizedPaths.length === 0) return
  const inUse = new Set(
    listMixtapeFilePathsInUse(normalizedPaths).map((filePath) => mainFilePathKey(filePath))
  )
  const unused = normalizedPaths.filter((filePath) => !inUse.has(mainFilePathKey(filePath)))
  if (unused.length === 0) return

  for (const filePath of unused) {
    try {
      const listRoot = await findMixtapeCacheRoot(path.dirname(filePath))
      if (!listRoot) continue
      await LibraryCacheDb.removeMixtapeWaveformCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeMixtapeStemWaveformCacheByFilePath(listRoot, filePath)
    } catch {}
  }
}

export async function cleanupOrphanedMixtapeVaultFiles(filePaths: string[]): Promise<void> {
  const vaultRoot = getMixtapeVaultRootAbs()
  if (!vaultRoot) return
  const normalizedPaths = normalizeUniquePaths(filePaths).filter((filePath) =>
    isUnderPath(vaultRoot, filePath)
  )
  if (normalizedPaths.length === 0) return

  const inUse = new Set(
    listMixtapeFilePathsInUse(normalizedPaths).map((filePath) => mainFilePathKey(filePath))
  )
  const orphaned = normalizedPaths.filter((filePath) => !inUse.has(mainFilePathKey(filePath)))
  if (orphaned.length === 0) return

  for (const filePath of orphaned) {
    try {
      await clearTrackCache(filePath)
    } catch {}
    try {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath)
      }
    } catch {}
  }
}
