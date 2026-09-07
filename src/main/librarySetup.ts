import mainWindow from './window/mainWindow'
import { beginLibrarySetup, sendLibrarySetupState } from './librarySetupState'
import type { LibrarySetupErrorHint, LibrarySetupMode } from '../shared/librarySetup'

export const openLibrarySetupWindow = (options?: {
  mode?: LibrarySetupMode
  errorHint?: LibrarySetupErrorHint | null
}): void => {
  beginLibrarySetup({
    mode: options?.mode ?? 'required',
    errorHint: options?.errorHint ?? null
  })
  const win = mainWindow.instance
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
    sendLibrarySetupState(win)
    return
  }
  mainWindow.createWindow()
}
