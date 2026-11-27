<script setup lang="ts">
import { computed, inject } from 'vue'
import { t } from '@renderer/utils/translate'
import { DEFAULT_PINNED_SETTINGS } from './settingsCatalog'
import { settingDialogContextKey, type SettingDialogContext } from './context'
import SettingsPage from './SettingsPage.vue'
import SettingsJumpList from './SettingsJumpList.vue'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const pinnedIds = computed(() => DEFAULT_PINNED_SETTINGS.filter((id) => ctx.isSettingVisible(id)))
const recentIds = computed(() => {
  const pinned = new Set(pinnedIds.value)
  return ctx.recentSettingIds.value
    .filter((id) => !pinned.has(id) && ctx.isSettingVisible(id))
    .slice(0, 5)
})
</script>

<template>
  <SettingsPage page="common">
    <div class="settings-group">
      <header class="settings-group__header">
        <h3 class="settings-group__title">{{ t('settings.shell.pinned') }}</h3>
        <p class="settings-group__description">{{ t('settings.shell.commonHint') }}</p>
      </header>
      <SettingsJumpList :setting-ids="pinnedIds" :columns="2" />
    </div>

    <div class="settings-group">
      <header class="settings-group__header">
        <h3 class="settings-group__title">{{ t('settings.shell.recent') }}</h3>
      </header>
      <SettingsJumpList v-if="recentIds.length > 0" :setting-ids="recentIds" :columns="2" />
      <p v-else class="settings-empty-hint">{{ t('settings.shell.recentEmpty') }}</p>
    </div>
  </SettingsPage>
</template>
