import { ipcMain } from 'electron'
import { isOptionalComponentId } from '../../shared/optionalComponentDownloads'
import {
  getOptionalComponentStates,
  optionalComponentEvents
} from '../services/optionalComponentEvents'
import mainWindow from '../window/mainWindow'
import { log } from '../log'

export function registerOptionalComponentHandlers() {
  ipcMain.handle('optional-component:states', () => getOptionalComponentStates())
  ipcMain.handle('optional-component:download', async (_event, id: unknown) => {
    if (!isOptionalComponentId(id)) {
      return { ok: false, error: 'Unknown optional component' }
    }
    try {
      if (id === 'rekordbox-desktop-runtime') {
        const { ensureRekordboxDesktopRuntime } =
          await import('../services/rekordboxRuntimeDownload')
        await ensureRekordboxDesktopRuntime()
      } else {
        const { ensureDemucsBaseModel } = await import('../services/demucsBaseModelDownload')
        await ensureDemucsBaseModel(id === 'stem-model-htdemucs' ? 'htdemucs' : 'mdx_extra_q')
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Component download failed'
      }
    }
  })
  optionalComponentEvents.on('state', (state) => {
    const window = mainWindow.instance
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    try {
      window.webContents.send('optional-component:state', state)
    } catch (error) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        log.error('[optional-components] state delivery failed', error)
      }
    }
  })
}
