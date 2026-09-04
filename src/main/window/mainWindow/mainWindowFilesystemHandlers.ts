import { ipcMain, shell, type BrowserWindow } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import store from '../../store'
import { log } from '../../log'
import {
  collectFilesWithExtensions,
  resolveLibraryPath,
  resolveLibraryChildPath,
  getCoreFsDirName,
  runWithConcurrency,
  waitForUserDecision
} from '../../utils'
import { transferTrackCaches } from '../../services/cacheMaintenance'
import { scheduleCuratedLibrarySyncIfUnderCurated } from '../../cloudSyncScheduler'
import { getNodeAbsPath } from '../../curatedLibrarySync/paths'
import { rememberCuratedLibraryNodeDeletion } from '../../curatedLibrarySync/pendingDeletedNodes'
import {
  cleanupMixtapeWaveformCache,
  cleanupOrphanedMixtapeVaultFiles
} from '../../services/mixtapeWaveformMaintenance'
import { renameCacheRoot } from '../../libraryCacheDb'
import type { FileSystemOperation } from '@shared/fileSystemOperation'
import {
  findLibraryNodeByPath,
  insertLibraryNode,
  loadLibraryNodes,
  moveLibraryNode,
  removeLibraryNode,
  removeLibraryNodesByParentUuid,
  updateLibraryNodeName,
  updateLibraryNodeOrder,
  type LibraryNodeType,
  type LibraryNodeRow
} from '../../libraryTreeDb'
import {
  getRecycleBinRootAbs,
  moveFileToRecycleBin,
  normalizeRendererPlaylistPath,
  permanentlyDeleteFile,
  type RecycleBinMoveResult
} from '../../recycleBinService'
import { listRecycleBinRecords, deleteRecycleBinRecords } from '../../recycleBinDb'
import {
  listMixtapeFilePathsByPlaylist,
  removeMixtapeItemsByPlaylist,
  replaceMixtapeFilePath
} from '../../mixtapeDb'
import { updateSetItemFilePathReferences } from '../../setListDb'
import { replaceMixtapeStemAssetFilePath } from '../../mixtapeStemDb'
import { getLibraryRootAbs } from '../../services/libraryStemAssetStorage'
import { isMixtapeWindowOpenByPlaylistId } from '../mixtapeWindow'
import {
  compactSongListTrackNumbers,
  compactSongListTrackNumbersByFilePaths,
  isSupportedPlaylistTrackNumberListRoot
} from '../../services/playlistTrackNumbers'
import { markGlobalSongSearchDirty } from '../../services/globalSongSearch'
import {
  protectSetReferencedFilesForDeletion,
  removeSetItemsByPlaylistWithCustodyCleanup
} from '../../ipc/setListHandlers'
import { assertLibraryMergeMutationAllowed } from '../../services/libraryMerge/runtime'

const MIXTAPE_WINDOW_OPEN_ERROR_CODE = 'MIXTAPE_WINDOW_OPEN'
const FILE_BATCH_CONCURRENCY = 8
const FILE_BATCH_YIELD_EVERY = 8

const normalizeLibraryNodeType = (value: unknown): LibraryNodeType => {
  switch (value) {
    case 'root':
    case 'library':
    case 'dir':
    case 'songList':
    case 'mixtapeList':
    case 'setList':
      return value
    default:
      return 'dir'
  }
}

const isRecycleBinMoveResult = (value: unknown): value is RecycleBinMoveResult =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof Reflect.get(value, 'status') === 'string' &&
  typeof Reflect.get(value, 'srcPath') === 'string'

