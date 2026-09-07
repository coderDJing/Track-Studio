import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import store from '../store'
import {
  collectFilesWithExtensions,
  getCoreFsDirName,
  moveOrCopyItemWithCheckIsExist,
  resolveLibraryChildPath,
  resolveLibraryPath,
  runWithConcurrency,
  waitForUserDecision,
  getCurrentTimeYYYYMMDDHHMMSSSSS
} from '../utils'
import { log } from '../log'
import mainWindow from '../window/mainWindow'
import { exportSnapshot, importFromJsonFile } from '../fingerprintStore'
import { deleteRecycleBinRecord } from '../recycleBinDb'
import {
  isInRecycleBinAbsPath,
  moveFileToRecycleBin,
  normalizeRendererPlaylistPath,
  toLibraryRelativePath
} from '../recycleBinService'
import { findSongListRoot, transferTrackCaches } from '../services/cacheMaintenance'
import { replaceMixtapeFilePath } from '../mixtapeDb'
import { removeSetItemsByIds, updateSetItemFilePathReferences } from '../setListDb'
import { rememberCuratedArtistsForAddedTracks } from '../curatedArtistLibrary'
import { notifyCuratedFilePathChanged } from '../curatedLibrarySync/identityDb'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { remapKeyAnalysisTrackedPath } from '../services/keyAnalysisQueue'
import { protectSetReferencedFilesForDeletion } from './setListHandlers'
import {
  appendSongListTrackNumbers,
  compactSongListTrackNumbers,
  compactSongListTrackNumbersByFilePaths,
  isSupportedPlaylistTrackNumberListRoot
} from '../services/playlistTrackNumbers'
import { stampPlaylistSongsAddedAt } from '../services/playlistAddedAt'
import { scheduleCuratedLibrarySyncIfUnderCurated } from '../cloudSyncScheduler'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'

type MoveSongsToDirOptions = {
  mode?: 'copy' | 'move'
  curatedArtistNames?: Array<string | null | undefined>
  returnSummary?: boolean
}

type ExportSongInput = {
  filePath?: unknown
  setItemId?: unknown
}

type ExportTaskResult = {
  exportedPaths: string[]
  removedPaths: string[]
  removedSetItemIds: string[]
}

type ExportSongsSummary = {
  exportedPaths: string[]
  removedPaths: string[]
  removedSetItemIds: string[]
}

type ErrorSample = {
  code?: unknown
  message: string
  index: number
}

const toErrorSample = (result: unknown, index: number): ErrorSample | null => {
  if (!(result instanceof Error)) return null
  const error = result as Error & { code?: unknown }
  return { code: error.code, message: error.message, index }
}

const normalizeNonEmptyString = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  return value.trim()
}

const createExportTaskResult = (
  exportedPaths: string[],
  removedPaths: string[] = [],
  removedSetItemIds: string[] = []
): ExportTaskResult => ({
  exportedPaths,
  removedPaths,
  removedSetItemIds
})

const collectExportSummary = (results: Array<ExportTaskResult | Error>): ExportSongsSummary => {
  const summary: ExportSongsSummary = {
    exportedPaths: [],
    removedPaths: [],
    removedSetItemIds: []
  }
  for (const result of results) {
    if (result instanceof Error) continue
    summary.exportedPaths.push(...result.exportedPaths)
    summary.removedPaths.push(...result.removedPaths)
    summary.removedSetItemIds.push(...result.removedSetItemIds)
  }
  summary.exportedPaths = Array.from(new Set(summary.exportedPaths))
  summary.removedPaths = Array.from(new Set(summary.removedPaths))
  summary.removedSetItemIds = Array.from(new Set(summary.removedSetItemIds))
  return summary
}

const moveSourceToRecycleBinAfterExport = async (
  sourcePath: string,
  originalPlaylistPath: string | null
): Promise<void> => {
  const result = await moveFileToRecycleBin(sourcePath, {
    originalPlaylistPath,
    sourceType: 'export_after_delete'
  })
  if (result.status !== 'moved') {
    throw new Error(result.error || `move to recycle bin ${result.status}`)
  }
}

