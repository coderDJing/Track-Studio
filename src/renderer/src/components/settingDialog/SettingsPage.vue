<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@renderer/utils/translate'
import { SETTINGS_PAGE_BY_ID, type SettingsPageId } from './settingsCatalog'

const props = defineProps<{
  page: SettingsPageId
}>()

const meta = computed(() => SETTINGS_PAGE_BY_ID[props.page])
</script>

<template>
  <section class="settings-page" :class="`settings-page--${page}`">
    <header class="settings-page__header">
      <h2 class="settings-page__title">{{ t(meta.labelKey) }}</h2>
      <p class="settings-page__description">{{ t(meta.descKey) }}</p>
    </header>
    <slot />
  </section>
</template>
