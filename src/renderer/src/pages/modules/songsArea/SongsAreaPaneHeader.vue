<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import EmptyRecycleBinIcon from '@renderer/components/EmptyRecycleBinIcon.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore, type SongsAreaPaneKey } from '@renderer/stores/runtime'
import {
  isPlaylistViewNode,
  usePlaylistViewSettingsStore
} from '@renderer/stores/playlistViewSettings'
import libraryUtils from '@renderer/utils/libraryUtils'
import { useHarmonicReferenceKey } from '@renderer/composables/useHarmonicReferenceKey'
import { isHarmonicMixCompatible } from '@shared/keyDisplay'

const props = defineProps<{
  title: string
  showEmptyRecycleBinButton: boolean
  pane: SongsAreaPaneKey
}>()
const searchQuery = defineModel<string>('searchQuery', { required: true })
const compatibleKeyOnly = defineModel<boolean>('compatibleKeyOnly', { required: true })
const runtime = useRuntimeStore()
const viewSettings = usePlaylistViewSettingsStore()
const paneState = computed(() => runtime.songsAreaPanels.panes[props.pane])
const playlistNode = computed(() => libraryUtils.getLibraryTreeByUUID(paneState.value.songListUUID))
const canCustomize = computed(
  () => !!runtime.libraryTree.uuid && isPlaylistViewNode(playlistNode.value)
)
const independentSettings = computed({
  get: () =>
    canCustomize.value &&
    viewSettings.getPlaylist(
      runtime.libraryTree.uuid,
      paneState.value.songListUUID,
      runtime.setting.persistSongFilters
    )?.enabled === true,
  set: (enabled: boolean) => {
    if (!canCustomize.value) return
    viewSettings.setIndependent(
      runtime.libraryTree.uuid,
      paneState.value.songListUUID,
      playlistNode.value?.type === 'mixtapeList' ? 'mixtape' : 'default',
      enabled,
      compatibleKeyOnly.value,
      runtime.setting.persistSongFilters
    )
  }
})
const harmonicReferenceKey = useHarmonicReferenceKey(runtime)
const hasHarmonicReference = computed(() =>
  isHarmonicMixCompatible(harmonicReferenceKey.value, harmonicReferenceKey.value)
)
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'empty-recycle-bin'): void
}>()
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')
const clearSearch = () => {
  searchQuery.value = ''
  searchInput.value?.focus()
}
</script>

<template>
  <div class="songs-pane-header">
    <div class="songs-pane-header__title">{{ title }}</div>
    <bubbleBoxTrigger
      v-if="showEmptyRecycleBinButton"
      tag="button"
      class="songs-pane-header__button"
      type="button"
      :title="t('recycleBin.emptyRecycleBin')"
      @click.stop="emit('empty-recycle-bin')"
    >
      <EmptyRecycleBinIcon />
    </bubbleBoxTrigger>
    <bubbleBoxTrigger
      v-if="canCustomize"
      class="songs-pane-header__key-filter"
      :title="
        t(
          independentSettings
            ? 'tracks.independentListSettingsOnHint'
            : 'tracks.independentListSettingsOffHint'
        )
      "
      @click.stop
      @keydown.stop
    >
      <singleCheckbox v-model="independentSettings">
        <span class="songs-pane-header__label-full">{{ t('tracks.independentListSettings') }}</span>
        <span class="songs-pane-header__label-compact">{{
          t('tracks.independentListSettingsCompact')
        }}</span>
      </singleCheckbox>
    </bubbleBoxTrigger>
    <bubbleBoxTrigger
      v-if="runtime.mainWindowBrowseMode !== 'browser'"
      class="songs-pane-header__key-filter"
      :title="
        hasHarmonicReference
          ? t('tracks.compatibleKeyOnlyHint')
          : t('tracks.compatibleKeyNeedsReference')
      "
      @click.stop
      @keydown.stop
    >
      <singleCheckbox
        v-model="compatibleKeyOnly"
        :disabled="!compatibleKeyOnly && !hasHarmonicReference"
      >
        <span class="songs-pane-header__label-full">{{ t('tracks.compatibleKeyOnly') }}</span>
        <span class="songs-pane-header__label-compact">{{
          t('tracks.compatibleKeyOnlyCompact')
        }}</span>
      </singleCheckbox>
    </bubbleBoxTrigger>
    <div class="songs-pane-header__search" @click.stop @keydown.stop>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="4.25" />
        <path d="m10 10 3.5 3.5" />
      </svg>
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="text"
        :placeholder="t('tracks.playlistSearchPlaceholder')"
        :aria-label="t('tracks.playlistSearchPlaceholder')"
        autocomplete="off"
        spellcheck="false"
        @keydown.esc.prevent="clearSearch"
      />
      <bubbleBoxTrigger
        v-if="searchQuery"
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

<style scoped lang="scss">
.songs-pane-header {
  container: songs-pane-header / inline-size;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  min-width: 0;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 90%, var(--font-color) 10%);
  flex-shrink: 0;
}

.songs-pane-header__label-compact {
  display: none;
}

@container songs-pane-header (max-width: 460px) {
  .songs-pane-header__label-full {
    display: none;
  }

  .songs-pane-header__label-compact {
    display: inline;
  }
}

.songs-pane-header__title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--font-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.songs-pane-header__button {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--font-color);
  cursor: pointer;
  flex-shrink: 0;

  &:hover {
    background: color-mix(in srgb, var(--main-color) 18%, transparent);
  }
}

.songs-pane-header__key-filter {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  font-size: 12px;
  white-space: nowrap;

  :deep(.checkBoxContainer) {
    gap: 5px;
  }

  :deep(.checkBox) {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }

  :deep(.checkBox .box) {
    width: 12px;
    height: 12px;
  }

  :deep(.checkBox .box::after) {
    width: 7px;
    height: 4px;
    top: 2px;
    left: 2px;
  }
}

.songs-pane-header__search {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 190px;
  max-width: 50%;
  min-width: 0;
  height: 25px;
  padding: 0 5px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--font-color);

  &:focus-within {
    border-color: var(--accent);
  }

  > svg {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    opacity: 0.65;
  }

  input {
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    user-select: text;
    -webkit-user-select: text;

    &::placeholder {
      color: var(--font-color);
      opacity: 0.55;
    }
  }
}

.songs-pane-header__clear {
  width: 18px;
  height: 18px;
  border-radius: 3px;
}
</style>