const removeSourceAfterExport = async (
  sourcePath: string,
  options: {
    originalPlaylistPath?: string | null
    setItemIds?: string[]
  } = {}
): Promise<{ removedPaths: string[]; removedSetItemIds: string[] }> => {
  const setItemIds = Array.isArray(options.setItemIds)
    ? Array.from(new Set(options.setItemIds.map(normalizeNonEmptyString).filter(Boolean)))
    : []
  if (setItemIds.length > 0) {
    await moveSourceToRecycleBinAfterExport(sourcePath, options.originalPlaylistPath ?? null)
    removeSetItemsByIds(setItemIds)
    return { removedPaths: [sourcePath], removedSetItemIds: setItemIds }
  }

  const setProtection = await protectSetReferencedFilesForDeletion([sourcePath])
  const protectedFile = setProtection.protectedFiles[0]
  if (protectedFile) {
    if (!protectedFile.success) {
      throw new Error(protectedFile.error || 'move to set custody failed')
    }
    return { removedPaths: [sourcePath], removedSetItemIds: [] }
  }

  await moveSourceToRecycleBinAfterExport(sourcePath, options.originalPlaylistPath ?? null)
  return { removedPaths: [sourcePath], removedSetItemIds: [] }
}

const copySourceForExport = async (sourcePath: string, targetPath: string): Promise<string> => {
  return await moveOrCopyItemWithCheckIsExist(sourcePath, targetPath, false)
}

const exportThenRemoveSource = async (
  sourcePath: string,
  targetPaths: string[],
  options: {
    originalPlaylistPath?: string | null
    setItemIds?: string[]
  } = {}
): Promise<ExportTaskResult> => {
  const exportedPaths: string[] = []
  for (const targetPath of targetPaths) {
    exportedPaths.push(await copySourceForExport(sourcePath, targetPath))
  }
  const removed = await removeSourceAfterExport(sourcePath, options)
  return createExportTaskResult(exportedPaths, removed.removedPaths, removed.removedSetItemIds)
}

async function findUniqueFolder(inputFolderPath: string) {
  const parts = path.parse(inputFolderPath)
  const dirPath = parts.dir
  const folderName = parts.name
  const baseCheckPath = path.join(dirPath, folderName)
  if (await fs.pathExists(baseCheckPath)) {
    let count = 1
    let newFolderPath
    do {
      newFolderPath = path.join(dirPath, `${folderName}(${count})`)
      count++
    } while (await fs.pathExists(newFolderPath))
    return newFolderPath
  }
  return inputFolderPath
}

