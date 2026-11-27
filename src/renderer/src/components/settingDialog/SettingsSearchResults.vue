<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@renderer/utils/translate'
import {
  SETTINGS_BY_ID,
  SETTINGS_PAGES,
  type SettingId,
  type SettingsPageMeta
} from './settingsCatalog'
import SettingsJumpList from './SettingsJumpList.vue'

const props = defineProps<{
  query: string
  resultIds: SettingId[]
}>()

type ResultGroup = {
  page: SettingsPageMeta
  ids: SettingId[]
}

const groups = computed<ResultGroup[]>(() => {
  const result: ResultGroup[] = []
  for (const page of SETTINGS_PAGES) {
    if (page.id === 'common') continue
    const ids = props.resultIds.filter((id) => SETTINGS_BY_ID[id]?.page === page.id)
    if (ids.length > 0) {
      result.push({ page, ids })
    }
  }
  return result
})
</script>

<template>
  <section class="settings-search-results">
    <header class="settings-search-results__header">
      <div>
        <h2 class="settings-search-results__title">{{ t('settings.shell.resultsTitle') }}</h2>
        <p class="settings-search-results__subtitle">
          {{
            t('settings.shell.resultsCount', {
              count: props.resultIds.length,
              query: props.query
            })
          }}
        </p>
      </div>
    </header>

    <div v-if="groups.length === 0" class="settings-search-results__empty">
      <div class="settings-search-results__empty-title">{{ t('settings.shell.emptyTitle') }}</div>
      <div class="settings-search-results__empty-desc">{{ t('settings.shell.emptyDesc') }}</div>
    </div>

    <div v-for="group in groups" :key="group.page.id" class="settings-search-results__group">
      <h3 class="settings-search-results__group-title">{{ t(group.page.labelKey) }}</h3>
      <SettingsJumpList :setting-ids="group.ids" :columns="1" :show-category="false" />
    </div>
  </section>
</template>
