import { app, type BrowserWindow } from 'electron'
import fs = require('fs-extra')
import path = require('path')
import store from '../store'
import { initDatabaseStructure } from '../initDatabase'
import FingerprintStore from '../fingerprintStore'
import {
  ensureManifestForLegacy,
  writeManifest,
  ensureManifestMinVersion
} from '../databaseManifest'
import {
  assertExistingDatabaseSchemaSupported,
  closeLibraryDb,
  getLibraryDbPath,
  isDatabaseSchemaVersionError
} from '../libraryDb'
import { migrateLibrarySchemaV35ToV36 } from '../librarySchemaV36Migration'
import { migrateLibrarySchemaToV38 } from '../librarySchemaV37Migration'
import { migrateLibrarySchemaV38ToV39 } from '../librarySchemaV38Migration'
import { migrateLibrarySchemaV39ToV40 } from '../librarySchemaV40Migration'
import { ensureLegacyMigration } from '../libraryMigration'
import { persistSettingConfig } from '../settingsPersistence'
import { startLibraryTreeWatcher, stopLibraryTreeWatcher } from '../libraryTreeWatcher'
import { startKeyAnalysisBackground } from '../services/keyAnalysisQueue'
import { maybeShowWhatsNew } from '../services/whatsNew'
import globalSongSearchEngine from '../services/globalSongSearch'
import databaseSchemaMigrationWindow from '../window/databaseSchemaMigrationWindow'
import mainWindow from '../window/mainWindow'
import { clearLibrarySetup } from '../librarySetupState'
import { restartCloudSyncScheduler } from '../cloudSyncScheduler'
import {
  stopCuratedLibraryLiveSync,
  syncCuratedLibraryLiveSync
} from '../curatedLibrarySync/liveSync'
import { cancelCuratedLibrarySync } from '../curatedLibrarySync/engine'
import { seedDemoAnalysis } from './demoAnalysisSeed'
import type { LibrarySetupErrorHint } from '../../shared/librarySetup'

export type InitializeLibraryOptions = {
  createSamples?: boolean
  reset?: boolean
  fingerprintMode?: 'pcm' | 'file'
}

export type InitializeLibraryResult =
  | { status: 'ok' }
  | { status: 'schema-too-new' }
  | { status: 'schema-migration-failed' }
  | { status: 'canceled' }

const getFingerprintMode = (): 'pcm' | 'file' =>
  store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'

const getHostWindow = (): BrowserWindow | null => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return null
  return win
}

const sendLibrarySetupErrorHint = (hint: LibrarySetupErrorHint): void => {
  getHostWindow()?.webContents.send('databaseInitWindow-showErrorHint', hint)
}

const completeLibrarySetup = (): void => {
  const win = getHostWindow()
  clearLibrarySetup()
  if (win) {
    startLibraryTreeWatcher(win)
    win.webContents.reload()
  } else {
    mainWindow.createWindow()
  }
  startKeyAnalysisBackground()
  void globalSongSearchEngine.warmup().catch(() => {})
  void maybeShowWhatsNew().catch(() => {})
  restartCloudSyncScheduler({ immediate: true })
  syncCuratedLibraryLiveSync()
}

export const initializeLibraryAtPath = async (
  dirPath: string,
  options?: InitializeLibraryOptions
): Promise<InitializeLibraryResult> => {
  const databasePath = getLibraryDbPath(dirPath)
  if (options?.reset !== true && fs.pathExistsSync(databasePath)) {
    let databaseVersion: number
    try {
      databaseVersion = assertExistingDatabaseSchemaSupported(databasePath)
    } catch (error) {
      if (isDatabaseSchemaVersionError(error)) {
        sendLibrarySetupErrorHint({
          kind: 'schema-too-new',
          databaseUrl: dirPath,
          databaseVersion: error.databaseVersion,
          maximumSupportedVersion: error.maximumSupportedVersion
        })
        return { status: 'schema-too-new' }
      }
      throw error
    }
    try {
      if (databaseVersion === 35 || databaseVersion === 36 || databaseVersion === 37) {
        databaseSchemaMigrationWindow.createWindow()
      }
      if (databaseVersion === 35) {
        await migrateLibrarySchemaV35ToV36(databasePath, {
          onProgress: databaseSchemaMigrationWindow.setSchemaMigrationProgress
        })
        databaseVersion = assertExistingDatabaseSchemaSupported(databasePath)
      }
      if (databaseVersion === 36 || databaseVersion === 37) {
        await migrateLibrarySchemaToV38(databasePath, {
          onProgress: databaseSchemaMigrationWindow.setSchemaMigrationProgress
        })
        databaseVersion = assertExistingDatabaseSchemaSupported(databasePath)
      }
      if (databaseVersion === 38) {
        await migrateLibrarySchemaV38ToV39(databasePath)
        databaseVersion = assertExistingDatabaseSchemaSupported(databasePath)
      }
      if (databaseVersion === 39) {
        await migrateLibrarySchemaV39ToV40(databasePath)
      }
    } catch {
      return { status: 'schema-migration-failed' }
    }
  }

  try {
    const v1 = path.join(dirPath, 'songFingerprint', 'songFingerprint.json')
    if (fs.pathExistsSync(v1)) {
      fs.removeSync(v1)
    }
  } catch {}

  if (options?.reset === true) {
    try {
      stopCuratedLibraryLiveSync()
      await cancelCuratedLibrarySync()
    } catch {}
    stopLibraryTreeWatcher()
    closeLibraryDb()
    try {
      await fs.remove(path.join(dirPath, 'library'))
    } catch {}
    try {
      await fs.remove(path.join(dirPath, 'songFingerprint'))
    } catch {}
    try {
      await fs.remove(path.join(dirPath, 'FRKB.database.frkbdb'))
    } catch {}
    try {
      await fs.remove(getLibraryDbPath(dirPath))
    } catch {}
  } else if (store.databaseDir && store.databaseDir !== dirPath) {
    try {
      stopCuratedLibraryLiveSync()
      await cancelCuratedLibrarySync()
    } catch {}
    stopLibraryTreeWatcher()
    closeLibraryDb()
  }

  try {
    if (options?.fingerprintMode === 'pcm' || options?.fingerprintMode === 'file') {
      store.settingConfig.fingerprintMode = options.fingerprintMode
      await persistSettingConfig()
    }
  } catch {}

  const initResult = await initDatabaseStructure(dirPath, {
    createSamples: options?.createSamples !== false
  })

  try {
    if (options?.reset === true) {
      await writeManifest(dirPath, app.getVersion())
    } else {
      const legacy = await ensureManifestForLegacy(dirPath, app.getVersion())
      if (!legacy) {
        await writeManifest(dirPath, app.getVersion())
      }
    }
    await ensureManifestMinVersion(dirPath, app.getVersion())
  } catch {}

  const proceed = await ensureLegacyMigration(dirPath, getHostWindow())
  if (!proceed) return { status: 'canceled' }

  store.databaseDir = dirPath
  // 必须在 databaseDir 生效之后：缓存键要按当前库根解析，才能落到示例歌单的相对键上。
  if (initResult.samplesCreated) {
    await seedDemoAnalysis(dirPath)
  }
  const mode = getFingerprintMode()
  const list = await FingerprintStore.loadList(mode)
  store.songFingerprintList = Array.isArray(list) ? list : []
  databaseSchemaMigrationWindow.close()
  completeLibrarySetup()
  return { status: 'ok' }
}
