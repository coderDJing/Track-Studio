<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import pkg from '../../../../package.json'
import utils from '../utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { ensureSettingDialogRuntimeDefaults } from './settingDialogRuntimeDefaults'
import {
  settingDialogContextKey,
  type SettingDialogContext,
  type SettingDialogRuntimeStore
} from './settingDialog/context'
import {
  SETTINGS_BY_ID,
  isSettingAvailable,
  resolveVisibleSettingId,
  type SettingId,
  type SettingsPageId
} from './settingDialog/settingsCatalog'
import { searchSettings } from './settingDialog/useSettingsSearch'
import SettingsSidebar from './settingDialog/SettingsSidebar.vue'
import SettingsSearchResults from './settingDialog/SettingsSearchResults.vue'
import CommonSettingsPage from './settingDialog/CommonSettingsPage.vue'
import GeneralSettingsPage from './settingDialog/GeneralSettingsPage.vue'
import PlayerSettingsPage from './settingDialog/PlayerSettingsPage.vue'
import ShortcutsSettingsPage from './settingDialog/ShortcutsSettingsPage.vue'
import LibrarySettingsPage from './settingDialog/LibrarySettingsPage.vue'
import AnalysisSettingsPage from './settingDialog/AnalysisSettingsPage.vue'
import IntegrationsSettingsPage from './settingDialog/IntegrationsSettingsPage.vue'
import AdvancedSettingsPage from './settingDialog/AdvancedSettingsPage.vue'

const props = defineProps<{
  initialPage?: SettingsPageId
  initialSettingId?: SettingId
}>()

const emits = defineEmits(['cancel'])
const runtime = useRuntimeStore() as SettingDialogRuntimeStore
const uuid = uuidV4()

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const RECENT_STORAGE_KEY = 'frkb_settings_recent_v1'
const MAX_RECENT_SETTINGS = 5

const activePage = ref<SettingsPageId>(props.initialPage || 'common')
const searchQuery = ref('')
const highlightedSettingId = ref<SettingId | ''>('')
const recentSettingIds = ref<SettingId[]>(loadRecentSettingIds())
const sidebarRef = ref<InstanceType<typeof SettingsSidebar> | null>(null)
const contentTop = ref<HTMLElement | null>(null)

let highlightTimer: number | null = null

function loadRecentSettingIds(): SettingId[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (value): value is SettingId =>
          typeof value === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS_BY_ID, value)
      )
      .slice(0, MAX_RECENT_SETTINGS)
  } catch {
    return []
  }
}

const rememberRecentSetting = (settingId: SettingId) => {
  const next = [settingId, ...recentSettingIds.value.filter((id) => id !== settingId)].slice(
    0,
    MAX_RECENT_SETTINGS
  )
  recentSettingIds.value = next
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore storage failures
  }
}

const isWindowsPlatform = computed(() => runtime.setting.platform === 'win32')
const isDevOrPrerelease = computed(() => {
  if (process.env.NODE_ENV === 'development') return true
  return String(pkg.version || '').includes('-')
})

const searchActive = computed(() => searchQuery.value.trim().length > 0)
const searchResultIds = computed(() =>
  searchSettings(searchQuery.value, {
    setting: runtime.setting,
    isDevOrPrerelease: isDevOrPrerelease.value
  })
)

const isSettingVisible = (settingId: SettingId): boolean => {
  const meta = SETTINGS_BY_ID[settingId]
  if (!meta) return false
  return isSettingAvailable(meta, runtime.setting, {
    isDevOrPrerelease: isDevOrPrerelease.value,
    platform: runtime.setting.platform
  })
}

ensureSettingDialogRuntimeDefaults(runtime)

