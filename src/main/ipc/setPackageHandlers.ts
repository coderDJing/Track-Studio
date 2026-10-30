import { dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from 'electron'
import path = require('path')
import store from '../store'
import { log } from '../log'
import { loadLibraryNodes } from '../libraryTreeDb'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'
import { exportSetPackage } from '../services/setPackage/exportSetPackage'
import { importSetPackage, inspectSetPackage } from '../services/setPackage/importSetPackage'
import { SetPackageError } from '../services/setPackage/manifest'
import {
  SET_PACKAGE_EXTENSION,
  type SetPackageExportResult,
  type SetPackageFailure,
  type SetPackageImportResult,
  type SetPackagePickResult
} from '../../shared/setPackage'
import type { ISongInfo } from '../../types/globals'

const isEnglish = () => store.settingConfig?.language === 'enUS'

const toFailure = (error: unknown, context: string): SetPackageFailure => {
  if (error instanceof SetPackageError) {
    return { ok: false, code: error.code, message: error.message, fileNames: error.fileNames }
  }
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOSPC') {
    return { ok: false, code: 'NO_SPACE', message: '磁盘空间不足' }
  }
  log.error(`[setPackage] ${context} failed`, error)
  return {
    ok: false,
    code: 'FAILED',
    message: error instanceof Error && error.message ? error.message : String(error)
  }
}

const showOpenDialog = async (
  getWindow: () => BrowserWindow | null,
  options: OpenDialogOptions
) => {
  const win = getWindow()
  return win && !win.isDestroyed()
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
}

const createProgressReporter = (
  getWindow: () => BrowserWindow | null,
  id: string,
  titleKey: string
) => {
  const send = (payload: Record<string, unknown>) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('progressSet', { id, titleKey, ...payload })
  }
  return {
    update: (done: number, total: number) =>
      send({ now: done, total, isInitial: done === 0, noProgress: false }),
    dismiss: () => send({ dismiss: true })
  }
}

// 导入只接受刚由文件对话框选中的描述文件，renderer 不能指定任意路径。
const pickedManifestPaths = new Set<string>()
const manifestPathKey = (manifestPath: string) => {
  const resolved = path.resolve(manifestPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const findSetListName = (playlistUuid: string): string | null => {
  const node = (loadLibraryNodes() || []).find((row) => row.uuid === playlistUuid)
  return node && node.nodeType === 'setList' ? node.dirName : null
}

export function registerSetPackageHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.handle(
    'setList:export-package',
    async (
      _e,
      payload?: { playlistUuid?: unknown; songs?: unknown }
    ): Promise<SetPackageExportResult> => {
      const playlistUuid = typeof payload?.playlistUuid === 'string' ? payload.playlistUuid : ''
      const setName = playlistUuid ? findSetListName(playlistUuid) : null
      if (!setName) {
        return { ok: false, code: 'PLAYLIST_NOT_FOUND', message: 'SET 歌单不存在' }
      }
      const selection = await showOpenDialog(getWindow, {
        title: isEnglish() ? 'Choose where to export the SET' : '选择 SET 导出位置',
        properties: ['openDirectory', 'createDirectory']
      })
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, canceled: true }
      const progress = createProgressReporter(
        getWindow,
        `setPackageExport_${Date.now()}`,
        'library.setPackageExporting'
      )
      try {
        const summary = await exportSetPackage({
          playlistUuid,
          setName,
          songs: Array.isArray(payload?.songs) ? (payload.songs as ISongInfo[]) : [],
          targetParentDir: selection.filePaths[0],
          onProgress: progress.update
        })
        return { ok: true, canceled: false, ...summary }
      } catch (error) {
        progress.dismiss()
        return toFailure(error, 'export')
      }
    }
  )

  ipcMain.handle('setList:pick-package', async (): Promise<SetPackagePickResult> => {
    const selection = await showOpenDialog(getWindow, {
      title: isEnglish()
        ? 'Choose a SET description file (.frkbset)'
        : '选择 SET 描述文件（.frkbset）',
      properties: ['openFile'],
      filters: [
        {
          name: isEnglish() ? 'Track Studio SET' : 'Track Studio SET 描述文件',
          extensions: [SET_PACKAGE_EXTENSION]
        }
      ]
    })
    const manifestPath = selection.filePaths[0]
    if (selection.canceled || !manifestPath) return { ok: true, canceled: true }
    try {
      const manifest = await inspectSetPackage(manifestPath)
      pickedManifestPaths.add(manifestPathKey(manifestPath))
      return {
        ok: true,
        canceled: false,
        manifestPath,
        setName: manifest.set.name,
        trackCount: manifest.tracks.length,
        appVersion: manifest.appVersion
      }
    } catch (error) {
      return toFailure(error, 'inspect')
    }
  })

  ipcMain.handle(
    'setList:import-package',
    async (
      _e,
      payload?: {
        manifestPath?: unknown
        playlistUuid?: unknown
        deleteSourceAfterImport?: unknown
      }
    ): Promise<SetPackageImportResult> => {
      const manifestPath = typeof payload?.manifestPath === 'string' ? payload.manifestPath : ''
      const playlistUuid = typeof payload?.playlistUuid === 'string' ? payload.playlistUuid : ''
      if (!manifestPath || !playlistUuid) {
        return { ok: false, code: 'FAILED', message: '导入参数缺失' }
      }
      if (!pickedManifestPaths.delete(manifestPathKey(manifestPath))) {
        return { ok: false, code: 'FAILED', message: '请重新选择 SET 描述文件' }
      }
      const progress = createProgressReporter(
        getWindow,
        `setPackageImport_${Date.now()}`,
        'library.setPackageImporting'
      )
      try {
        assertLibraryMergeMutationAllowed()
        const summary = await importSetPackage({
          manifestPath,
          playlistUuid,
          deleteSourceAfterImport: payload?.deleteSourceAfterImport === true,
          onProgress: progress.update
        })
        return { ok: true, ...summary }
      } catch (error) {
        progress.dismiss()
        return toFailure(error, 'import')
      }
    }
  )
}
