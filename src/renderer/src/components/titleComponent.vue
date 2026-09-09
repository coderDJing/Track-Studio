<script setup lang="ts">
defineOptions({ inheritAttrs: false })
import chromeMaximizeAsset from '@renderer/assets/chrome-maximize.svg?asset'
import chromeRestoreAsset from '@renderer/assets/chrome-restore.svg?asset'
import chromeMiniimizeAsset from '@renderer/assets/chrome-minimize.svg?asset'
import logoAsset from '@renderer/assets/logo.png?asset'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ref, computed, watch } from 'vue'
import menuComponent from './menu.vue'
import confirm from '@renderer/components/confirmDialog'
import { openNewSongsImport } from '@renderer/utils/newSongsImport'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'
import pkg from '../../../../package.json'
import {
  WINDOW_SCREENSHOT_SHORTCUT,
  isWindowScreenshotFeatureAvailable
} from '@shared/windowScreenshotFeature'
import { PRODUCT_DISPLAY_NAME } from '@shared/productBrand'

const chromeMaximize = chromeMaximizeAsset
const chromeRestore = chromeRestoreAsset
const chromeMiniimize = chromeMiniimizeAsset
const logo = logoAsset
type MenuItem = {
  name: string
  shortcutKey?: string
  i18nParams?: Record<string, unknown>
  action?: string
  checked?: boolean
}

type MenuConfig = {
  name: string
  subMenu: MenuItem[][]
  directAction?: string
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    controlPrefix?: string
    maxEventChannel?: string
    titleText?: string
    menuOverride?: MenuConfig[]
    enableMenuHotkeys?: boolean
    hideLogo?: boolean
  }>(),
  {
    controlPrefix: '',
    maxEventChannel: 'mainWin-max',
    titleText: '',
    menuOverride: undefined,
    enableMenuHotkeys: true,
    hideLogo: false
  }
)

const emit = defineEmits(['openDialog'])
const resolveChannel = (action: 'maximize' | 'minimize' | 'close') => {
  if (props.controlPrefix) return `${props.controlPrefix}-toggle-${action}`
  return `toggle-${action}`
}
const titleMeta = computed(() => {
  const custom = String(props.titleText || '').trim()
  const title = custom || `${PRODUCT_DISPLAY_NAME} - ${t('app.name')}`
  const matched = title.match(/^(.*?)(?:\s*)\[dev:([^\]]+)\]\s*$/i)
  if (!matched) {
    return {
      full: title,
      base: title,
      devLabel: '',
      instance: ''
    }
  }
  return {
    full: title,
    base: String(matched[1] || '').trim(),
    devLabel: 'dev:',
    instance: String(matched[2] || '').trim()
  }
})
const showLogo = computed(() => runtime.platform !== 'Mac' && !props.hideLogo)

const toggleMaximize = () => {
  window.electron.ipcRenderer.send(resolveChannel('maximize'))
}

const toggleMinimize = () => {
  window.electron.ipcRenderer.send(resolveChannel('minimize'))
}

let isExitProgressingConfirmOpen = false
const toggleClose = async () => {
  if (runtime.isProgressing) {
    if (isExitProgressingConfirmOpen) return
    isExitProgressingConfirmOpen = true
    try {
      const result = await confirm({
        title: t('common.exit'),
        content: [t('import.exitWhileTask'), t('import.exitWhileTaskDetail')],
        confirmText: t('import.exitAndAbandonTask'),
        cancelText: t('common.cancel'),
        innerHeight: 240
      })
      if (result !== 'confirm') return
    } finally {
      isExitProgressingConfirmOpen = false
    }
  }
  window.electron.ipcRenderer.send(resolveChannel('close'))
}
const runtime = useRuntimeStore()

window.electron.ipcRenderer.on(props.maxEventChannel, (_event, bool) => {
  runtime.isWindowMaximized = bool
})

type Menu = {
  name: string
  show: boolean
  subMenu: MenuItem[][]
  directAction?: string
  disabled?: boolean
}

const isDevMode = computed(() => process.env.NODE_ENV === 'development')
const isWindowScreenshotFeatureVisible = computed(() =>
  isWindowScreenshotFeatureAvailable({
    platform: runtime.setting?.platform || '',
    isDev: isDevMode.value,
    version: String(pkg.version || '')
  })
)
const isWindowScreenshotShortcutEnabled = computed(
  () => runtime.setting.enableWindowScreenshotShortcut !== false
)
const analysisRuntimeBusy = computed(() => {
  const status = runtime.analysisRuntime.state.status
  return status === 'downloading' || status === 'extracting'
})

