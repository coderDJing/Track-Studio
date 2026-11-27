<script setup lang="ts">
import { ref } from 'vue'
import pkg from '../../../../../package.json'
import { t } from '@renderer/utils/translate'
import { SETTINGS_PAGES, type SettingsPageId } from './settingsCatalog'

const props = defineProps<{
  searchQuery: string
  activePage: SettingsPageId
  searchActive: boolean
}>()

const emits = defineEmits<{
  (e: 'update:searchQuery', value: string): void
  (e: 'openPage', page: SettingsPageId): void
  (e: 'escape'): void
}>()

const searchInput = ref<HTMLInputElement | null>(null)

const focusSearch = () => {
  searchInput.value?.focus()
  searchInput.value?.select()
}

const handleInput = (event: Event) => {
  emits('update:searchQuery', (event.target as HTMLInputElement).value)
}

const clearSearch = () => {
  emits('update:searchQuery', '')
  focusSearch()
}

const handleInputEscape = (event: KeyboardEvent) => {
  if (event.isComposing) return
  event.preventDefault()
  event.stopPropagation()
  emits('escape')
}

defineExpose({ focusSearch })
</script>

<template>
  <aside class="settings-sidebar">
    <div class="settings-search">
      <input
        ref="searchInput"
        class="settings-search__input"
        type="text"
        :value="props.searchQuery"
        :placeholder="t('settings.shell.searchPlaceholder')"
        spellcheck="false"
        @input="handleInput"
        @keydown.esc="handleInputEscape"
      />
      <button
        v-if="props.searchQuery"
        type="button"
        class="settings-search__clear"
        :aria-label="t('settings.shell.clearSearch')"
        @click="clearSearch"
      >
        ×
      </button>
    </div>

    <nav class="settings-nav">
      <button
        v-for="page in SETTINGS_PAGES"
        :key="page.id"
        type="button"
        class="settings-nav-item"
        :class="{
          'settings-nav-item--active': !props.searchActive && props.activePage === page.id,
          'settings-nav-item--common': page.id === 'common'
        }"
        @click="emits('openPage', page.id)"
      >
        <span class="settings-nav-item__label">{{ t(page.labelKey) }}</span>
      </button>
    </nav>

    <div class="settings-sidebar__footer">
      <span class="settings-sidebar__version">v{{ pkg.version }}</span>
    </div>
  </aside>
</template>
