<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  filePath: string
  getCoverUrl: (filePath: string) => string | null | undefined
}>()
const emit = defineEmits<{ (event: 'error'): void }>()

// 缓存读取在本组件中建立依赖，使另一首歌的封面返回不会触发本单元格或整张歌单更新。
const coverUrl = computed(() => props.getCoverUrl(props.filePath))
</script>

<template>
  <img
    v-if="coverUrl"
    :key="coverUrl"
    :src="coverUrl"
    alt="cover"
    decoding="async"
    @error="emit('error')"
  />
  <div v-else class="cover-skeleton"></div>
</template>

<style lang="scss" scoped>
img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  -webkit-user-drag: none;
  user-select: none;
}

.cover-skeleton {
  width: 100%;
  height: 100%;
}
</style>
