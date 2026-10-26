import { app, ipcMain } from 'electron'
import {
  cancelBpmFix,
  closeBpmFix,
  getBpmFixSnapshot,
  isBpmFixBusy,
  startBpmFixAnalysis,
  startBpmFixRepair
} from '../services/bpmFix'
import { registerBackgroundForegroundBusyProvider } from '../services/backgroundIdleGate'
import { isLibraryMergeMutationLocked } from '../services/libraryMerge/mutationGate'

export const registerBpmFixHandlers = () => {
  ipcMain.handle('audio:bpm-fix:analyze', (event, payload: unknown) => {
    if (isLibraryMergeMutationLocked()) throw new Error('LIBRARY_MERGE_IN_PROGRESS')
    return startBpmFixAnalysis(event.sender, payload)
  })
  ipcMain.handle('audio:bpm-fix:repair', (event, id: unknown, options: unknown) => {
    if (isLibraryMergeMutationLocked()) throw new Error('LIBRARY_MERGE_IN_PROGRESS')
    return startBpmFixRepair(event.sender.id, id, options)
  })
  ipcMain.handle('audio:bpm-fix:snapshot', (event) => getBpmFixSnapshot(event.sender.id))
  ipcMain.handle('audio:bpm-fix:close', (event, id: unknown) => closeBpmFix(event.sender.id, id))
  ipcMain.handle('audio:bpm-fix:cancel', (event, id: unknown) => {
    if (typeof id === 'string') cancelBpmFix(event.sender.id, id)
  })
  registerBackgroundForegroundBusyProvider('bpm-fix', isBpmFixBusy)
  app.on('before-quit', () => cancelBpmFix())
}