const setSetting = async (settingId?: SettingId) => {
  if (settingId) rememberRecentSetting(settingId)
  // 等 v-model 把控件的新值写回 runtime 后再落盘，避免 checkbox/radio 的 change
  // 早于 update:modelValue 触发时把旧值写进配置。
  await nextTick()
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

const cancel = () => {
  closeWithAnimation(() => {
    emits('cancel')
  })
}

const closeImmediately = () => {
  emits('cancel')
}

const handleSearchEscape = () => {
  if (searchQuery.value) {
    searchQuery.value = ''
    return
  }
  cancel()
}

const scrollToContentTop = () => {
  void nextTick(() => {
    window.requestAnimationFrame(() => {
      contentTop.value?.scrollIntoView({ block: 'start' })
    })
  })
}

const openPage = (page: SettingsPageId) => {
  activePage.value = page
  searchQuery.value = ''
  scrollToContentTop()
}

const highlightSetting = (settingId: SettingId) => {
  highlightedSettingId.value = settingId
  if (highlightTimer !== null) {
    window.clearTimeout(highlightTimer)
  }
  highlightTimer = window.setTimeout(() => {
    highlightedSettingId.value = ''
    highlightTimer = null
  }, 1500)
}

const navigateToSetting = (settingId: SettingId) => {
  const targetId = resolveVisibleSettingId(settingId, runtime.setting, {
    isDevOrPrerelease: isDevOrPrerelease.value,
    platform: runtime.setting.platform
  })
  const meta = SETTINGS_BY_ID[targetId]
  if (!meta) return

  activePage.value = meta.page
  searchQuery.value = ''
  highlightSetting(targetId)

  void nextTick(() => {
    window.requestAnimationFrame(() => {
      const element = document.querySelector(`[data-setting-id="${targetId}"]`)
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  })
}

const pageComponents = {
  common: CommonSettingsPage,
  general: GeneralSettingsPage,
  player: PlayerSettingsPage,
  shortcuts: ShortcutsSettingsPage,
  library: LibrarySettingsPage,
  analysis: AnalysisSettingsPage,
  integrations: IntegrationsSettingsPage,
  advanced: AdvancedSettingsPage
} as const

const activePageComponent = computed(() => pageComponents[activePage.value])

onMounted(() => {
  hotkeys('Esc', uuid, handleSearchEscape)
  hotkeys('ctrl+f,meta+f', uuid, (event) => {
    event.preventDefault()
    sidebarRef.value?.focusSearch()
  })

  utils.setHotkeysScpoe(uuid)

  if (props.initialSettingId) {
    navigateToSetting(props.initialSettingId)
  }
})

onUnmounted(() => {
  if (highlightTimer !== null) {
    window.clearTimeout(highlightTimer)
  }
  utils.delHotkeysScope(uuid)
})

const settingDialogContext: SettingDialogContext = {
  dialogVisible,
  runtime,
  cancel,
  closeImmediately,
  setSetting,
  activePage,
  searchQuery,
  openPage,
  navigateToSetting,
  highlightedSettingId,
  recentSettingIds,
  isSettingVisible,
  isWindowsPlatform,
  isDevOrPrerelease
}

provide(settingDialogContextKey, settingDialogContext)
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner settings-shell">
      <div class="dialog-title dialog-header">
        <span>{{ t('settings.shell.title') }}</span>
      </div>

      <div class="settings-layout">
        <SettingsSidebar
          ref="sidebarRef"
          v-model:search-query="searchQuery"
          :active-page="activePage"
          :search-active="searchActive"
          @open-page="openPage"
          @escape="handleSearchEscape"
        />

        <OverlayScrollbarsComponent
          :options="{
            scrollbars: {
              autoHide: 'leave' as const,
              autoHideDelay: 50,
              clickScroll: true
            } as const,
            overflow: {
              x: 'hidden',
              y: 'scroll'
            } as const
          }"
          element="div"
          class="settings-content"
          defer
        >
          <div ref="contentTop" class="settings-content__top"></div>
          <SettingsSearchResults
            v-if="searchActive"
            :query="searchQuery"
            :result-ids="searchResultIds"
          />
          <component :is="activePageComponent" v-else :key="activePage" />
        </OverlayScrollbarsComponent>
      </div>

      <div class="dialog-footer settings-footer">
        <div class="button" @click="cancel">{{ t('common.close') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" src="./settingDialog.scss"></style>
