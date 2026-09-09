import { app, BrowserWindow, Menu } from 'electron'
import { is } from '@electron-toolkit/utils'
import zhCNCloudSyncLocale from '../../renderer/src/i18n/locales/zh-CN/cloudSync.json'
import zhCNFingerprintsLocale from '../../renderer/src/i18n/locales/zh-CN/fingerprints.json'
import zhCNLibraryLocale from '../../renderer/src/i18n/locales/zh-CN/library.json'
import zhCNMenuLocale from '../../renderer/src/i18n/locales/zh-CN/menu.json'
import zhCNMigrationLocale from '../../renderer/src/i18n/locales/zh-CN/migration.json'
import enUSCloudSyncLocale from '../../renderer/src/i18n/locales/en-US/cloudSync.json'
import enUSFingerprintsLocale from '../../renderer/src/i18n/locales/en-US/fingerprints.json'
import enUSLibraryLocale from '../../renderer/src/i18n/locales/en-US/library.json'
import enUSMenuLocale from '../../renderer/src/i18n/locales/en-US/menu.json'
import enUSMigrationLocale from '../../renderer/src/i18n/locales/en-US/migration.json'
import { PRODUCT_DISPLAY_NAME } from '@shared/productBrand'
import store from '../store'
import mainWindow from '../window/mainWindow'
import { openLogFile } from '../log'
import { openLibraryMergeDialog } from '../ipc/libraryMergeHandlers'
import { openLibraryRelocateDialog } from '../services/libraryRelocate/openDialog'
import { isLibrarySetupActive, onLibrarySetupChanged } from '../librarySetupState'

type MainWindowBrowseMode = 'browser' | 'horizontal' | 'edit'

let mainWindowBrowseMode: MainWindowBrowseMode = 'browser'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const MENU_MESSAGES: Record<'zh-CN' | 'en-US', Record<string, unknown>> = {
  'zh-CN': {
    ...zhCNCloudSyncLocale,
    ...zhCNFingerprintsLocale,
    ...zhCNLibraryLocale,
    ...zhCNMenuLocale,
    ...zhCNMigrationLocale
  },
  'en-US': {
    ...enUSCloudSyncLocale,
    ...enUSFingerprintsLocale,
    ...enUSLibraryLocale,
    ...enUSMenuLocale,
    ...enUSMigrationLocale
  }
}

// 依据当前设置返回语言 ID
const getCurrentLocaleId = (): 'zh-CN' | 'en-US' =>
  store.settingConfig?.language === 'enUS' ? 'en-US' : 'zh-CN'

// 简单的字典查找（key 形如 a.b.c）
const tMenu = (key: string): string => {
  const localeId = getCurrentLocaleId()
  const parts = key.split('.')
  let cur: unknown = MENU_MESSAGES[localeId]
  for (const p of parts) {
    if (isRecord(cur) && p in cur) cur = cur[p]
    else return key
  }
  return typeof cur === 'string' ? cur : key
}

const sanitizeLabelForMac = (label: string): string => {
  if (process.platform !== 'darwin') return label
  return label.replace(/\s*(\([A-Za-z]\)|（[A-Za-z]）)/g, '')
}

const labelImportTo = (libraryKey: 'library.filter' | 'library.curated') => {
  const tpl = tMenu('library.importNewTracks')
  const lib = tMenu(libraryKey)
  return tpl.replace('{libraryType}', lib)
}

export const setMacMainWindowBrowseMode = (mode: MainWindowBrowseMode) => {
  mainWindowBrowseMode = mode
}

