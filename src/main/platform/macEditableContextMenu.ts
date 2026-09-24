import { Menu, type BrowserWindow } from 'electron'

export const attachMacEditableContextMenu = (window: BrowserWindow) => {
  if (process.platform !== 'darwin') return

  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable || window.isDestroyed()) return

    Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    ]).popup({ window })
  })
}
