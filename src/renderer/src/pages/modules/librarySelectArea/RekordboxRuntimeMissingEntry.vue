<script setup lang="ts">
import { computed } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  iconAsset: string
  downloading: boolean
  hint: string
}>()

const emit = defineEmits<{ download: [] }>()

const iconStyle = computed(() => ({
  maskImage: `url("${props.iconAsset}")`,
  WebkitMaskImage: `url("${props.iconAsset}")`
}))

const accessibleLabel = computed(() =>
  props.downloading ? t('optionalComponents.downloadingEntryLabel') : props.hint
)

const triggerDownload = () => {
  if (props.downloading) return
  emit('download')
}
</script>

<template>
  <bubbleBoxTrigger
    tag="div"
    class="rkb-runtime-entry"
    :class="{ 'rkb-runtime-entry--busy': downloading }"
    role="button"
    tabindex="0"
    :aria-label="accessibleLabel"
    :aria-busy="downloading"
    :title="accessibleLabel"
    @click="triggerDownload"
    @keydown.enter.prevent="triggerDownload"
    @keydown.space.prevent="triggerDownload"
    @contextmenu.prevent="triggerDownload"
  >
    <span class="rkb-runtime-entry__icon" :style="iconStyle" aria-hidden="true"></span>
    <span v-if="downloading" class="rkb-runtime-entry__busy" aria-hidden="true"></span>
    <span v-else class="rkb-runtime-entry__badge" aria-hidden="true">↓</span>
  </bubbleBoxTrigger>
</template>

<style lang="scss" scoped>
/* 固定在侧栏 45px 列内的 36px 点击区，视觉与现有 sidebar icon 一致。 */
.rkb-runtime-entry {
  position: relative;
  width: 36px;
  height: 36px;
  max-width: 100%;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--text);
  cursor: pointer;
  box-sizing: border-box;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.rkb-runtime-entry:hover {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.rkb-runtime-entry--busy {
  cursor: progress;
  color: var(--text-weak);
}

.rkb-runtime-entry__icon {
  width: 25px;
  height: 25px;
  background-color: currentColor;
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
  opacity: var(--sidebar-icon-opacity, 0.72);
}

.rkb-runtime-entry:hover .rkb-runtime-entry__icon {
  opacity: 0.9;
}

.rkb-runtime-entry__badge {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--bg);
  font-size: 9px;
  line-height: 12px;
  text-align: center;
  pointer-events: none;
}

.rkb-runtime-entry__busy {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 34%, transparent);
  border-top-color: var(--accent);
  animation: rkb-runtime-entry-spin 0.9s linear infinite;
  pointer-events: none;
}

@keyframes rkb-runtime-entry-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