const buildMenuArr = (configs: MenuConfig[]): Menu[] => {
  return configs.map((item) => ({
    name: item.name,
    show: false,
    subMenu: item.subMenu || [],
    directAction: item.directAction,
    disabled: Boolean(item.disabled)
  }))
}

const defaultMenuConfigs = computed<MenuConfig[]>(() => {
  const librarySetupActive = runtime.librarySetupActive
  const helpSubMenu: MenuItem[][] = [
    [{ name: 'menu.visitGithub', shortcutKey: 'F1' }, { name: 'menu.visitWebsite' }],
    [
      { name: 'menu.checkUpdate' },
      ...(!librarySetupActive && !runtime.analysisRuntime.available && !analysisRuntimeBusy.value
        ? [{ name: 'menu.downloadAnalysisRuntime', action: 'download-analysis-runtime' }]
        : []),
      { name: 'menu.openLog', action: 'open-log' },
      { name: 'menu.whatsNew' },
      ...(librarySetupActive ? [] : [{ name: 'menu.userGuide' }]),
      { name: 'menu.thirdPartyNotices' },
      { name: 'menu.about' }
    ],
    ...(isWindowScreenshotFeatureVisible.value
      ? [
          [
            {
              name: 'menu.enableWindowScreenshotShortcut',
              action: 'toggle-window-screenshot-shortcut',
              shortcutKey: WINDOW_SCREENSHOT_SHORTCUT,
              checked: isWindowScreenshotShortcutEnabled.value
            }
          ]
        ]
      : []),
    ...(!librarySetupActive && isDevMode.value
      ? [
          [
            { name: 'menu.startSongListTrace', action: 'dev-songlist-trace-start' },
            { name: 'menu.stopSongListTrace', action: 'dev-songlist-trace-stop' }
          ]
        ]
      : [])
  ]
  return [
    {
      name: 'menu.file',
      disabled: librarySetupActive,
      subMenu: [
        [
          {
            name: 'library.importNewTracks',
            shortcutKey: 'Alt+Q',
            i18nParams: { libraryTypeKey: 'library.filter' },
            action: 'import-new-filter'
          },
          {
            name: 'library.importNewTracks',
            shortcutKey: 'Alt+E',
            i18nParams: { libraryTypeKey: 'library.curated' },
            action: 'import-new-curated'
          }
        ],
        [{ name: 'menu.globalSongSearch', shortcutKey: 'Ctrl,Ctrl' }],
        [{ name: 'menu.formatConversionTool' }],
        [{ name: 'fingerprints.manualAdd', action: 'manual-add-fingerprint' }],
        [{ name: 'menu.exit', action: 'exit' }]
      ]
    },
    {
      name: 'menu.migration',
      disabled: librarySetupActive,
      subMenu: [
        [{ name: 'fingerprints.exportDatabase' }, { name: 'fingerprints.importDatabase' }],
        [
          { name: 'migration.mergeLibrary', action: 'library-merge' },
          { name: 'migration.mergeCuratedLibrary', action: 'curated-library-merge' }
        ],
        [{ name: 'migration.moveLibrary', action: 'library-relocate' }]
      ]
    },
    {
      name: 'menu.cloudSync',
      disabled: librarySetupActive,
      subMenu: [
        [{ name: 'cloudSync.syncFingerprints' }, { name: 'cloudSync.syncCuratedLibrary' }],
        [{ name: 'cloudSync.settings' }]
      ]
    },
    {
      name: 'menu.help',
      subMenu: helpSubMenu
    }
  ]
})

const resolvedMenuConfigs = computed<MenuConfig[]>(() => {
  if (Array.isArray(props.menuOverride) && props.menuOverride.length > 0) {
    return props.menuOverride
  }
  return defaultMenuConfigs.value
})

const menuArr = ref<Menu[]>(buildMenuArr(resolvedMenuConfigs.value))

watch(
  resolvedMenuConfigs,
  (nextConfigs) => {
    const openMenuName = menuArr.value.find((item) => item.show)?.name || ''
    menuArr.value = buildMenuArr(nextConfigs).map((item) => ({
      ...item,
      show: item.name === openMenuName
    }))
  },
  { deep: true }
)

