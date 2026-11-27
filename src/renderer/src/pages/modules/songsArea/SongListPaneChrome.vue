<script setup lang="ts">
import { useTemplateRef } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'
withDefaults(defineProps<{ title: string; closable?: boolean; placeholder?: string }>(), {
  closable: true
})
const query = defineModel<string>('query', { required: true })
const emit = defineEmits<{ (event: 'close'): void }>()
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')
const clearSearch = () => {
  query.value = ''
  searchInput.value?.focus()
}
</script>
<template>
  <div class="songs-pane-header">
    <div class="songs-pane-header__title">{{ title }}</div>
    <slot />
    <div class="songs-pane-header__search" @click.stop @keydown.stop>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="4.25" />
        <path d="m10 10 3.5 3.5" />
      </svg>
      <input
        ref="searchInput"
        v-model="query"
        type="text"
        :placeholder="placeholder || t('tracks.playlistSearchPlaceholder')"
        :aria-label="placeholder || t('tracks.playlistSearchPlaceholder')"
        autocomplete="off"
        spellcheck="false"
        @keydown.esc.prevent="clearSearch"
      />
      <bubbleBoxTrigger
        v-if="query"
        tag="button"
        class="songs-pane-header__button songs-pane-header__clear"
        type="button"
        :title="t('tracks.clearPlaylistSearch')"
        :aria-label="t('tracks.clearPlaylistSearch')"
        @click.stop="clearSearch"
      >
        <span aria-hidden="true">×</span>
      </bubbleBoxTrigger>
    </div>
    <bubbleBoxTrigger
      v-if="closable"
      tag="button"
      class="songs-pane-header__button"
      type="button"
      :title="t('common.close')"
      :aria-label="t('common.close')"
      @click.stop="emit('close')"
    >
      <span aria-hidden="true">×</span>
    </bubbleBoxTrigger>
  </div>
</template>
<style scoped lang="scss" src="./SongListPaneChrome.scss"></style>
