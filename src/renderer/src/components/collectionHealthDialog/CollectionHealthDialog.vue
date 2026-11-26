<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import hotkeys from 'hotkeys-js'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import CollectionHealthTrackList from './CollectionHealthTrackList.vue'
import CollectionHealthAlbumPanel from './CollectionHealthAlbumPanel.vue'
import CollectionHealthDuplicatePanel from './CollectionHealthDuplicatePanel.vue'
import { useCollectionHealthDialog } from './useCollectionHealthDialog'
import type {
  CollectionHealthAlbumGroup,
  CollectionHealthAlbumVariant,
  CollectionHealthCheck,
  CollectionHealthDuplicateGroup,
  CollectionHealthDuplicateTrack,
  CollectionHealthTrackHit
} from '@shared/collectionHealth'

const props = defineProps<{ libraryName: string }>()
const emits = defineEmits<{ (e: 'close'): void }>()

const scope = `collection_health_dialog_${Math.random().toString(36).slice(2)}`
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const {
  snapshot,
  loading,
  actionBusy,
  loadError,
  threshold,
  thresholdOptions,
  libraryDisplayName,
  enabledChecks,
  activeCheck,
  checkResult,
  checkCount,
  probeTotal,
  probeDone,
  probePercent,
  probing,
  startScan,
  toggleIgnore,
  ignoreTracks,
  editTrack,
  autoFillCovers,
  markGroupNotDuplicate,
  removeDuplicates,
  unifyAlbum
} = useCollectionHealthDialog(props)

const checkLabels: Record<CollectionHealthCheck, string> = {
  lowBitrate: t('collectionHealth.checks.lowBitrate'),
  noCover: t('collectionHealth.checks.noCover'),
  albumTags: t('collectionHealth.checks.albumTags'),
  duplicates: t('collectionHealth.checks.duplicates')
}

const activeResult = computed(() => checkResult(activeCheck.value))

const headerSubtitle = computed(() => {
  if (!snapshot.value) return ''
  return t('collectionHealth.subtitle', { total: probeTotal.value, done: probeDone.value })
})

const scanStatusText = computed(() => {
  if (loading.value) return t('collectionHealth.loading')
  const status = snapshot.value?.checks.duplicates.status
  if (status === 'waiting-idle') return t('collectionHealth.waitingIdle')
  if (status === 'working') return t('collectionHealth.scanning')
  return ''
})

const lowBitrateRows = computed(() => activeResult.value?.trackHits ?? [])
const noCoverRows = computed(() => activeResult.value?.trackHits ?? [])
const albumGroups = computed<CollectionHealthAlbumGroup[]>(
  () => activeResult.value?.albumGroups ?? []
)
const duplicateGroups = computed<CollectionHealthDuplicateGroup[]>(
  () => activeResult.value?.duplicateGroups ?? []
)
const ignoredTracks = computed<CollectionHealthTrackHit[]>(
  () => activeResult.value?.ignoredTracks ?? []
)

const noCoverAutoFillLabel = computed(() =>
  t('collectionHealth.noCover.autoFill', { count: noCoverRows.value.length })
)

const onLowBitrateIgnore = (hit: CollectionHealthTrackHit) =>
  void toggleIgnore('lowBitrate', hit, true)
const onNoCoverIgnore = (hit: CollectionHealthTrackHit) => void toggleIgnore('noCover', hit, true)
const onAlbumIgnoreTrack = (hit: CollectionHealthTrackHit) =>
  void toggleIgnore('albumTags', hit, true)
const onDuplicateIgnore = (hit: CollectionHealthDuplicateTrack) =>
  void toggleIgnore('duplicates', toTrackHit(hit), true)

const onRestore = (check: CollectionHealthCheck, hit: CollectionHealthTrackHit) =>
  void toggleIgnore(check, hit, false)