export function registerMainWindowFilesystemHandlers(getWindow: () => BrowserWindow | null) {
  const sendProgress = (payload: Record<string, unknown>) => {
    getWindow()?.webContents.send('progressSet', payload)
  }

  const createProgressId = (prefix: string) =>
    `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`

  const finalizeMixtapePlaylistRemoval = async (playlistId: string, filePaths: string[]) => {
    if (!playlistId) return
    removeMixtapeItemsByPlaylist(playlistId)
    await cleanupMixtapeWaveformCache(filePaths)
    await cleanupOrphanedMixtapeVaultFiles(filePaths)
  }

  const collectSetListUuidsForSubtree = (rootUuid: string): string[] => {
    if (!rootUuid) return []
    const nodes = loadLibraryNodes() || []
    const byUuid = new Map(nodes.map((node) => [node.uuid, node]))
    const childrenByParent = new Map<string, LibraryNodeRow[]>()
    for (const node of nodes) {
      if (!node.parentUuid) continue
      const list = childrenByParent.get(node.parentUuid)
      if (list) {
        list.push(node)
      } else {
        childrenByParent.set(node.parentUuid, [node])
      }
    }
    const result: string[] = []
    const queue = [rootUuid]
    for (let i = 0; i < queue.length; i += 1) {
      const uuid = queue[i]
      const node = byUuid.get(uuid)
      if (node?.nodeType === 'setList') result.push(uuid)
      const children = childrenByParent.get(uuid) || []
      for (const child of children) {
        queue.push(child.uuid)
      }
    }
    return result
  }

  const clearSetMappingsForPlaylists = async (playlistUuids: string[]) => {
    for (const uuid of playlistUuids) {
      await removeSetItemsByPlaylistWithCustodyCleanup(uuid)
    }
  }

  ipcMain.on('openFileExplorer', (_e, targetPath) => {
    try {
      const target = resolveLibraryPath(String(targetPath || ''))
      void shell.openPath(target.absPath)
    } catch (error) {
      log.error('openFileExplorer failed:', error)
    }
  })

  ipcMain.on('open-current-library-root-in-explorer', () => {
    const libraryRoot = String(store.databaseDir || '')
    if (!libraryRoot) {
      log.error(
        'open-current-library-root-in-explorer failed: library database root is not configured'
      )
      return
    }
    void shell.openPath(libraryRoot)
  })

  ipcMain.on('show-item-in-folder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('emptyDir', async (_e, targetPath: string) => {
    assertLibraryMergeMutationAllowed()
    const progressId = createProgressId('playlist_empty')
    sendProgress({
      id: progressId,
      titleKey: 'library.deleteProgressScanning',
      now: 0,
      total: 0,
      isInitial: true,
      noProgress: true
    })

    try {
      const { absPath } = resolveLibraryPath(targetPath)
      const audioExts = store.settingConfig.audioExt
      const songFileUrls = await collectFilesWithExtensions(absPath, audioExts)
      const originalPlaylistPath = normalizeRendererPlaylistPath(targetPath)
      const compactTrackNumbersIfSupported = async () => {
        if (!isSupportedPlaylistTrackNumberListRoot(absPath)) return
        await compactSongListTrackNumbers(absPath)
        markGlobalSongSearchDirty('emptyDir')
      }

      if (songFileUrls.length === 0) {
        await removeNonAudioEntries(absPath, audioExts)
        await compactTrackNumbersIfSupported()
        scheduleCuratedLibrarySyncIfUnderCurated([absPath])
        sendProgress({
          id: progressId,
          titleKey: 'library.deleteProgressFinished',
          now: 1,
          total: 1
        })
        return { total: 0, success: 0, failed: 0, skipped: 0, hasENOSPC: false }
      }
      const setProtection = await protectSetReferencedFilesForDeletion(songFileUrls)
      const protectedMovedPaths = setProtection.protectedFiles
        .filter((protectedFile) => protectedFile.success)
        .map((protectedFile) => protectedFile.filePath)
      const protectedFailedCount = setProtection.protectedFiles.filter(
        (protectedFile) => !protectedFile.success
      ).length
      const protectedHandledCount = setProtection.protectedFiles.length
      const tasks: Array<() => Promise<RecycleBinMoveResult>> = setProtection.unprotectedFiles.map(
        (srcPath) => {
          return async () => {
            const result = await moveFileToRecycleBin(srcPath, {
              originalPlaylistPath
            })
            if (result.status === 'failed') {
              throw new Error(result.error || 'move to recycle bin failed')
            }
            return result
          }
        }
      )
      const batchId = `emptyDir_${Date.now()}`
      sendProgress({
        id: progressId,
        titleKey: 'library.deleteProgressRemoving',
        now: protectedHandledCount,
        total: songFileUrls.length,
        noProgress: false
      })
      const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
        concurrency: FILE_BATCH_CONCURRENCY,
        stopOnENOSPC: true,
        yieldEvery: FILE_BATCH_YIELD_EVERY,
        onProgress: (done: number, total: number) => {
          sendProgress({
            id: progressId,
            titleKey: 'library.deleteProgressRemoving',
            now: protectedHandledCount + done,
            total: protectedHandledCount + total,
            noProgress: false
          })
        },
        onInterrupted: async (payload) =>
          waitForUserDecision(getWindow(), batchId, 'emptyDir', payload)
      })
      await removeNonAudioEntries(absPath, audioExts)
      await compactTrackNumbersIfSupported()
      scheduleCuratedLibrarySyncIfUnderCurated([absPath, ...protectedMovedPaths])
      const totalSuccess = success + protectedMovedPaths.length
      const totalFailed = failed + protectedFailedCount
      const targetWindow = getWindow()
      if (targetWindow && hasENOSPC) {
        targetWindow.webContents.send('file-batch-summary', {
          context: 'emptyDir',
          total: songFileUrls.length,
          success: totalSuccess,
          failed: totalFailed,
          hasENOSPC,
          skipped,
          errorSamples: []
        })
      }
      sendProgress({
        id: progressId,
        titleKey:
          totalFailed === 0 && skipped === 0
            ? 'library.deleteProgressFinished'
            : 'library.deleteProgressFailed',
        now: 1,
        total: 1
      })
      return {
        total: songFileUrls.length,
        success: totalSuccess,
        failed: totalFailed,
        skipped,
        hasENOSPC
      }
    } catch (error) {
      sendProgress({
        id: progressId,
        titleKey: 'library.deleteProgressFailed',
        now: 1,
        total: 1
      })
      throw error
    }
  })

  ipcMain.handle('emptyRecycleBin', async () => {
    assertLibraryMergeMutationAllowed()
    const recycleBinPath = getRecycleBinRootAbs()
    if (!recycleBinPath) {
      return { total: 0, success: 0, failed: 0, removedPaths: [] }
    }
    const progressId = createProgressId('recycle_bin_empty')
    const deleteTasks: Array<() => Promise<string>> = []
    const emptyDirCandidates: string[] = []
    let success = 0
    let failed = 0
    let removedPaths: string[] = []
    try {
      if (!(await fs.pathExists(recycleBinPath))) {
        return { total: 0, success: 0, failed: 0, removedPaths: [] }
      }
      sendProgress({
        id: progressId,
        titleKey: 'recycleBin.progressScanning',
        now: 0,
        total: 0,
        isInitial: true,
        noProgress: true
      })
      const walkAndCollectFiles = async (targetDir: string) => {
        let entries: fs.Dirent[] = []
        try {
          entries = await fs.readdir(targetDir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const entryPath = path.join(targetDir, entry.name)
          if (entry.isDirectory()) {
            await walkAndCollectFiles(entryPath)
            emptyDirCandidates.push(entryPath)
            continue
          }
          if (entry.isFile()) {
            deleteTasks.push(async () => {
              const deleted = await permanentlyDeleteFile(entryPath)
              if (!deleted) {
                throw new Error(`permanently delete failed: ${entryPath}`)
              }
              return entryPath
            })
          }
        }
      }
      await walkAndCollectFiles(recycleBinPath)
      if (deleteTasks.length > 0) {
        sendProgress({
          id: progressId,
          titleKey: 'recycleBin.progressDeleting',
          now: 0,
          total: deleteTasks.length,
          noProgress: false
        })
      }
      const emptyResults: Array<string | Error> = []
      const {
        results,
        success: runSuccess,
        failed: runFailed,
        skipped
      } = deleteTasks.length > 0
        ? await runWithConcurrency(deleteTasks, {
            concurrency: FILE_BATCH_CONCURRENCY,
            stopOnENOSPC: false,
            yieldEvery: FILE_BATCH_YIELD_EVERY,
            onProgress: (done: number, total: number) => {
              sendProgress({
                id: progressId,
                titleKey: 'recycleBin.progressDeleting',
                now: done,
                total,
                noProgress: false
              })
            }
          })
        : { results: emptyResults, success: 0, failed: 0, skipped: 0 }
      success = runSuccess
      failed = runFailed
      for (const dirPath of emptyDirCandidates.sort((left, right) => right.length - left.length)) {
        try {
          await fs.remove(dirPath)
        } catch {}
      }
      const libraryRoot = path.join(store.databaseDir, 'library')
      const records = listRecycleBinRecords()
      const missingRecords: string[] = []
      for (const record of records) {
        const absPath = path.isAbsolute(record.filePath)
          ? record.filePath
          : path.join(libraryRoot, record.filePath)
        if (!(await fs.pathExists(absPath))) {
          missingRecords.push(record.filePath)
        }
      }
      if (missingRecords.length > 0) {
        deleteRecycleBinRecords(missingRecords)
      }
      removedPaths = results.filter((item): item is string => typeof item === 'string')
      const recycleBinEmpty = await isDirectoryEffectivelyEmpty(
        recycleBinPath,
        store.settingConfig.audioExt
      )
      if (recycleBinEmpty) {
        const parentNode = findLibraryNodeByPath(
          path.join('library', getCoreFsDirName('RecycleBin'))
        )
        if (parentNode) {
          removeLibraryNodesByParentUuid(parentNode.uuid)
        }
      }
      sendProgress({
        id: progressId,
        titleKey:
          failed === 0 && skipped === 0
            ? 'recycleBin.progressFinished'
            : 'recycleBin.progressFailed',
        now: 1,
        total: 1
      })
      return {
        total: deleteTasks.length,
        success,
        failed,
        removedPaths
      }
    } catch (error) {
      sendProgress({
        id: progressId,
        titleKey: 'recycleBin.progressFailed',
        now: 1,
        total: 1
      })
      log.error('清空回收站失败:', error)
      return {
        total: deleteTasks.length,
        success,
        failed: failed || Math.max(0, deleteTasks.length - success),
        removedPaths
      }
    }
  })

  ipcMain.handle('operateFileSystemChange', async (_e, operateArray: FileSystemOperation[]) => {
    assertLibraryMergeMutationAllowed()
    const results: Array<{ uuid: string; status: string }> = []
    const deleteProgressItems = operateArray.filter((item) => item.type === 'delete')
    const deleteProgressBatch =
      deleteProgressItems.length > 1
        ? {
            id: createProgressId('library_delete_batch'),
            total: deleteProgressItems.length,
            completed: 0,
            failed: false,
            started: false,
            finalized: false
          }
        : null
    const sendDeleteProgress = (
      progressId: string,
      payload: {
        titleKey: string
        now: number
        total: number
        isInitial?: boolean
        noProgress?: boolean
      }
    ) => {
      if (!deleteProgressBatch) {
        sendProgress({ id: progressId, ...payload })
        return
      }
      if (
        payload.titleKey === 'library.deleteProgressFinished' ||
        payload.titleKey === 'library.deleteProgressFailed'
      ) {
        return
      }
      deleteProgressBatch.started = true
      sendProgress({
        id: deleteProgressBatch.id,
        titleKey: payload.titleKey,
        now: deleteProgressBatch.completed,
        total: deleteProgressBatch.total,
        isInitial: !!payload.isInitial && deleteProgressBatch.completed === 0,
        noProgress: false
      })
    }
    const completeDeleteProgressItem = (operationStatus: string) => {
      if (!deleteProgressBatch) return
      deleteProgressBatch.completed = Math.min(
        deleteProgressBatch.total,
        deleteProgressBatch.completed + 1
      )
      if (operationStatus.includes('failed')) {
        deleteProgressBatch.failed = true
      }
      const isDone = deleteProgressBatch.completed >= deleteProgressBatch.total
      sendProgress({
        id: deleteProgressBatch.id,
        titleKey: isDone
          ? deleteProgressBatch.failed
            ? 'library.deleteProgressFailed'
            : 'library.deleteProgressFinished'
          : 'library.deleteProgressRemoving',
        now: deleteProgressBatch.completed,
        total: deleteProgressBatch.total,
        noProgress: false
      })
      if (isDone) {
        deleteProgressBatch.finalized = true
      }
    }
    const failDeleteProgressBatch = () => {
      if (!deleteProgressBatch?.started || deleteProgressBatch.finalized) return
      deleteProgressBatch.finalized = true
      sendProgress({
        id: deleteProgressBatch.id,
        titleKey: 'library.deleteProgressFailed',
        now: deleteProgressBatch.completed,
        total: deleteProgressBatch.total,
        noProgress: false
      })
    }
    for (const item of operateArray) {
      const shouldCheckMixtapeWindow =
        item.nodeType === 'mixtapeList' &&
        (item.type === 'delete' || item.type === 'permanentlyDelete')
      if (!shouldCheckMixtapeWindow) continue
      if (!isMixtapeWindowOpenByPlaylistId(item.uuid)) continue
      return {
        success: false,
        errorCode: MIXTAPE_WINDOW_OPEN_ERROR_CODE,
        error: 'mixtape window is open',
        blockedPlaylistId: item.uuid,
        details: results
      }
    }
    try {
      for (const item of operateArray) {
        let operationStatus = 'processed'
        if (item.type === 'create') {
          const { mappedPath, absPath: createPath } = resolveLibraryPath(item.path)
          await fs.ensureDir(path.dirname(createPath))
          await fs.ensureDir(createPath)
          const parentNode = findLibraryNodeByPath(path.dirname(mappedPath))
          if (parentNode) {
            insertLibraryNode({
              uuid: item.uuid,
              parentUuid: parentNode.uuid,
              dirName: path.basename(mappedPath),
              nodeType: normalizeLibraryNodeType(item.nodeType),
              order: item.order
            })
          }
          operationStatus = 'created'
        } else if (item.type === 'reorder') {
          updateLibraryNodeOrder(item.uuid, item.order ?? null)
          operationStatus = 'reordered'
          let reorderAbs = ''
          try {
            if (item.path) reorderAbs = resolveLibraryPath(item.path).absPath
          } catch {}
          scheduleCuratedLibrarySyncIfUnderCurated([reorderAbs, getNodeAbsPath(item.uuid)])
        } else if (item.type === 'rename') {
          const oldTarget = resolveLibraryPath(item.path)
          const newTarget = item.newPath
            ? resolveLibraryPath(item.newPath)
            : {
                mappedPath: path.join(path.dirname(oldTarget.mappedPath), item.newName || ''),
                absPath: resolveLibraryChildPath(
                  path.dirname(oldTarget.absPath),
                  item.newName || ''
                )
              }
          const mappedNewPath = newTarget.mappedPath
          const oldFullPath = oldTarget.absPath
          const newFullPath = newTarget.absPath
          if (await fs.pathExists(oldFullPath)) {
            await fs.rename(oldFullPath, newFullPath)
            updateLibraryNodeName(item.uuid, path.basename(mappedNewPath))
            await transferCachesAfterDirChange({
              nodeType: item.nodeType,
              oldFullPath,
              newFullPath
            })
            operationStatus = 'renamed'
          } else {
            operationStatus = 'rename_failed_source_not_found'
          }
        } else if (item.type === 'delete') {
          const progressId =
            deleteProgressBatch?.id || createProgressId(`library_delete_${item.uuid}`)
          const setListUuidsToClear = collectSetListUuidsForSubtree(item.uuid)
          sendDeleteProgress(progressId, {
            titleKey: 'library.deleteProgressScanning',
            now: 0,
            total: 0,
            isInitial: true,
            noProgress: true
          })
          const mixtapeFilePaths =
            item.nodeType === 'mixtapeList' ? listMixtapeFilePathsByPlaylist(item.uuid) : []
          const { absPath: dirPath } = resolveLibraryPath(item.path)
          const isEmpty = await isDirectoryEffectivelyEmpty(dirPath, store.settingConfig.audioExt)
          if (isEmpty) {
            rememberCuratedLibraryNodeDeletion(item.uuid, dirPath)
            await fs.remove(dirPath)
            removeLibraryNode(item.uuid)
            await clearSetMappingsForPlaylists(setListUuidsToClear)
            operationStatus = 'removed'
            if (item.nodeType === 'mixtapeList') {
              await finalizeMixtapePlaylistRemoval(item.uuid, mixtapeFilePaths)
            }
            sendDeleteProgress(progressId, {
              titleKey: 'library.deleteProgressFinished',
              now: 1,
              total: 1
            })
          } else {
            try {
              const audioExts = store.settingConfig.audioExt
              const audioFiles = await collectFilesWithExtensions(dirPath, audioExts)
              const setProtection = await protectSetReferencedFilesForDeletion(audioFiles)
              const protectedMovedPaths = setProtection.protectedFiles
                .filter((protectedFile) => protectedFile.success)
                .map((protectedFile) => protectedFile.filePath)
              const protectedFailedCount = setProtection.protectedFiles.filter(
                (protectedFile) => !protectedFile.success
              ).length
              const protectedHandledCount = setProtection.protectedFiles.length
              const tasks: Array<() => Promise<RecycleBinMoveResult>> =
                setProtection.unprotectedFiles.map((srcPath) => async () => {
                  const result = await moveFileToRecycleBin(srcPath)
                  if (result.status === 'failed') {
                    throw new Error(result.error || 'move to recycle bin failed')
                  }
                  return result
                })
              sendDeleteProgress(progressId, {
                titleKey: 'library.deleteProgressRemoving',
                now: protectedHandledCount,
                total: audioFiles.length,
                noProgress: false
              })
              const batchId = `recycleMove_${Date.now()}`
              const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(
                tasks,
                {
                  concurrency: FILE_BATCH_CONCURRENCY,
                  stopOnENOSPC: true,
                  yieldEvery: FILE_BATCH_YIELD_EVERY,
                  onProgress: (done: number, total: number) => {
                    sendDeleteProgress(progressId, {
                      titleKey: 'library.deleteProgressRemoving',
                      now: protectedHandledCount + done,
                      total: protectedHandledCount + total,
                      noProgress: false
                    })
                  },
                  onInterrupted: async (payload) =>
                    waitForUserDecision(getWindow(), batchId, 'recycleMove', payload)
                }
              )
              const movedPaths = results
                .filter(
                  (result): result is RecycleBinMoveResult =>
                    !(result instanceof Error) && isRecycleBinMoveResult(result)
                )
                .map((result) => result.srcPath)
                .concat(protectedMovedPaths)
              await removeNonAudioEntries(dirPath, audioExts)
              const allAudioMoved =
                failed === 0 &&
                skipped === 0 &&
                success === tasks.length &&
                protectedFailedCount === 0
              if (allAudioMoved) {
                rememberCuratedLibraryNodeDeletion(item.uuid, dirPath)
                await fs.remove(dirPath)
                removeLibraryNode(item.uuid)
                await clearSetMappingsForPlaylists(setListUuidsToClear)
                if (item.nodeType === 'mixtapeList') {
                  await finalizeMixtapePlaylistRemoval(item.uuid, mixtapeFilePaths)
                }
              } else if (movedPaths.length > 0) {
                const compactResult = await compactSongListTrackNumbersByFilePaths(movedPaths)
                if (compactResult.roots > 0) {
                  markGlobalSongSearchDirty('library-delete-partial')
                }
              }
              operationStatus = allAudioMoved ? 'recycled' : 'recycle_failed'
              sendDeleteProgress(progressId, {
                titleKey: allAudioMoved
                  ? 'library.deleteProgressFinished'
                  : 'library.deleteProgressFailed',
                now: 1,
                total: 1
              })
              if (hasENOSPC && getWindow()) {
                getWindow()?.webContents.send('file-batch-summary', {
                  context: 'recycleMove',
                  total: audioFiles.length,
                  success: success + protectedMovedPaths.length,
                  failed: failed + protectedFailedCount,
                  hasENOSPC,
                  skipped,
                  errorSamples: []
                })
              }
            } catch (moveError) {
              sendDeleteProgress(progressId, {
                titleKey: 'library.deleteProgressFailed',
                now: 1,
                total: 1
              })
              log.error(`Error moving ${item.path} to recycle bin:`, moveError)
              operationStatus = 'recycle_failed'
            }
          }
          completeDeleteProgressItem(operationStatus)
        } else if (item.type === 'permanentlyDelete') {
          const mixtapeFilePaths =
            item.nodeType === 'mixtapeList' ? listMixtapeFilePathsByPlaylist(item.uuid) : []
          const setListUuidsToClear = collectSetListUuidsForSubtree(item.uuid)
          const { absPath } = resolveLibraryPath(item.path)
          const audioFiles = await collectFilesWithExtensions(absPath, store.settingConfig.audioExt)
          const setProtection = await protectSetReferencedFilesForDeletion(audioFiles)
          const protectedFailedCount = setProtection.protectedFiles.filter(
            (protectedFile) => !protectedFile.success
          ).length
          if (protectedFailedCount > 0) {
            operationStatus = 'permanent_delete_failed'
          } else {
            rememberCuratedLibraryNodeDeletion(item.uuid, absPath)
            await fs.remove(absPath)
            removeLibraryNode(item.uuid)
            await clearSetMappingsForPlaylists(setListUuidsToClear)
            operationStatus = 'permanently_deleted'
            if (item.nodeType === 'mixtapeList') {
              await finalizeMixtapePlaylistRemoval(item.uuid, mixtapeFilePaths)
            }
          }
        } else if (item.type === 'move') {
          const oldTarget = resolveLibraryPath(item.path)
          const newTarget = resolveLibraryPath(item.newPath as string)
          const srcFullPath = oldTarget.absPath
          const destFullPath = newTarget.absPath
          if (await fs.pathExists(srcFullPath)) {
            await fs.ensureDir(path.dirname(destFullPath))
            await fs.move(srcFullPath, destFullPath, { overwrite: true })
            const parentNode = findLibraryNodeByPath(path.dirname(newTarget.mappedPath))
            if (parentNode) {
              moveLibraryNode(item.uuid, parentNode.uuid, path.basename(newTarget.mappedPath))
              if (item.order !== undefined) {
                updateLibraryNodeOrder(item.uuid, item.order)
              }
            }
            await transferCachesAfterDirChange({
              nodeType: item.nodeType,
              oldFullPath: srcFullPath,
              newFullPath: destFullPath
            })
            operationStatus = 'moved'
          } else {
            operationStatus = 'move_failed_source_not_found'
          }
        }
        results.push({ uuid: item.uuid, status: operationStatus })
      }
      scheduleCuratedLibrarySyncIfUnderCurated(
        operateArray.flatMap((item) => {
          const paths: string[] = []
          const remember = (rendererPath?: string) => {
            const raw = String(rendererPath || '').trim()
            if (!raw) return
            try {
              paths.push(resolveLibraryPath(raw).absPath)
            } catch {}
          }
          remember(item.path)
          remember(item.newPath)
          const nodeAbs = getNodeAbsPath(item.uuid)
          if (nodeAbs) paths.push(nodeAbs)
          return paths
        })
      )
      const failedDetails = results.filter((item) => item.status.includes('failed'))
      if (failedDetails.length > 0) {
        return {
          success: false,
          error: 'one or more filesystem operations failed',
          details: results
        }
      }
      return { success: true, details: results }
    } catch (error) {
      failDeleteProgressBatch()
      log.error('operateFileSystemChange error:', error)
      return { success: false, error: (error as Error).message, details: results }
    }
  })
}

