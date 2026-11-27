<script setup lang="ts">
import { computed } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import SongListPaneChrome from './SongListPaneChrome.vue'
import EmptyRecycleBinIcon from '@renderer/components/EmptyRecycleBinIcon.vue'
import SongListSettingsToggle from './SongListSettingsToggle.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore, type SongsAreaPaneKey } from '@renderer/stores/runtime'
import {
  isPlaylistViewNode,
  usePlaylistViewSettingsStore
} from '@renderer/stores/playlistViewSettings'
import libraryUtils from '@renderer/utils/libraryUtils'
import { resolveSongsAreaColumnMode } from '@renderer/pages/modules/songsArea/composables/songColumnStorage'
import { useHarmonicReferenceKey } from '@renderer/composables/useHarmonicReferenceKey'
import { isHarmonicMixCompatible } from '@shared/keyDisplay'

const props = defineProps<{
  title: string
  showEmptyRecycleBinButton: boolean
  pane: SongsAreaPaneKey
  /** 「查看已下载」的合计文案（共 N 首 · 12.3GB）；空串表示不显示 */
  neteaseSummaryText?: string
  /** 已不在任何歌单的缓存数量；0 表示没有可清理的 */
  neteaseOrphanCount?: number
}>()
const searchQuery = defineModel<string>('searchQuery', { required: true })
const compatibleKeyOnly = defineModel<boolean>('compatibleKeyOnly', { required: true })
const runtime = useRuntimeStore()
const viewSettings = usePlaylistViewSettingsStore()
const paneState = computed(() => runtime.songsAreaPanels.panes[props.pane])
const playlistNode = computed(() => libraryUtils.getLibraryTreeByUUID(paneState.value.songListUUID))
const canCustomize = computed(
  () =>
    !!runtime.libraryTree.uuid &&
    (Boolean(paneState.value.djPlaylist) || isPlaylistViewNode(playlistNode.value))
)
const listColumnMode = computed(() =>
  resolveSongsAreaColumnMode(paneState.value.songListUUID, playlistNode.value?.type)
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
      listColumnMode.value,
      enabled,
      compatibleKeyOnly.value,
      runtime.setting.persistSongFilters
    )
  }
})
const independentSettingsHint = computed(() => {
  const netease = listColumnMode.value === 'netease'
  if (independentSettings.value) {
    return netease
      ? 'tracks.independentListSettingsOnHintNetease'
      : 'tracks.independentListSettingsOnHint'
  }
  return netease
    ? 'tracks.independentListSettingsOffHintNetease'
    : 'tracks.independentListSettingsOffHint'
})
const harmonicReferenceKey = useHarmonicReferenceKey(runtime)
const hasHarmonicReference = computed(() =>
  isHarmonicMixCompatible(harmonicReferenceKey.value, harmonicReferenceKey.value)
)
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'empty-recycle-bin'): void
  (event: 'cleanup-netease-orphans'): void
}>()
</script>

<template>
  <SongListPaneChrome v-model:query="searchQuery" :title="title" @close="emit('close')">
    <span v-if="props.neteaseSummaryText" class="songs-pane-header__netease-summary">{{
      props.neteaseSummaryText
    }}</span>
    <bubbleBoxTrigger
      v-if="(props.neteaseOrphanCount || 0) > 0"
      tag="button"
      class="songs-pane-header__button songs-pane-header__button--text"
      type="button"
      :title="t('netease.orphanHint')"
      @click.stop="emit('cleanup-netease-orphans')"
    >
      {{ t('netease.orphanGroup') }} ({{ props.neteaseOrphanCount }})
    </bubbleBoxTrigger>
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
    <SongListSettingsToggle
      v-if="canCustomize"
      v-model="independentSettings"
      :hint="t(independentSettingsHint)"
    />
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
  </SongListPaneChrome>
</template>
<style scoped lang="scss" src="./SongListPaneChrome.scss"></style>
