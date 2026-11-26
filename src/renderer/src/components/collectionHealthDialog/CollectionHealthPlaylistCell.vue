<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'

const props = defineProps<{
  name: string
  path?: string
}>()

const fullPath = computed(() => String(props.path || props.name || '').trim())

const segments = computed(() =>
  fullPath.value ? fullPath.value.split(' / ').filter((item) => item.length > 0) : []
)
</script>

<template>
  <div class="playlist-cell">
    <span class="playlist-label">{{ t('collectionHealth.playlistLabel') }}</span>
    <bubbleBoxTrigger
      v-if="segments.length"
      tag="span"
      class="playlist-path"
      :title="fullPath"
      :max-width="320"
      only-when-overflow
    >
      <template v-for="(segment, index) in segments" :key="`${index}-${segment}`">
        <span v-if="index > 0" class="playlist-sep">/</span>
        <span :class="index === segments.length - 1 ? 'playlist-name' : 'playlist-folder'">
          {{ segment }}
        </span>
      </template>
    </bubbleBoxTrigger>
    <span v-else class="playlist-empty">—</span>
  </div>
</template>

<style scoped lang="scss">
.playlist-cell {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 170px;
  flex-shrink: 0;
  min-width: 0;
  font-size: 12px;
}
.playlist-label {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-weak);
}
.playlist-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.playlist-folder {
  color: var(--text-secondary);
  opacity: 0.6;
}
.playlist-sep {
  margin: 0 3px;
  color: var(--text-secondary);
  opacity: 0.6;
}
.playlist-name {
  color: var(--text-secondary);
}
.playlist-empty {
  color: var(--text-weak);
}
</style>
