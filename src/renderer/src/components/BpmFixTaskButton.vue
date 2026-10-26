<script setup lang="ts">
import { computed } from 'vue'
import {
  bpmFixSnapshot,
  bpmFixDialogOpen,
  restoreBpmFix,
  initializeBpmFix
} from '@renderer/utils/bpmFixActions'
import { t } from '@renderer/utils/translate'
initializeBpmFix()
const count = computed(
  () => bpmFixSnapshot.value?.tracks.filter((track) => track.status === 'completed').length || 0
)
</script>

<template>
  <button
    v-if="bpmFixSnapshot && !bpmFixDialogOpen"
    class="bpm-restore"
    @click.stop="restoreBpmFix"
  >
    {{ t('bpmFix.restore') }} · {{ count }}/{{ bpmFixSnapshot.tracks.length }}
  </button>
</template>

<style scoped>
.bpm-restore {
  background: var(--bg-elev);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
}
</style>
