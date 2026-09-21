import { createApp, watch, type AppContext } from 'vue'
import { createPinia } from 'pinia'
import App from './MiniPlayerOverlay.vue'
import './styles/main.scss'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { i18n } from '@renderer/i18n'
import 'overlayscrollbars/overlayscrollbars.css'
import dialogDrag from './directives/dialogDrag'
import {
  applyUiSettings,
  initUiSettings,
  readUiSettings,
  watchUiSettings
} from '@renderer/utils/uiSettingsStorage'
import { installConsoleLogBridge } from '@renderer/utils/installConsoleLogBridge'
import { applyAccentColor } from '@renderer/utils/accentColor'
import { isRuntimeLibraryTree } from '@renderer/utils/appRuntimeStateGuards'
import utils from '@renderer/utils/utils'

declare global {
  interface Window {
    __FRKB_APP_CONTEXT__?: AppContext
    __FRKB_MINI_PLAYER_FLOATING_TOOLTIP__?: boolean
  }
}

window.__FRKB_MINI_PLAYER_FLOATING_TOOLTIP__ = true

const pinia = createPinia()
const app = createApp(App)

installConsoleLogBridge('mini-player-overlay')

app.directive('dialog-drag', dialogDrag)

app.config.errorHandler = (err: Error) => {
  console.error('VUE全局错误捕获', err)
}

app.use(pinia)
app.use(i18n)
window.__FRKB_APP_CONTEXT__ = app._context

const initializeApp = async () => {
  const runtime = useRuntimeStore()
  runtime.setting = await window.electron.ipcRenderer.invoke('getSetting')
  const { cleanedSetting, needsCleanup } = initUiSettings(runtime.setting)
  if (needsCleanup) {
    void window.electron.ipcRenderer.invoke('setSetting', cleanedSetting)
  }
  watchUiSettings(runtime.setting)
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== localStorage) return
    applyUiSettings(runtime.setting as unknown as Record<string, unknown>, readUiSettings())
  })
  {
    const platform = runtime.setting?.platform
    runtime.platform = platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'Windows' : 'Unknown'
  }
  const rootEl = document.getElementById('app')
  const prefersDarkMedia = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null
  const getSystemDark = () => {
    try {
      return !!prefersDarkMedia?.matches
    } catch {
      return false
    }
  }
  const applyThemeClass = (mode: 'system' | 'light' | 'dark', isSystemDark?: boolean) => {
    try {
      const htmlEl = document.documentElement
      const bodyEl = document.body
      if (rootEl) rootEl.classList.remove('theme-dark', 'theme-light')
      htmlEl.classList.remove('theme-dark', 'theme-light')
      bodyEl.classList.remove('theme-dark', 'theme-light')
      const effectiveDark = mode === 'dark' || (mode === 'system' && !!isSystemDark)
      const themeClass = effectiveDark ? 'theme-dark' : 'theme-light'
      if (rootEl) rootEl.classList.add(themeClass)
      htmlEl.classList.add(themeClass)
      bodyEl.classList.add(themeClass)
    } catch {}
  }
  applyThemeClass(runtime.setting.themeMode || 'system', getSystemDark())
  applyAccentColor(runtime.setting.accentColor)
  watch(
    () => runtime.setting.accentColor,
    (color) => applyAccentColor(color)
  )
  try {
    watch(
      () => runtime.setting.themeMode,
      (mode: 'system' | 'light' | 'dark') => applyThemeClass(mode || 'system', getSystemDark())
    )
    window.electron.ipcRenderer.on('setting-changed', (_e, newSetting) => {
      if (newSetting && typeof newSetting === 'object') {
        runtime.setting = newSetting
      }
    })
    prefersDarkMedia?.addEventListener?.('change', (event: MediaQueryListEvent) => {
      if ((runtime.setting.themeMode || 'system') === 'system') {
        applyThemeClass('system', !!event.matches)
      }
    })
  } catch {}
  try {
    if (runtime.setting.platform === 'darwin' && rootEl) {
      rootEl.classList.add('is-mac')
    }
  } catch {}
  const { setLocale } = await import('@renderer/i18n')
  if (runtime.setting.language === 'enUS') {
    setLocale('en-US')
  } else {
    setLocale('zh-CN')
  }
  watch(
    () => runtime.setting.language,
    (lang) => {
      i18n.global.locale.value = lang === 'enUS' ? 'en-US' : 'zh-CN'
    }
  )
  const loadLibrary = async () => {
    try {
      const tree = await window.electron.ipcRenderer.invoke('getLibrary')
      if (tree && typeof tree === 'object') {
        runtime.libraryTree = tree
        runtime.oldLibraryTree = JSON.parse(JSON.stringify(tree))
      }
    } catch (error) {
      console.error('[mini-player-overlay] load library tree failed', error)
    }
  }
  await loadLibrary()
  window.electron.ipcRenderer.on('library-tree-updated', (_event, tree: unknown) => {
    if (isRuntimeLibraryTree(tree)) {
      runtime.libraryTree = tree
      runtime.oldLibraryTree = JSON.parse(JSON.stringify(tree))
      return
    }
    void loadLibrary()
  })
  utils.setHotkeysScpoe('windowGlobal')
  app.mount('#app')
}

void initializeApp()
