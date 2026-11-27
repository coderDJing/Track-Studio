<script setup lang="ts">
import { computed, inject } from 'vue'
import { t } from '@renderer/utils/translate'
import { SETTINGS_BY_ID, SETTINGS_PAGE_BY_ID, type SettingId } from './settingsCatalog'
import { settingDialogContextKey, type SettingDialogContext } from './context'

const props = withDefaults(
  defineProps<{
    settingIds: SettingId[]
    columns?: 1 | 2
    showCategory?: boolean
  }>(),
  {
    showCategory: true
  }
)

const ctx = inject<SettingDialogContext>(settingDialogContextKey)
if (!ctx) throw new Error('settingDialogContext is missing')

const items = computed(() =>
  props.settingIds
    .map((id) => {
      const meta = SETTINGS_BY_ID[id]
      if (!meta) return null
      const page = SETTINGS_PAGE_BY_ID[meta.page]
      return {
        id,
        label: t(meta.labelKey),
        pageLabel: t(page.labelKey)
      }
    })
    .filter((item): item is { id: SettingId; label: string; pageLabel: string } => item !== null)
)
</script>

<template>
  <div class="settings-jump-list" :class="{ 'settings-jump-list--two-columns': columns === 2 }">
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      class="settings-jump-item"
      @click="ctx.navigateToSetting(item.id)"
    >
      <span class="settings-jump-item__label">{{ item.label }}</span>
      <span v-if="showCategory !== false" class="settings-jump-item__meta">{{
        item.pageLabel
      }}</span>
      <span class="settings-jump-item__arrow" aria-hidden="true">›</span>
    </button>
  </div>
</template>
