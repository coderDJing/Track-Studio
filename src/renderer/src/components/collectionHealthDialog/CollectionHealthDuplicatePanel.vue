<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import type {
  CollectionHealthDuplicateGroup,
  CollectionHealthDuplicateTrack,
  CollectionHealthTrackHit
} from '@shared/collectionHealth'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

const props = defineProps<{
  groups: CollectionHealthDuplicateGroup[]
  ignored: CollectionHealthTrackHit[]
}>()

const emits = defineEmits<{
  (e: 'remove', group: CollectionHealthDuplicateGroup, keepFilePath: string): void
  (e: 'mark', group: CollectionHealthDuplicateGroup): void
  (e: 'ignore', hit: CollectionHealthDuplicateTrack): void
  (e: 'edit', hit: CollectionHealthTrackHit): void
  (e: 'restore', hit: CollectionHealthTrackHit): void
}>()

const keepByGroup = reactive(new Map<string, string>())
const ignoredOpen = ref(false)

const filePathKey = (value: string) =>
  normalizeFilePathForComparison(value, isCurrentRendererWindowsPathPlatform())

const keeperOf = (group: CollectionHealthDuplicateGroup): string => {
  const stored = keepByGroup.get(group.groupId)
  if (stored && group.tracks.some((track) => filePathKey(track.filePath) === filePathKey(stored)))
    return stored
  return group.tracks[0]?.filePath || ''
}

const setKeeper = (group: CollectionHealthDuplicateGroup, filePath: string) => {
  keepByGroup.set(group.groupId, filePath)
}

const displayName = (track: { title?: string; fileName: string }) => track.title || track.fileName

const rowKey = (track: { listRoot: string; filePath: string }) =>
  `${track.listRoot}\u0000${track.filePath}`

const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const totalGroups = computed(() => props.groups.length)

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
</script>