const buildAppOnlyMenu = () =>
  Menu.buildFromTemplate([
    {
      label: PRODUCT_DISPLAY_NAME,
      submenu: [
        {
          role: 'hide',
          label:
            getCurrentLocaleId() === 'en-US'
              ? `Hide ${PRODUCT_DISPLAY_NAME}`
              : `隐藏 ${PRODUCT_DISPLAY_NAME}`
        },
        {
          role: 'hideOthers',
          label: getCurrentLocaleId() === 'en-US' ? 'Hide Others' : '隐藏其他'
        },
        { role: 'unhide', label: getCurrentLocaleId() === 'en-US' ? 'Show All' : '显示全部' },
        { type: 'separator' },
        {
          role: 'quit',
          label:
            getCurrentLocaleId() === 'en-US'
              ? `Quit ${PRODUCT_DISPLAY_NAME}`
              : `退出 ${PRODUCT_DISPLAY_NAME}`
        }
      ]
    }
  ])

const buildFullMenu = () => {
  const librarySetupActive = isLibrarySetupActive()
  return Menu.buildFromTemplate([
    {
      label: PRODUCT_DISPLAY_NAME,
      submenu: [
        {
          role: 'hide',
          label:
            getCurrentLocaleId() === 'en-US'
              ? `Hide ${PRODUCT_DISPLAY_NAME}`
              : `隐藏 ${PRODUCT_DISPLAY_NAME}`
        },
        {
          role: 'hideOthers',
          label: getCurrentLocaleId() === 'en-US' ? 'Hide Others' : '隐藏其他'
        },
        { role: 'unhide', label: getCurrentLocaleId() === 'en-US' ? 'Show All' : '显示全部' },
        { type: 'separator' },
        {
          role: 'quit',
          label:
            getCurrentLocaleId() === 'en-US'
              ? `Quit ${PRODUCT_DISPLAY_NAME}`
              : `退出 ${PRODUCT_DISPLAY_NAME}`
        }
      ]
    },
    {
      label: sanitizeLabelForMac(tMenu('menu.file')),
      enabled: !librarySetupActive,
      submenu: [
        {
          label: labelImportTo('library.filter'),
          click: () => mainWindow.instance?.webContents.send('tray-action', 'import-new-filter')
        },
        {
          label: labelImportTo('library.curated'),
          click: () => mainWindow.instance?.webContents.send('tray-action', 'import-new-curated')
        },
        { type: 'separator' },
        {
          label: tMenu('menu.globalSongSearch'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.globalSongSearch')
        },
        { type: 'separator' },
        {
          label: tMenu('menu.formatConversionTool'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.formatConversionTool')
        },
        { type: 'separator' },
        {
          label: tMenu('fingerprints.manualAdd'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'fingerprints.manualAdd')
        }
      ]
    },
    {
      label: sanitizeLabelForMac(tMenu('menu.browseMode')),
      enabled: !librarySetupActive,
      submenu: [
        {
          label: tMenu('menu.fullBrowseMode'),
          type: 'checkbox',
          checked: mainWindowBrowseMode === 'browser',
          click: () => {
            setMacMainWindowBrowseMode('browser')
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.fullBrowseMode')
            rebuildMacMenusForCurrentFocus()
          }
        },
        {
          label: tMenu('menu.horizontalBrowseMode'),
          type: 'checkbox',
          checked: mainWindowBrowseMode === 'horizontal',
          click: () => {
            setMacMainWindowBrowseMode('horizontal')
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.horizontalBrowseMode')
            rebuildMacMenusForCurrentFocus()
          }
        },
        {
          label: tMenu('menu.editBrowseMode'),
          type: 'checkbox',
          checked: mainWindowBrowseMode === 'edit',
          click: () => {
            setMacMainWindowBrowseMode('edit')
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.editBrowseMode')
            rebuildMacMenusForCurrentFocus()
          }
        }
      ]
    },
    {
      label: sanitizeLabelForMac(tMenu('menu.migration')),
      enabled: !librarySetupActive,
      submenu: [
        {
          label: tMenu('fingerprints.exportDatabase'),
          click: () =>
            mainWindow.instance?.webContents.send(
              'openDialogFromTray',
              'fingerprints.exportDatabase'
            )
        },
        {
          label: tMenu('fingerprints.importDatabase'),
          click: () =>
            mainWindow.instance?.webContents.send(
              'openDialogFromTray',
              'fingerprints.importDatabase'
            )
        },
        { type: 'separator' },
        {
          label: tMenu('migration.mergeLibrary'),
          click: () => {
            openLibraryMergeDialog('full')
          }
        },
        {
          label: tMenu('migration.mergeCuratedLibrary'),
          click: () => {
            openLibraryMergeDialog('curated')
          }
        },
        { type: 'separator' },
        {
          label: tMenu('migration.moveLibrary'),
          click: () => {
            openLibraryRelocateDialog()
          }
        }
      ]
    },
    {
      label: sanitizeLabelForMac(tMenu('menu.cloudSync')),
      enabled: !librarySetupActive,
      submenu: [
        {
          label: tMenu('cloudSync.syncFingerprints'),
          click: () =>
            mainWindow.instance?.webContents.send(
              'openDialogFromTray',
              'cloudSync.syncFingerprints'
            )
        },
        {
          label: tMenu('cloudSync.syncCuratedLibrary'),
          click: () =>
            mainWindow.instance?.webContents.send(
              'openDialogFromTray',
              'cloudSync.syncCuratedLibrary'
            )
        },
        {
          label: tMenu('cloudSync.settings'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'cloudSync.settings')
        }
      ]
    },
    {
      label: sanitizeLabelForMac(tMenu('menu.help')),
      submenu: [
        {
          label: tMenu('menu.visitGithub'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.visitGithub')
        },
        {
          label: tMenu('menu.visitWebsite'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.visitWebsite')
        },
        { type: 'separator' },
        {
          label: tMenu('menu.checkUpdate'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.checkUpdate')
        },
        {
          label: tMenu('menu.openLog'),
          click: async () => {
            await openLogFile()
          }
        },
        ...(librarySetupActive
          ? []
          : [
              {
                label: tMenu('menu.userGuide'),
                click: () =>
                  mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.userGuide')
              }
            ]),
        {
          label: tMenu('menu.thirdPartyNotices'),
          click: () =>
            mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.thirdPartyNotices')
        },
        // 仅 dev 模式显示开发 trace 菜单
        ...(!librarySetupActive && is.dev
          ? [
              { type: 'separator' as const },
              {
                label: tMenu('menu.startSongListTrace'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'menu.startSongListTrace'
                  )
              },
              {
                label: tMenu('menu.stopSongListTrace'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'menu.stopSongListTrace'
                  )
              }
            ]
          : []),
        { type: 'separator' },
        {
          label: tMenu('menu.about'),
          click: () => mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.about')
        }
      ]
    }
  ])
}

// 应在 app ready 后调用：初始化仅 FRKB 菜单，并随焦点在 App-only 与 Full 之间切换
export const setupMacMenus = () => {
  if (process.platform !== 'darwin') return
  try {
    Menu.setApplicationMenu(buildAppOnlyMenu())
    onLibrarySetupChanged(() => {
      rebuildMacMenusForCurrentFocus()
    })
    app.on('browser-window-focus', (_e, win) => {
      if (win && mainWindow.instance && win.id === mainWindow.instance.id) {
        Menu.setApplicationMenu(buildFullMenu())
      } else {
        Menu.setApplicationMenu(buildAppOnlyMenu())
      }
    })
  } catch {}
}

// 语言切换后调用：根据当前聚焦窗口重建菜单（不重复绑定事件）
export const rebuildMacMenusForCurrentFocus = () => {
  if (process.platform !== 'darwin') return
  try {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && mainWindow.instance && focused.id === mainWindow.instance.id) {
      Menu.setApplicationMenu(buildFullMenu())
    } else {
      Menu.setApplicationMenu(buildAppOnlyMenu())
    }
  } catch {}
}
