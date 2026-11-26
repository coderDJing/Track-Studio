<script setup lang="ts">
import { computed, ref } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import type {
  CollectionHealthAlbumGroup,
  CollectionHealthAlbumVariant,
  CollectionHealthTrackHit
} from '@shared/collectionHealth'

const props = defineProps<{
  groups: CollectionHealthAlbumGroup[]
  ignored: CollectionHealthTrackHit[]
}>()

const emits = defineEmits<{
  (e: 'unify', group: CollectionHealthAlbumGroup, variant: CollectionHealthAlbumVariant): void
  (e: 'ignore', group: CollectionHealthAlbumGroup, variant: CollectionHealthAlbumVariant): void
  (e: 'edit', hit: CollectionHealthTrackHit): void
  (e: 'restore', hit: CollectionHealthTrackHit): void
}>()

const expanded = ref(new Set<string>())
const ignoredOpen = ref(false)

const variantKey = (group: CollectionHealthAlbumGroup, variant: CollectionHealthAlbumVariant) =>
  `${group.groupKey}\u0000${variant.album}`

const toggleVariant = (
  group: CollectionHealthAlbumGroup,
  variant: CollectionHealthAlbumVariant
) => {
  const key = variantKey(group, variant)
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

const isExpanded = (group: CollectionHealthAlbumGroup, variant: CollectionHealthAlbumVariant) =>
  expanded.value.has(variantKey(group, variant))

const displayName = (hit: CollectionHealthTrackHit) => hit.title || hit.fileName

const variantArtistsText = (variant: CollectionHealthAlbumVariant) =>
  variant.artists.length ? variant.artists.join(' / ') : t('collectionHealth.unknownArtist')

const rowKey = (hit: CollectionHealthTrackHit) => `${hit.listRoot}\u0000${hit.filePath}`

const totalHits = computed(() => props.groups.length)
</script>

<template>
  <div class="album-panel">
    <div v-if="!totalHits" class="empty-state">
      {{ t('collectionHealth.album.empty') }}
    </div>
    <OverlayScrollbarsComponent
      v-else
      class="album-scroll"
      element="div"
      :options="{
        scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
        overflow: { x: 'hidden', y: 'scroll' } as const
      }"
    >
      <div class="album-list">
        <div v-for="group in groups" :key="group.groupKey" class="album-card">
          <div class="album-card-header">
            <bubbleBoxTrigger
              tag="div"
              class="album-name"
              :title="group.displayName"
              :max-width="420"
              only-when-overflow
            >
              {{ group.displayName }}
            </bubbleBoxTrigger>
            <span class="album-count">
              {{ t('collectionHealth.album.trackCount', { count: group.trackCount }) }}
            </span>
            <bubbleBoxTrigger
              v-if="group.artistConflict"
              tag="span"
              class="conflict-chip"
              :title="t('collectionHealth.album.artistConflictHint')"
              :max-width="320"
            >
              {{ t('collectionHealth.album.artistConflict') }}
            </bubbleBoxTrigger>
          </div>

          <div class="variant-list">
            <div v-for="variant in group.variants" :key="variant.album" class="variant-block">
              <div class="variant-row">
                <button type="button" class="variant-toggle" @click="toggleVariant(group, variant)">
                  <span class="variant-arrow" :class="{ open: isExpanded(group, variant) }">▸</span>
                  <bubbleBoxTrigger
                    tag="span"
                    class="variant-name"
                    :title="variant.album || t('collectionHealth.album.emptyAlbum')"
                    :max-width="380"
                    only-when-overflow
                  >
                    {{ variant.album || t('collectionHealth.album.emptyAlbum') }}
                  </bubbleBoxTrigger>
                  <span class="variant-count">{{ variant.count }}</span>
                </button>
                <bubbleBoxTrigger
                  tag="span"
                  class="variant-artists"
                  :title="variantArtistsText(variant)"
                  :max-width="320"
                  only-when-overflow
                >
                  {{ variantArtistsText(variant) }}
                </bubbleBoxTrigger>
                <div class="variant-actions">
                  <button
                    v-if="group.variants.length > 1"
                    type="button"
                    class="mini-button primary"
                    @click="emits('unify', group, variant)"
                  >
                    {{ t('collectionHealth.album.unifyToThis') }}
                  </button>
                  <button
                    type="button"
                    class="mini-button muted"
                    @click="emits('ignore', group, variant)"
                  >
                    {{ t('collectionHealth.album.ignoreVariant', { count: variant.count }) }}
                  </button>
                </div>
              </div>

              <div v-if="isExpanded(group, variant)" class="variant-tracks">
                <div v-for="hit in variant.tracks" :key="rowKey(hit)" class="variant-track-row">
                  <div class="variant-track-info">
                    <bubbleBoxTrigger
                      tag="div"
                      class="variant-track-title"
                      :title="displayName(hit)"
                      :max-width="360"
                      only-when-overflow
                    >
                      {{ displayName(hit) }}
                    </bubbleBoxTrigger>
                    <span class="variant-track-sub">
                      {{ hit.artist || t('collectionHealth.unknownArtist') }}
                      <template v-if="hit.songListName"> · {{ hit.songListName }}</template>
                    </span>
                  </div>
                  <button type="button" class="mini-button" @click="emits('edit', hit)">
                    {{ t('collectionHealth.edit') }}
                  </button>
                </div>
              </div>
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
              <div class="variant-track-info">
                <bubbleBoxTrigger
                  tag="div"
                  class="variant-track-title ignored-title"
                  :title="displayName(hit)"
                  :max-width="360"
                  only-when-overflow
                >
                  {{ displayName(hit) }}
                </bubbleBoxTrigger>
                <span class="variant-track-sub">{{
                  hit.album || t('collectionHealth.album.emptyAlbum')
                }}</span>
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
.album-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.album-scroll {
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
.album-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 8px;
}
.album-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg);
  overflow: hidden;
}
.album-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background-color: var(--bg-elev);
  border-bottom: 1px solid var(--divider);
}
.album-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.album-count {
  font-size: 12px;
  color: var(--text-weak);
  flex-shrink: 0;
}
.conflict-chip {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 9px;
  color: var(--warning-text);
  background-color: rgba(138, 75, 0, 0.14);
  flex-shrink: 0;
}
.variant-list {
  display: flex;
  flex-direction: column;
}
.variant-block {
  & + & {
    border-top: 1px dashed var(--divider);
  }
}
.variant-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  &:hover {
    background-color: var(--hover);
  }
}
.variant-toggle {
  appearance: none;
  border: none;
  background: none;
  color: inherit;
  font-family: inherit;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 46%;
  padding: 0;
  cursor: pointer;
  font-size: 13px;
}
.variant-arrow {
  display: inline-block;
  color: var(--text-weak);
  transition: transform 0.15s ease;
  flex-shrink: 0;
  &.open {
    transform: rotate(90deg);
  }
}
.variant-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.variant-count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-secondary);
  background-color: var(--hover);
  border-radius: 8px;
  padding: 0 7px;
}
.variant-artists {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.variant-actions {
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
  &.primary {
    border-color: var(--accent);
    color: var(--accent);
    &:hover {
      color: #ffffff;
    }
  }
  &.muted {
    color: var(--text-secondary);
  }
}
.variant-tracks {
  padding: 2px 12px 8px 28px;
  display: flex;
  flex-direction: column;
}
.variant-track-row,
.ignored-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.variant-track-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.variant-track-title {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.variant-track-sub {
  font-size: 11px;
  color: var(--text-weak);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ignored-title {
  color: var(--text-secondary);
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
</style>
