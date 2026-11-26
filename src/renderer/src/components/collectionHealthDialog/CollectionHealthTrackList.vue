<script setup lang="ts">
import { computed, ref } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import CollectionHealthPlaylistCell from './CollectionHealthPlaylistCell.vue'
import type { CollectionHealthCheck, CollectionHealthTrackHit } from '@shared/collectionHealth'

const props = defineProps<{
  check: CollectionHealthCheck
  rows: CollectionHealthTrackHit[]
  ignored: CollectionHealthTrackHit[]
  showBitrate?: boolean
  showAutoFill?: boolean
}>()

const emits = defineEmits<{
  (e: 'ignore', hit: CollectionHealthTrackHit): void
  (e: 'restore', hit: CollectionHealthTrackHit): void
  (e: 'edit', hit: CollectionHealthTrackHit): void
  (e: 'remove', hit: CollectionHealthTrackHit): void
  (e: 'locate', hit: CollectionHealthTrackHit): void
  (e: 'autofill', hits: CollectionHealthTrackHit[]): void
}>()

const ignoredOpen = ref(false)

const displayName = (hit: CollectionHealthTrackHit) => hit.title || hit.fileName

const rowKey = (hit: CollectionHealthTrackHit) => `${hit.listRoot}\u0000${hit.filePath}`

const emptyText = computed(() => {
  if (props.check === 'lowBitrate') return t('collectionHealth.lowBitrate.empty')
  if (props.check === 'noCover') return t('collectionHealth.noCover.empty')
  return t('collectionHealth.empty')
})
</script>

<template>
  <div class="track-panel">
    <div v-if="!rows.length && !ignored.length" class="empty-state">
      {{ emptyText }}
    </div>
    <OverlayScrollbarsComponent
      v-else
      class="track-scroll"
      element="div"
      :options="{
        scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
        overflow: { x: 'hidden', y: 'scroll' } as const
      }"
    >
      <div class="track-list">
        <div v-for="hit in rows" :key="rowKey(hit)" class="track-row">
          <div class="track-info">
            <bubbleBoxTrigger
              tag="div"
              class="track-title"
              :title="displayName(hit)"
              :max-width="360"
              only-when-overflow
            >
              {{ displayName(hit) }}
            </bubbleBoxTrigger>
            <div class="track-sub">
              <bubbleBoxTrigger
                tag="span"
                class="track-artist"
                :title="hit.artist || t('collectionHealth.unknownArtist')"
                :max-width="280"
                only-when-overflow
              >
                {{ hit.artist || t('collectionHealth.unknownArtist') }}
              </bubbleBoxTrigger>
              <span class="track-dot">·</span>
              <bubbleBoxTrigger
                tag="span"
                class="track-file"
                :title="hit.fileName"
                :max-width="360"
                only-when-overflow
              >
                {{ hit.fileName }}
              </bubbleBoxTrigger>
            </div>
          </div>
          <CollectionHealthPlaylistCell :name="hit.songListName" :path="hit.songListPath" />
          <div class="track-meta">
            <span v-if="showBitrate && hit.bitrate" class="bitrate-chip">
              {{ t('collectionHealth.lowBitrate.bitrateValue', { kbps: hit.bitrate }) }}
            </span>
            <span v-if="hit.duration" class="duration">{{ hit.duration }}</span>
          </div>
          <div class="track-actions">
            <button
              v-if="showAutoFill"
              type="button"
              class="mini-button"
              @click="emits('autofill', [hit])"
            >
              {{ t('collectionHealth.noCover.autoFillOne') }}
            </button>
            <button type="button" class="mini-button" @click="emits('locate', hit)">
              {{ t('collectionHealth.locate') }}
            </button>
            <button type="button" class="mini-button" @click="emits('edit', hit)">
              {{ t('collectionHealth.edit') }}
            </button>
            <button type="button" class="mini-button muted" @click="emits('remove', hit)">
              {{ t('collectionHealth.removeTrack') }}
            </button>
            <button type="button" class="mini-button muted" @click="emits('ignore', hit)">
              {{ t('collectionHealth.ignore') }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="ignored.length" class="ignored-section">
        <button type="button" class="ignored-toggle" @click="ignoredOpen = !ignoredOpen">
          <span class="ignored-arrow" :class="{ open: ignoredOpen }">▸</span>
          {{ t('collectionHealth.ignoredCount', { count: ignored.length }) }}
        </button>
        <div v-if="ignoredOpen" class="ignored-list">
          <div v-for="hit in ignored" :key="rowKey(hit)" class="ignored-row">
            <div class="track-info">
              <bubbleBoxTrigger
                tag="div"
                class="track-title ignored-title"
                :title="displayName(hit)"
                :max-width="360"
                only-when-overflow
              >
                {{ displayName(hit) }}
              </bubbleBoxTrigger>
            </div>
            <CollectionHealthPlaylistCell :name="hit.songListName" :path="hit.songListPath" />
            <button type="button" class="mini-button" @click="emits('restore', hit)">
              {{ t('collectionHealth.restoreIgnore') }}
            </button>
          </div>
        </div>
      </div>
    </OverlayScrollbarsComponent>
  </div>
</template>

<style scoped lang="scss">
.track-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.track-scroll {
  flex: 1;
  min-height: 0;
}
.track-list {
  display: flex;
  flex-direction: column;
}
.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 13px;
  padding: 40px 0;
}
.track-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--divider);
  &:hover {
    background-color: var(--hover);
  }
}
.track-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.track-title {
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.track-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
}
.track-artist,
.track-file {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.track-file {
  color: var(--text-weak);
}
.track-dot {
  color: var(--text-weak);
  flex-shrink: 0;
}
.track-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.bitrate-chip {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 9px;
  color: var(--warning-text);
  background-color: rgba(138, 75, 0, 0.14);
}
.duration {
  font-size: 12px;
  color: var(--text-weak);
  min-width: 36px;
  text-align: right;
}
.track-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.mini-button {
  appearance: none;
  border: 1px solid var(--border);
  background-color: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
  &:hover {
    color: #ffffff;
    border-color: var(--accent);
    background-color: var(--accent);
  }
  &.muted {
    color: var(--text-secondary);
  }
}
.ignored-section {
  border-top: 1px solid var(--border);
  padding: 6px 10px 10px;
}
.ignored-toggle {
  appearance: none;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 4px 0;
  display: flex;
  align-items: center;
  gap: 6px;
  &:hover {
    color: var(--text);
  }
}
.ignored-arrow {
  display: inline-block;
  transition: transform 0.15s ease;
  &.open {
    transform: rotate(90deg);
  }
}
.ignored-list {
  display: flex;
  flex-direction: column;
}
.ignored-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 5px 0;
  border-top: 1px dashed var(--divider);
}
.ignored-title {
  color: var(--text-secondary);
}
</style>