if (props.enableMenuHotkeys) {
  hotkeys('alt+f', 'windowGlobal', () => {
    menuArr.value.forEach((item) => {
      if (item.name === 'menu.file' && !item.disabled) {
        item.show = true
        return
      }
    })
  })
  hotkeys('alt+g', 'windowGlobal', () => {
    menuArr.value.forEach((item) => {
      if (item.name === 'menu.migration' && !item.disabled) {
        item.show = true
        return
      }
    })
  })
  hotkeys('alt+c', 'windowGlobal', () => {
    menuArr.value.forEach((item) => {
      if (item.name === 'menu.cloudSync' && !item.disabled) {
        item.show = true
        return
      }
    })
  })
  hotkeys('alt+h', 'windowGlobal', () => {
    menuArr.value.forEach((item) => {
      if (item.name === 'menu.help' && !item.disabled) {
        item.show = true
        return
      }
    })
  })

  hotkeys('alt+q', 'windowGlobal', () => {
    if (runtime.librarySetupActive) return
    ;(async () => {
      await openNewSongsImport('FilterLibrary')
    })()
  })

  hotkeys('alt+e', 'windowGlobal', () => {
    if (runtime.librarySetupActive) return
    ;(async () => {
      await openNewSongsImport('CuratedLibrary')
    })()
  })
}
const menuClick = (item: Menu) => {
  if (item.disabled) return
  if (item.directAction) {
    menuArr.value.forEach((menuItem) => {
      menuItem.show = false
    })
    emit('openDialog', item.directAction)
    return
  }
  item.show = true
}
const menuButtonClick = async (item: MenuItem) => {
  if (
    item.name === 'library.importNewTracks' ||
    item.name === 'fingerprints.manualAdd' ||
    item.name === 'fingerprints.exportDatabase' ||
    item.name === 'fingerprints.importDatabase'
  ) {
    if (runtime.isProgressing) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('import.waitForTask')],
        confirmShow: false
      })
      return
    }
    if (item.action === 'import-new-filter') {
      await openNewSongsImport('FilterLibrary')
      return
    } else if (item.action === 'import-new-curated') {
      await openNewSongsImport('CuratedLibrary')
      return
    }
  }
  if (item.action === 'toggle-window-screenshot-shortcut') {
    const previousEnabled = runtime.setting.enableWindowScreenshotShortcut !== false
    runtime.setting.enableWindowScreenshotShortcut = !previousEnabled
    try {
      await window.electron.ipcRenderer.invoke(
        'setSetting',
        JSON.parse(JSON.stringify(runtime.setting))
      )
    } catch (error) {
      runtime.setting.enableWindowScreenshotShortcut = previousEnabled
      console.error('[window-screenshot] update setting failed', error)
    }
    return
  }
  if (item.action === 'open-log') {
    window.electron.ipcRenderer.send('openLog')
    return
  }
  if (item.action === 'library-merge') {
    await window.electron.ipcRenderer.invoke('library-merge:run-from-menu', { scope: 'full' })
    return
  }
  if (item.action === 'curated-library-merge') {
    await window.electron.ipcRenderer.invoke('library-merge:run-from-menu', { scope: 'curated' })
    return
  }
  if (item.action === 'library-relocate') {
    await window.electron.ipcRenderer.invoke('library-relocate:run-from-menu')
    return
  }
  if (item.action === 'download-analysis-runtime') {
    emit('openDialog', 'menu.downloadAnalysisRuntime')
    return
  }
  if (item.action === 'dev-songlist-trace-start') {
    emit('openDialog', 'menu.startSongListTrace')
    return
  }
  if (item.action === 'dev-songlist-trace-stop') {
    emit('openDialog', 'menu.stopSongListTrace')
    return
  }
  emit('openDialog', item.name)
}

