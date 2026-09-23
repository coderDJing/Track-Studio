import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeLibraryDb, initLibraryDb } from '../libraryDb'
import store from '../store'
import {
  loadExternalAnalysisCacheEntry,
  reconcileExternalAnalysisCacheEntries,
  registerExternalAnalysisContext,
  resolveExternalAnalysisContext,
  unregisterExternalAnalysisContexts,
  upsertExternalAnalysisCacheEntry
} from './externalAnalysisCache'

const temporaryRoots: string[] = []
const previousDatabaseDir = store.databaseDir

const createLibraryRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-external-analysis-'))
  temporaryRoots.push(root)
  await fs.mkdir(path.join(root, 'library'), { recursive: true })
  store.databaseDir = root
  expect(initLibraryDb(root)).not.toBeNull()
  return root
}

afterEach(async () => {
  closeLibraryDb()
  store.databaseDir = previousDatabaseDir
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('reconcileExternalAnalysisCacheEntries', () => {
  it('keeps current Serato tracks and removes tracks deleted from the full library snapshot', async () => {
    const root = await createLibraryRoot()
    const sourceId = 'external-library:serato'
    const keptPath = path.join(root, 'music', 'kept.mp3')
    const removedPath = path.join(root, 'music', 'removed.mp3')
    const keptContext = registerExternalAnalysisContext({
      sourceKind: 'external-playback',
      sourceId,
      rootPath: root,
      relativePath: 'abs:kept.mp3',
      filePath: keptPath
    })
    const removedContext = registerExternalAnalysisContext({
      sourceKind: 'external-playback',
      sourceId,
      rootPath: root,
      relativePath: 'abs:removed.mp3',
      filePath: removedPath
    })
    expect(keptContext).not.toBeNull()
    expect(removedContext).not.toBeNull()
    if (!keptContext || !removedContext) throw new Error('external context fixture failed')

    const makeInfo = (filePath: string) => ({
      filePath,
      fileName: path.basename(filePath),
      fileFormat: 'MP3',
      cover: null,
      title: path.basename(filePath, '.mp3'),
      artist: undefined,
      album: undefined,
      duration: '03:00',
      genre: undefined,
      label: undefined,
      bitrate: undefined,
      container: 'MPEG'
    })
    await upsertExternalAnalysisCacheEntry(
      keptContext,
      { size: 10, mtimeMs: 100 },
      makeInfo(keptPath)
    )
    await upsertExternalAnalysisCacheEntry(
      removedContext,
      { size: 20, mtimeMs: 200 },
      makeInfo(removedPath)
    )

    const removed = await reconcileExternalAnalysisCacheEntries('external-playback', sourceId, [
      { relativePath: keptContext.relativePath, filePath: keptPath }
    ])

    expect(removed).toBe(1)
    expect(await loadExternalAnalysisCacheEntry(keptContext)).not.toBeNull()
    expect(await loadExternalAnalysisCacheEntry(removedContext)).toBeNull()
    expect(resolveExternalAnalysisContext(keptPath)).not.toBeNull()
    expect(resolveExternalAnalysisContext(removedPath)).toBeNull()
    unregisterExternalAnalysisContexts([keptPath, removedPath])
  })
})