<template>
  <div class="duplicate-panel">
    <div v-if="!totalGroups" class="empty-state">
      {{ t('collectionHealth.duplicates.empty') }}
    </div>
    <OverlayScrollbarsComponent
      v-else
      class="duplicate-scroll"
      element="div"
      :options="{
        scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
        overflow: { x: 'hidden', y: 'scroll' } as const
      }"
    >
      <div class="duplicate-list">
        <div v-for="group in groups" :key="group.groupId" class="duplicate-card">
          <div class="duplicate-card-header">
            <span class="duplicate-title">
              {{ t('collectionHealth.duplicates.groupTitle', { count: group.tracks.length }) }}
            </span>
            <span class="duplicate-hint">{{ t('collectionHealth.duplicates.keepHint') }}</span>
          </div>

          <div class="duplicate-tracks">
            <div
              v-for="track in group.tracks"
              :key="rowKey(track)"
              class="duplicate-track"
              :class="{ keeper: keeperOf(group) === track.filePath }"
              @click="setKeeper(group, track.filePath)"
            >
              <span class="keep-radio" :class="{ checked: keeperOf(group) === track.filePath }" />
              <div class="duplicate-info">
                <bubbleBoxTrigger
                  tag="div"
                  class="duplicate-name"
                  :title="displayName(track)"
                  :max-width="380"
                  only-when-overflow
                >
                  {{ displayName(track) }}
                </bubbleBoxTrigger>
                <div class="duplicate-sub">
                  <span>{{ track.artist || t('collectionHealth.unknownArtist') }}</span>
                  <template v-if="track.songListName">
                    <span class="dot">·</span>
                    <span>{{ track.songListName }}</span>
                  </template>
                  <span class="dot">·</span>
                  <bubbleBoxTrigger
                    tag="span"
                    class="duplicate-file"
                    :title="track.fileName"
                    :max-width="360"
                    only-when-overflow
                  >
                    {{ track.fileName }}
                  </bubbleBoxTrigger>
                </div>
              </div>
              <div class="duplicate-meta">
                <span v-if="track.bitrate" class="meta-chip">{{ track.bitrate }} kbps</span>
                <span v-if="formatSize(track.size)" class="meta-chip">{{
                  formatSize(track.size)
                }}</span>
                <span v-if="track.duration" class="meta-duration">{{ track.duration }}</span>
              </div>
              <div class="duplicate-actions" @click.stop>
                <button type="button" class="mini-button" @click="emits('edit', toTrackHit(track))">
                  {{ t('collectionHealth.edit') }}
                </button>
                <button
                  v-if="group.tracks.length > 2"
                  type="button"
                  class="mini-button muted"
                  @click="emits('ignore', track)"
                >
                  {{ t('collectionHealth.ignore') }}
                </button>
              </div>
            </div>
          </div>

          <div class="duplicate-footer">
            <button type="button" class="mini-button muted" @click="emits('mark', group)">
              {{ t('collectionHealth.duplicates.markNotDuplicate') }}
            </button>
            <button
              type="button"
              class="mini-button danger"
              @click="emits('remove', group, keeperOf(group))"
            >
              {{
                t('collectionHealth.duplicates.keepAndRemove', {
                  count: group.tracks.length - 1
                })
              }}
            </button>
          </div>
        </div>

        <div v-if="ignored.length" class="ignored-section">
          <button type="button" class="ignored-toggle" @click="ignoredOpen = !ignoredOpen">
            <span class="ignored-arrow" :class="{ open: ignoredOpen }">▸</span>
            {{ t('collectionHealth.ignoredCount', { count: ignored.length }) }}
          </button>
          <div v-if="ignoredOpen" class="ignored-list">
            <div v-for="hit in ignored" :key="rowKey(hit)" class="ignored-row">
              <div class="duplicate-info">
                <bubbleBoxTrigger
                  tag="div"
                  class="duplicate-name ignored-name"
                  :title="displayName(hit)"
                  :max-width="360"
                  only-when-overflow
                >
                  {{ displayName(hit) }}
                </bubbleBoxTrigger>
                <div class="duplicate-sub">
                  <span>{{ hit.artist || t('collectionHealth.unknownArtist') }}</span>
                </div>
              </div>
              <button type="button" class="mini-button" @click="emits('restore', hit)">
                {{ t('collectionHealth.restoreIgnore') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </OverlayScrollbarsComponent>
  </div>
</template>

<style scoped lang="scss">
.duplicate-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.duplicate-scroll {
  flex: 1;
  min-height: 0;
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
.duplicate-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 8px;
}
.duplicate-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg);
  overflow: hidden;
}
.duplicate-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background-color: var(--bg-elev);
  border-bottom: 1px solid var(--divider);
}
.duplicate-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.duplicate-hint {
  font-size: 11px;
  color: var(--text-weak);
}
.duplicate-tracks {
  display: flex;
  flex-direction: column;
}
.duplicate-track {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  cursor: pointer;
  border-bottom: 1px dashed var(--divider);
  &:last-child {
    border-bottom: none;
  }
  &:hover {
    background-color: var(--hover);
  }
  &.keeper {
    background-color: rgba(0, 120, 212, 0.08);
  }
}
.keep-radio {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1.5px solid var(--text-weak);
  flex-shrink: 0;
  position: relative;
  &.checked {
    border-color: var(--accent);
    &::after {
      content: '';
      position: absolute;
      inset: 2px;
      border-radius: 50%;
      background-color: var(--accent);
    }
  }
}
.duplicate-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.duplicate-name {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.duplicate-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}
.duplicate-file {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-weak);
}
.dot {
  color: var(--text-weak);
}
.duplicate-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.meta-chip {
  font-size: 11px;
  color: var(--text-secondary);
  background-color: var(--hover);
  border-radius: 8px;
  padding: 1px 7px;
}
.meta-duration {
  font-size: 11px;
  color: var(--text-weak);
}
.duplicate-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.duplicate-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--divider);
}
.mini-button {
  appearance: none;
  border: 1px solid var(--border);
  background-color: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  border-radius: 4px;
  padding: 3px 9px;
  cursor: pointer;
  &:hover {
    color: #ffffff;
    border-color: var(--accent);
    background-color: var(--accent);
  }
  &.muted {
    color: var(--text-secondary);
  }
  &.danger {
    color: var(--danger-text);
    border-color: var(--danger-text);
    &:hover {
      color: #ffffff;
      background-color: var(--danger-text);
      border-color: var(--danger-text);
    }
  }
}
.ignored-section {
  border-top: 1px solid var(--border);
  padding: 6px 2px 4px;
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
  gap: 10px;
  padding: 4px 0;
}
.ignored-name {
  color: var(--text-secondary);
}
</style>