export function registerExportHandlers() {
  ipcMain.handle('exportSongFingerprint', async (_e, folderPath) => {
    assertLibraryMergeMutationAllowed()
    const toPath = path.join(
      folderPath,
      'songFingerprint' + getCurrentTimeYYYYMMDDHHMMSSSSS() + '.json'
    )
    await exportSnapshot(toPath, store.songFingerprintList || [])
  })

  ipcMain.handle('importSongFingerprint', async (_e, filePath: string) => {
    assertLibraryMergeMutationAllowed()
    const merged = await importFromJsonFile(filePath)
    return merged
  })

  ipcMain.handle(
    'exportSongListToDir',
    async (_e, folderPathVal, deleteSongsAfterExport, dirPath) => {
      assertLibraryMergeMutationAllowed()
      const { absPath: scanPath } = resolveLibraryPath(dirPath)
      const songFileUrls = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)
      const folderName = path.basename(scanPath)
      const targetPath = await findUniqueFolder(path.join(folderPathVal, folderName))
      await fs.ensureDir(targetPath)
      const originalPlaylistPath = normalizeRendererPlaylistPath(dirPath)
      const tasks: Array<() => Promise<ExportTaskResult>> = []
      for (const item of songFileUrls) {
        const fileName = path.basename(item)
        if (fileName) {
          const dest = path.join(targetPath, fileName)
          tasks.push(() =>
            deleteSongsAfterExport
              ? exportThenRemoveSource(item, [dest], { originalPlaylistPath })
              : copySourceForExport(item, dest).then((exportedPath) =>
                  createExportTaskResult([exportedPath])
                )
          )
        }
      }
      const batchId = `exportSongList_${Date.now()}`
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('progressSet', {
          id: batchId,
          titleKey: 'tracks.copyingTracks',
          now: 0,
          total: tasks.length,
          isInitial: true
        })
      }
      const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
        concurrency: 16,
        onProgress: (done, total) => {
          if (mainWindow.instance) {
            mainWindow.instance.webContents.send('progressSet', {
              id: batchId,
              titleKey: 'tracks.copyingTracks',
              now: done,
              total
            })
          }
        },
        stopOnENOSPC: true,
        onInterrupted: async (payload) =>
          waitForUserDecision(mainWindow.instance ?? null, batchId, 'exportSongList', payload)
      })
      if (hasENOSPC && mainWindow.instance) {
        mainWindow.instance.webContents.send('file-batch-summary', {
          context: 'exportSongList',
          total: tasks.length,
          success,
          failed,
          hasENOSPC,
          skipped,
          errorSamples: results
            .map((r, i) => toErrorSample(r, i))
            .filter(Boolean)
            .slice(0, 3)
        })
      }
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('progressSet', {
          id: batchId,
          titleKey: 'tracks.copyingTracks',
          now: tasks.length,
          total: tasks.length
        })
      }
      if (
        deleteSongsAfterExport &&
        success > 0 &&
        isSupportedPlaylistTrackNumberListRoot(scanPath)
      ) {
        await compactSongListTrackNumbers(scanPath)
        markGlobalSongSearchDirty('exportSongListToDir')
      }
      const summary = collectExportSummary(results)
      if (failed > 0) {
        throw new Error('exportSongListToDir failed')
      }
      return summary
    }
  )

  ipcMain.handle('exportSongsToDir', async (_e, folderPathVal, deleteSongsAfterExport, songs) => {
    assertLibraryMergeMutationAllowed()
    const songItems: ExportSongInput[] = Array.isArray(songs) ? songs : []
    const tasks: Array<() => Promise<ExportTaskResult>> = []
    if (deleteSongsAfterExport) {
      const groups = new Map<
        string,
        {
          sourcePath: string
          targetPaths: string[]
          setItemIds: string[]
        }
      >()
      for (const item of songItems) {
        const sourcePath = normalizeNonEmptyString(item?.filePath)
        const fileName = path.basename(sourcePath)
        if (!fileName) continue
        const key = path.resolve(sourcePath).toLowerCase()
        const group = groups.get(key) || {
          sourcePath,
          targetPaths: [],
          setItemIds: []
        }
        group.targetPaths.push(path.join(folderPathVal, fileName))
        const setItemId = normalizeNonEmptyString(item?.setItemId)
        if (setItemId) group.setItemIds.push(setItemId)
        groups.set(key, group)
      }
      for (const group of groups.values()) {
        tasks.push(() =>
          exportThenRemoveSource(group.sourcePath, group.targetPaths, {
            setItemIds: group.setItemIds
          })
        )
      }
    } else {
      for (const item of songItems) {
        const sourcePath = normalizeNonEmptyString(item?.filePath)
        const fileName = path.basename(sourcePath)
        if (!fileName) continue
        const targetPath = path.join(folderPathVal, fileName)
        tasks.push(() =>
          copySourceForExport(sourcePath, targetPath).then((exportedPath) =>
            createExportTaskResult([exportedPath])
          )
        )
      }
    }
    const batchId = `exportSongs_${Date.now()}`
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'tracks.copyingTracks',
        now: 0,
        total: tasks.length,
        isInitial: true
      })
    }
    const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
      concurrency: 16,
      onProgress: (done, total) => {
        if (mainWindow.instance) {
          mainWindow.instance.webContents.send('progressSet', {
            id: batchId,
            titleKey: 'tracks.copyingTracks',
            now: done,
            total
          })
        }
      },
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(mainWindow.instance ?? null, batchId, 'exportSongs', payload)
    })
    if (hasENOSPC && mainWindow.instance) {
      mainWindow.instance.webContents.send('file-batch-summary', {
        context: 'exportSongs',
        total: tasks.length,
        success,
        failed,
        hasENOSPC,
        skipped,
        errorSamples: results
          .map((r, i) => toErrorSample(r, i))
          .filter(Boolean)
          .slice(0, 3)
      })
    }
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'tracks.copyingTracks',
        now: tasks.length,
        total: tasks.length
      })
    }
    const summary = collectExportSummary(results)
    if (deleteSongsAfterExport && success > 0) {
      const compactResult = await compactSongListTrackNumbersByFilePaths(summary.removedPaths)
      if (compactResult.roots > 0) {
        markGlobalSongSearchDirty('exportSongsToDir')
      }
      scheduleCuratedLibrarySyncIfUnderCurated(summary.removedPaths)
    }
    if (failed > 0) {
      throw new Error('exportSongsToDir failed')
    }
    return summary
  })

  ipcMain.handle('moveSongsToDir', async (_e, srcs, dest, options: MoveSongsToDirOptions = {}) => {
    assertLibraryMergeMutationAllowed()
    const isMove = options?.mode !== 'copy'
    const normalizeRelativePath = (value: string) => value.replace(/\\/g, '/')
    const target = resolveLibraryPath(dest)
    const targetDir = normalizeRelativePath(target.mappedPath)
    const curatedRoot = normalizeRelativePath(
      path.join('library', getCoreFsDirName('CuratedLibrary'))
    )
    const isCuratedTarget = targetDir === curatedRoot || targetDir.startsWith(`${curatedRoot}/`)
    const targetListRoot = target.absPath
    const tasks: Array<() => Promise<string>> = []
    const taskSourcePaths: string[] = []
    for (const src of srcs) {
      const filename = path.basename(String(src || ''))
      if (filename) {
        const targetPath = resolveLibraryChildPath(target.absPath, filename)
        taskSourcePaths.push(String(src))
        tasks.push(async () => {
          const movedPath = await moveOrCopyItemWithCheckIsExist(src, targetPath, isMove)
          if (isMove) {
            try {
              remapKeyAnalysisTrackedPath(src, movedPath)
              replaceMixtapeFilePath(src, movedPath)
              updateSetItemFilePathReferences(src, movedPath)
            } catch (error) {
              log.error('[moveSongsToDir] 移动后引用重映射失败', { src, movedPath, error })
            }
          }
          try {
            const fromRoot = await findSongListRoot(path.dirname(src))
            const toRoot = await findSongListRoot(path.dirname(movedPath))
            await transferTrackCaches({
              fromRoot,
              toRoot,
              fromPath: src,
              toPath: movedPath,
              mode: isMove ? 'move' : 'copy'
            })
          } catch (error) {
            log.error('[moveSongsToDir] 分析结果迁移失败', { src, movedPath, error })
          }
          if (isMove) {
            if (isInRecycleBinAbsPath(src)) {
              const rel = toLibraryRelativePath(src)
              if (rel) deleteRecycleBinRecord(rel)
            }
          }
          return movedPath
        })
      }
    }
    const batchId = `${isMove ? 'moveSongs' : 'copySongs'}_${Date.now()}`
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: isMove ? 'tracks.movingTracks' : 'tracks.copyingTracks',
        now: 0,
        total: tasks.length,
        isInitial: true
      })
    }
    const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
      concurrency: 16,
      onProgress: (done, total) => {
        if (mainWindow.instance) {
          mainWindow.instance.webContents.send('progressSet', {
            id: batchId,
            titleKey: isMove ? 'tracks.movingTracks' : 'tracks.copyingTracks',
            now: done,
            total
          })
        }
      },
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(
          mainWindow.instance ?? null,
          batchId,
          isMove ? 'moveSongs' : 'copySongs',
          payload
        )
    })
    for (const item of results) {
      if (item instanceof Error) {
        log.error(isMove ? '[moveSongsToDir] 任务失败' : '[copySongsToDir] 任务失败', item)
      }
    }
    if (hasENOSPC && mainWindow.instance) {
      mainWindow.instance.webContents.send('file-batch-summary', {
        context: isMove ? 'moveSongs' : 'copySongs',
        total: tasks.length,
        success,
        failed,
        hasENOSPC,
        skipped,
        errorSamples: results
          .map((r, i) => toErrorSample(r, i))
          .filter(Boolean)
          .slice(0, 3)
      })
    }
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: isMove ? 'tracks.movingTracks' : 'tracks.copyingTracks',
        now: tasks.length,
        total: tasks.length
      })
    }
    const movedEntries = results.flatMap((item, index) => {
      const sourcePath = taskSourcePaths[index]
      if (typeof item !== 'string' || !sourcePath) return []
      return [{ sourcePath, targetPath: item }]
    })
    const movedPaths = movedEntries.map((item) => item.targetPath)
    if (isMove) {
      for (const entry of movedEntries) {
        try {
          notifyCuratedFilePathChanged(entry.sourcePath, entry.targetPath)
        } catch {}
      }
    }
    if (movedPaths.length > 0 && isSupportedPlaylistTrackNumberListRoot(targetListRoot)) {
      await appendSongListTrackNumbers({
        listRoot: targetListRoot,
        appendedFilePaths: movedPaths
      })
    }
    await stampPlaylistSongsAddedAt({
      listRoot: targetListRoot,
      filePaths: movedPaths
    })
    if (isMove) {
      const sourceRoots = new Set<string>()
      for (const src of srcs) {
        const sourceRoot = await findSongListRoot(path.dirname(String(src || '').trim()))
        if (!sourceRoot || !isSupportedPlaylistTrackNumberListRoot(sourceRoot)) continue
        if (path.resolve(sourceRoot) === path.resolve(targetListRoot)) continue
        sourceRoots.add(sourceRoot)
      }
      for (const sourceRoot of sourceRoots) {
        await compactSongListTrackNumbers(sourceRoot)
      }
    }
    if (movedPaths.length > 0) {
      markGlobalSongSearchDirty(isMove ? 'moveSongsToDir' : 'copySongsToDir')
    }
    scheduleCuratedLibrarySyncIfUnderCurated([target.absPath, ...taskSourcePaths, ...movedPaths])
    if (failed > 0 && !options.returnSummary) {
      throw new Error(isMove ? 'moveSongsToDir failed' : 'copySongsToDir failed')
    }
    if (isCuratedTarget) {
      const curatedArtistTracks: Array<{
        artistName?: string
        targetPath?: string
      }> = []
      for (let index = 0; index < movedPaths.length; index += 1) {
        const result = movedPaths[index]
        const movedPath = String(result || '').trim()
        if (!movedPath) continue
        const artistHint = String(options?.curatedArtistNames?.[index] || '').trim()
        curatedArtistTracks.push({
          artistName: artistHint || undefined,
          targetPath: movedPath
        })
      }
      // 记录精选表演者是附加能力，不能卡住主移动流程和前端列表刷新。
      // 这里同时带上目标路径，后续会尝试补算原始指纹；若补算失败，再退回 UI 传来的 artist hint。
      void rememberCuratedArtistsForAddedTracks({
        tracks: curatedArtistTracks
      }).catch((error) => {
        log.error('[curatedArtists] remember after move failed', error)
      })
    }
    if (options.returnSummary) {
      return { movedEntries, failed }
    }
    return movedPaths
  })
}
