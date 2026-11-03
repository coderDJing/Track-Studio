import { app, ipcMain } from 'electron'
import {
  cancelSetLibrarySync,
  enqueueSetLibrarySync,
  getSetLibrarySyncStatus,
  startSetLibrarySync
} from './engine'
import { isSetLibrarySyncEnabled, setSetLibrarySyncEnabled } from './state'
import { setSyncUserKey } from './api'

export function registerSetLibrarySyncIpc(): void {
  ipcMain.handle('setLibrarySync/getState', () => ({
    enabled: isSetLibrarySyncEnabled(),
    status: getSetLibrarySyncStatus()
  }))
  ipcMain.handle('setLibrarySync/setEnabled', (_event, value: unknown) => {
    if (typeof value !== 'boolean') throw new Error('SET_SYNC_INVALID_ENABLED')
    if (value && !setSyncUserKey()) throw new Error('SET_SYNC_USER_KEY_REQUIRED')
    setSetLibrarySyncEnabled(value)
    if (value) void enqueueSetLibrarySync()
    else cancelSetLibrarySync()
    return { enabled: value }
  })
  ipcMain.handle('setLibrarySync/start', (_event, resolution?: unknown) => {
    if (resolution !== undefined && resolution !== 'local' && resolution !== 'cloud')
      throw new Error('SET_SYNC_INVALID_RESOLUTION')
    return enqueueSetLibrarySync(resolution)
  })
  ipcMain.handle('setLibrarySync/cancel', () => cancelSetLibrarySync())
  void app.whenReady().then(startSetLibrarySync)
}
