import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './LibraryRelocate.vue'
import './styles/main.scss'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { i18n } from '@renderer/i18n'
import { installConsoleLogBridge } from '@renderer/utils/installConsoleLogBridge'
import { applyAccentColor } from '@renderer/utils/accentColor'

const pinia = createPinia()
const app = createApp(App)

installConsoleLogBridge('library-relocate')

app.config.errorHandler = (err: Error) => {
  console.error('VUE全局错误捕获', err)
}

app.use(pinia)
app.use(i18n)

async function initializeApp() {
  const runtime = useRuntimeStore()
  runtime.setting = await window.electron.ipcRenderer.invoke('getSetting')
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
    prefersDarkMedia?.addEventListener?.('change', (e: MediaQueryListEvent) => {
      if ((runtime.setting.themeMode || 'system') === 'system') {
        applyThemeClass('system', !!e.matches)
      }
    })
  } catch {}
  try {
    if (runtime.setting.platform === 'darwin') {
      if (rootEl) rootEl.classList.add('is-mac')
    }
  } catch {}

  if (!runtime.setting.language) {
    runtime.setting.language = navigator.language === 'zh-CN' ? 'zhCN' : 'enUS'
    await window.electron.ipcRenderer.invoke(
      'setSetting',
      JSON.parse(JSON.stringify(runtime.setting))
    )
  }

  const { setLocale } = await import('@renderer/i18n')
  setLocale(runtime.setting.language === 'enUS' ? 'en-US' : 'zh-CN')
  watch(
    () => runtime.setting.language,
    (lang) => {
      i18n.global.locale.value = lang === 'enUS' ? 'en-US' : 'zh-CN'
    }
  )
  app.mount('#app')
}

void initializeApp()