const toTrackHit = (track: CollectionHealthDuplicateTrack): CollectionHealthTrackHit => ({
  kind: 'track',
  listRoot: track.listRoot,
  filePath: track.filePath,
  fileName: track.fileName,
  title: track.title,
  artist: track.artist,
  album: track.album,
  duration: track.duration,
  bitrate: track.bitrate,
  songListName: track.songListName,
  songListUuid: ''
})

const onAlbumIgnoreVariant = (
  _group: CollectionHealthAlbumGroup,
  variant: CollectionHealthAlbumVariant
) => {
  void ignoreTracks('albumTags', variant.tracks)
}

const onRemoveDuplicates = (group: CollectionHealthDuplicateGroup, keepFilePath: string) => {
  void removeDuplicates(group, keepFilePath)
}

const closeDialog = () => {
  closeWithAnimation(() => emits('close'))
}

onMounted(() => {
  utils.setHotkeysScpoe(scope)
  hotkeys('esc', scope, () => {
    closeDialog()
    return false
  })
})

onUnmounted(() => {
  utils.delHotkeysScope(scope)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header collection-health-header">
        <span class="header-title">
          {{ t('collectionHealth.title', { library: libraryDisplayName }) }}
        </span>
        <span v-if="headerSubtitle" class="header-subtitle">{{ headerSubtitle }}</span>
      </div>

      <div class="health-body">
        <div class="check-nav">
          <button
            v-for="check in enabledChecks"
            :key="check"
            type="button"
            class="check-item"
            :class="{ active: activeCheck === check }"
            @click="activeCheck = check"
          >
            <span class="check-dot" />
            <span class="check-label">{{ checkLabels[check] }}</span>
            <span
              v-if="checkResult(check) && checkResult(check)!.status !== 'ready'"
              class="check-status"
            >
              {{ checkResult(check)!.done }}/{{ checkResult(check)!.total }}
            </span>
            <span v-else class="check-count">{{ checkCount(check) }}</span>
          </button>

          <div v-if="probing" class="nav-progress">
            <div class="nav-progress-bar">
              <div class="nav-progress-fill" :style="{ width: `${probePercent}%` }" />
            </div>
            <div class="nav-progress-text">
              {{ scanStatusText }}
            </div>
          </div>
        </div>

        <div class="health-panel" :class="{ busy: actionBusy }">
          <div v-if="loadError" class="panel-notice error">{{ loadError }}</div>
          <div v-else-if="loading && !snapshot" class="panel-loading">
            {{ t('collectionHealth.loading') }}
          </div>
          <template v-else>
            <div v-if="activeCheck === 'lowBitrate'" class="panel-toolbar">
              <span class="toolbar-label">{{ t('collectionHealth.lowBitrate.threshold') }}</span>
              <BaseSelect
                v-model="threshold"
                class="threshold-select"
                :options="thresholdOptions"
                :aria-label="t('collectionHealth.lowBitrate.threshold')"
              />
              <span class="toolbar-hint">{{ t('collectionHealth.lowBitrate.hint') }}</span>
            </div>
            <div v-else-if="activeCheck === 'noCover'" class="panel-toolbar">
              <button
                type="button"
                class="toolbar-button"
                :disabled="!noCoverRows.length"
                @click="autoFillCovers(noCoverRows)"
              >
                {{ noCoverAutoFillLabel }}
              </button>
              <span class="toolbar-hint">{{ t('collectionHealth.noCover.hint') }}</span>
            </div>
            <div v-else-if="activeCheck === 'albumTags'" class="panel-toolbar">
              <span class="toolbar-hint">{{ t('collectionHealth.album.hint') }}</span>
            </div>
            <div v-else class="panel-toolbar">
              <span class="toolbar-hint">{{ t('collectionHealth.duplicates.hint') }}</span>
            </div>

            <CollectionHealthTrackList
              v-if="activeCheck === 'lowBitrate'"
              check="lowBitrate"
              :rows="lowBitrateRows"
              :ignored="ignoredTracks"
              show-bitrate
              @edit="editTrack"
              @ignore="onLowBitrateIgnore"
              @restore="onRestore('lowBitrate', $event)"
            />
            <CollectionHealthTrackList
              v-else-if="activeCheck === 'noCover'"
              check="noCover"
              :rows="noCoverRows"
              :ignored="ignoredTracks"
              show-auto-fill
              @edit="editTrack"
              @autofill="autoFillCovers"
              @ignore="onNoCoverIgnore"
              @restore="onRestore('noCover', $event)"
            />
            <CollectionHealthAlbumPanel
              v-else-if="activeCheck === 'albumTags'"
              :groups="albumGroups"
              :ignored="ignoredTracks"
              @unify="unifyAlbum"
              @edit="editTrack"
              @ignore="onAlbumIgnoreVariant"
              @restore="onRestore('albumTags', $event)"
            />
            <CollectionHealthDuplicatePanel
              v-else
              :groups="duplicateGroups"
              :ignored="ignoredTracks"
              @remove="onRemoveDuplicates"
              @mark="markGroupNotDuplicate"
              @edit="editTrack"
              @ignore="onDuplicateIgnore"
              @restore="onRestore('duplicates', $event)"
            />
          </template>
        </div>
      </div>

      <div class="dialog-footer collection-health-footer">
        <bubbleBoxTrigger
          tag="span"
          class="footer-note"
          :title="t('collectionHealth.footerNote')"
          :max-width="420"
        >
          {{ t('collectionHealth.footerNote') }}
        </bubbleBoxTrigger>
        <div class="footer-actions">
          <span v-if="actionBusy" class="busy-text">{{ t('collectionHealth.busy') }}</span>
          <div class="button" @click="startScan">{{ t('collectionHealth.refresh') }}</div>
          <div class="button" @click="closeDialog">{{ t('common.close') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: min(1040px, calc(100vw - 56px));
  height: min(84vh, 720px);
  padding: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
}
.collection-health-header {
  gap: 10px;
}
.header-title {
  font-weight: 600;
}
.header-subtitle {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-weak);
}
.health-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 190px 1fr;
}
.check-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 10px;
  border-right: 1px solid var(--border);
  background-color: var(--bg);
  min-height: 0;
}
.check-item {
  appearance: none;
  border: none;
  background: none;
  font-family: inherit;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 5px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  &:hover {
    background-color: var(--hover);
    color: var(--text);
  }
  &.active {
    background-color: var(--hover);
    color: var(--text);
    font-weight: 600;
  }
}
.check-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--accent);
  flex-shrink: 0;
  opacity: 0.85;
}
.check-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.check-count,
.check-status {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-weak);
}
.check-status {
  color: var(--accent);
}
.nav-progress {
  margin-top: 10px;
  padding: 0 4px;
}
.nav-progress-bar {
  height: 3px;
  border-radius: 2px;
  background-color: var(--hover);
  overflow: hidden;
}
.nav-progress-fill {
  height: 100%;
  background-color: var(--accent);
  transition: width 0.25s ease;
}
.nav-progress-text {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-weak);
  line-height: 1.5;
}
.health-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 14px 6px;
  &.busy {
    pointer-events: none;
    opacity: 0.72;
  }
}
.panel-loading,
.panel-notice {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 13px;
}
.panel-notice.error {
  color: var(--danger-text);
}
.panel-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.toolbar-label {
  font-size: 12px;
  color: var(--text-secondary);
}
.threshold-select {
  width: 110px;
}
.toolbar-hint {
  font-size: 12px;
  color: var(--text-weak);
  min-width: 0;
}
.toolbar-button {
  appearance: none;
  border: 1px solid var(--accent);
  background-color: transparent;
  color: var(--accent);
  font-family: inherit;
  font-size: 12px;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  &:hover:not(:disabled) {
    color: #ffffff;
    background-color: var(--accent);
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
}
.collection-health-footer {
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
}
.footer-note {
  font-size: 11px;
  color: var(--text-weak);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.footer-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.busy-text {
  font-size: 12px;
  color: var(--text-weak);
}
</style>