function normalizePath(value: string): string {
  if (!value) return ''
  let normalized = path.resolve(value)
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

function isUnderPath(parentPath: string, targetPath: string): boolean {
  const parent = normalizePath(parentPath)
  const target = normalizePath(targetPath)
  if (!parent || !target) return false
  return target === parent || target.startsWith(parent + path.sep)
}

function buildNodePathMap(nodes: LibraryNodeRow[], root: LibraryNodeRow): Map<string, string> {
  const childrenMap = new Map<string, LibraryNodeRow[]>()
  for (const row of nodes) {
    if (!row.parentUuid) continue
    const list = childrenMap.get(row.parentUuid)
    if (list) {
      list.push(row)
    } else {
      childrenMap.set(row.parentUuid, [row])
    }
  }
  const pathByUuid = new Map<string, string>()
  pathByUuid.set(root.uuid, root.dirName)
  const queue: LibraryNodeRow[] = [root]
  for (let i = 0; i < queue.length; i += 1) {
    const parent = queue[i]
    const parentPath = pathByUuid.get(parent.uuid)
    if (!parentPath) continue
    const children = childrenMap.get(parent.uuid) || []
    for (const child of children) {
      const childPath = path.join(parentPath, child.dirName)
      if (!pathByUuid.has(child.uuid)) {
        pathByUuid.set(child.uuid, childPath)
        queue.push(child)
      }
    }
  }
  return pathByUuid
}

async function transferCachesAfterDirChange(params: {
  nodeType?: string
  oldFullPath: string
  newFullPath: string
}): Promise<void> {
  const { nodeType, oldFullPath, newFullPath } = params
  if (!oldFullPath || !newFullPath) return
  if (normalizePath(oldFullPath) === normalizePath(newFullPath)) return

  if (nodeType === 'songList') {
    try {
      const audioExts = store.settingConfig.audioExt || []
      const files = await collectFilesWithExtensions(newFullPath, audioExts)
      await syncMappedPathReferencesAfterDirChange(oldFullPath, newFullPath, files)
      if (files.length === 0) return
      const tasks: Array<() => Promise<void>> = files.map((filePath) => async () => {
        const rel = path.relative(newFullPath, filePath)
        if (!rel || rel.startsWith('..')) return
        const oldFilePath = path.join(oldFullPath, rel)
        await transferTrackCaches({
          fromRoot: oldFullPath,
          toRoot: newFullPath,
          fromPath: oldFilePath,
          toPath: filePath
        })
      })
      await runWithConcurrency(tasks, { concurrency: 8, stopOnENOSPC: false })
    } catch {}
    return
  }

  try {
    const audioExts = store.settingConfig.audioExt || []
    const files = await collectFilesWithExtensions(newFullPath, audioExts)
    await syncMappedPathReferencesAfterDirChange(oldFullPath, newFullPath, files)
    const rootDir = store.databaseDir
    if (!rootDir) return
    const nodes = loadLibraryNodes(rootDir) || []
    if (nodes.length === 0) return
    const root = nodes.find((row) => row.parentUuid === null && row.nodeType === 'root')
    if (!root) return
    const pathByUuid = buildNodePathMap(nodes, root)
    const songListRoots: string[] = []
    for (const row of nodes) {
      if (row.nodeType !== 'songList') continue
      const rel = pathByUuid.get(row.uuid)
      if (!rel) continue
      const abs = path.join(rootDir, rel)
      if (isUnderPath(newFullPath, abs)) {
        songListRoots.push(abs)
      }
    }
    if (songListRoots.length === 0) return
    const tasks: Array<() => Promise<void>> = songListRoots.map((songListRoot) => async () => {
      const rel = path.relative(newFullPath, songListRoot)
      if (!rel || rel.startsWith('..')) return
      const oldRoot = path.join(oldFullPath, rel)
      await renameCacheRoot(oldRoot, songListRoot)
    })
    await runWithConcurrency(tasks, { concurrency: 4, stopOnENOSPC: false })
  } catch {}
}

async function syncMappedPathReferencesAfterDirChange(
  oldFullPath: string,
  newFullPath: string,
  movedFiles: string[]
): Promise<void> {
  if (!Array.isArray(movedFiles) || movedFiles.length === 0) return
  try {
    const libraryRoot = getLibraryRootAbs()
    const tasks: Array<() => Promise<void>> = movedFiles.map((newFilePath) => async () => {
      const rel = path.relative(newFullPath, newFilePath)
      if (!rel || rel.startsWith('..')) return
      const oldFilePath = path.join(oldFullPath, rel)
      replaceMixtapeFilePath(oldFilePath, newFilePath)
      updateSetItemFilePathReferences(oldFilePath, newFilePath)
      if (libraryRoot) {
        replaceMixtapeStemAssetFilePath({
          libraryRoot,
          oldFilePath,
          newFilePath
        })
      }
    })
    await runWithConcurrency(tasks, { concurrency: 8, stopOnENOSPC: false })
  } catch {
    // 移动文件本身已经完成；这里同步的是映射引用缓存，失败不应打断文件操作。
    // 上层没有可展示的恢复动作，避免把可忽略的缓存同步失败写入 log.txt。
  }
}

async function isDirectoryEffectivelyEmpty(dirPath: string, audioExtensions: string[]) {
  try {
    if (!(await fs.pathExists(dirPath))) {
      return true
    }
    const items = await fs.readdir(dirPath, { withFileTypes: true })
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name)
      if (item.isFile()) {
        const lowerExt = path.extname(item.name).toLowerCase()
        if (audioExtensions.includes(lowerExt)) {
          return false
        }
      } else if (item.isDirectory()) {
        if (!(await isDirectoryEffectivelyEmpty(fullPath, audioExtensions))) {
          return false
        }
      }
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true
    }
    log.error(`Error checking directory emptiness for ${dirPath}:`, error)
    return false
  }
}

function normalizeAudioExtensions(input?: string[]): Set<string> {
  const result = new Set<string>()
  if (!Array.isArray(input)) return result
  for (const raw of input) {
    if (!raw) continue
    let ext = String(raw).trim().toLowerCase()
    if (!ext) continue
    if (!ext.startsWith('.')) ext = `.${ext}`
    result.add(ext)
  }
  return result
}

async function removeNonAudioEntries(dirPath: string, audioExtensions: string[]) {
  const audioSet = normalizeAudioExtensions(audioExtensions)
  await removeNonAudioRecursive(dirPath, audioSet, true)
}

async function removeNonAudioRecursive(dirPath: string, audioSet: Set<string>, keepRoot: boolean) {
  let entries: fs.Dirent[] = []
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await removeNonAudioRecursive(fullPath, audioSet, false)
      continue
    }
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (!audioSet.has(ext)) {
        try {
          await fs.remove(fullPath)
        } catch {}
      }
    }
  }
  if (!keepRoot) {
    try {
      const remain = await fs.readdir(dirPath)
      if (remain.length === 0) {
        await fs.remove(dirPath)
      }
    } catch {}
  }
}
