<script setup lang="ts">
defineProps<{
  overlay?: boolean
  loading?: boolean
  title?: string
  hint?: string
  alert?: boolean
}>()
</script>
<template>
  <div v-if="loading" class="loading-wrapper" :class="{ 'state-overlay': overlay }" role="status">
    <div class="loading"></div>
  </div>
  <div v-else class="songs-area-empty-overlay unselectable" :role="alert ? 'alert' : 'status'">
    <div class="empty-box">
      <div class="title">{{ title }}</div>
      <div v-if="hint" class="hint">{{ hint }}</div>
    </div>
  </div>
</template>
<style scoped lang="scss" src="./songsArea.scss"></style>

<style scoped>
.state-overlay {
  position: absolute;
  inset: 0;
  background: var(--bg);
  z-index: 1;
}
</style>