const switchMenu = (direction: 'next' | 'prev', menuName: string) => {
  const total = menuArr.value.length
  let index = menuArr.value.findIndex((item) => item.name === menuName)
  if (index < 0 || total === 0) return
  for (let i = 0; i < total; i++) {
    if (direction === 'next') {
      index = index === total - 1 ? 0 : index + 1
    } else {
      index = index === 0 ? total - 1 : index - 1
    }
    if (!menuArr.value[index].disabled) {
      menuArr.value[index].show = true
      return
    }
  }
}
const titleMenuButtonMouseEnter = (item: Menu) => {
  if (item.disabled) return
  if (item.directAction) return
  if (menuArr.value.findIndex((item) => item.show === true) === -1) {
    return
  }
  item.show = true
}
</script>
<template>
  <div class="title unselectable">
    <span class="title__main">{{ titleMeta.base }}</span>
    <span v-if="titleMeta.instance" class="title__dev-badge">
      <span class="title__dev-label">{{ titleMeta.devLabel }}</span>
      <span class="title__dev-instance">{{ titleMeta.instance }}</span>
    </span>
  </div>
  <div class="titleComponent unselectable" v-bind="$attrs">
    <div
      v-if="showLogo"
      style="
        z-index: 1;
        padding-left: 10px;
        display: flex;
        justify-content: center;
        align-items: center;
      "
    >
      <img :src="logo" style="width: 20px" :draggable="false" class="theme-icon" />
    </div>
    <template v-if="runtime.platform !== 'Mac'">
      <div v-for="item in menuArr" :key="item.name" style="z-index: 1; padding-left: 5px">
        <div
          class="functionButton"
          :class="{
            functionButtonHover: item.show,
            functionButtonDisabled: item.disabled
          }"
          :aria-disabled="item.disabled ? 'true' : 'false'"
          @click.stop="menuClick(item)"
          @mouseenter="titleMenuButtonMouseEnter(item)"
        >
          {{ t(item.name) }}
        </div>
        <menuComponent
          v-if="!item.directAction && item.subMenu.length > 0"
          v-model="item.show"
          :menu-arr="item.subMenu"
          :menu-name="item.name"
          @menu-button-click="menuButtonClick"
          @switch-menu="switchMenu"
        ></menuComponent>
      </div>
    </template>
    <div class="canDrag title-drag">
      <div v-if="$slots.meta" class="title-meta">
        <slot name="meta" />
      </div>
      <div v-if="$slots.rightExtra" class="title-right-extra canNotDrag">
        <slot name="rightExtra" />
      </div>
    </div>
    <div v-if="runtime.platform !== 'Mac'" style="display: flex; z-index: 1">
      <div class="rightIcon" @click="toggleMinimize()">
        <img :src="chromeMiniimize" :draggable="false" />
      </div>
      <div class="rightIcon" @click="toggleMaximize()">
        <img :src="runtime.isWindowMaximized ? chromeRestore : chromeMaximize" :draggable="false" />
      </div>
      <div class="rightIcon closeIcon" @click="toggleClose()">
        <svg
          width="15"
          height="15"
          viewBox="0 0 15 15"
          xmlns="http://www.w3.org/2000/svg"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M7.116 8l-4.558 4.558.884.884L8 8.884l4.558 4.558.884-.884L8.884 8l4.558-4.558-.884-.884L8 7.116 3.442 2.558l-.884.884L7.116 8z"
          />
        </svg>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.functionButton {
  height: 22px;
  line-height: 22px;
  padding: 0 5px;

  font-size: 12px;
  border-radius: 5px;
}

.functionButton:hover {
  background-color: var(--hover);
}

.functionButtonHover {
  background-color: var(--hover);
}

.functionButtonDisabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.title {
  position: absolute;
  width: 100%;
  height: 34px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 10px;
  background-color: var(--bg);
  z-index: 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);

  .title__main {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .title__dev-badge {
    display: inline-flex;
    align-items: baseline;
    gap: 7px;
    line-height: 1;
    flex-shrink: 0;
  }

  .title__dev-label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: inherit;
  }

  .title__dev-instance {
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: inherit;
  }
}

.titleComponent {
  position: relative;
  z-index: var(--z-title-bar);
  width: 100vw;
  height: 35px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  box-sizing: border-box;

  .title-drag {
    flex-grow: 1;
    height: 35px;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 12px 0 8px;
    min-width: 0;
  }

  .title-meta {
    font-size: 12px;
    color: var(--text-weak);
    max-width: 60%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    pointer-events: none;
  }

  .title-right-extra {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-shrink: 0;
    margin-left: 10px;
  }

  .rightIcon {
    width: 47px;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 35px;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .rightIcon:hover {
    background-color: var(--hover);
  }

  .closeIcon {
    color: var(--text-weak);
  }

  .closeIcon:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}
</style>
