<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
const scroller = ref<InstanceType<typeof OverlayScrollbarsComponent>>()
const emit = defineEmits<{ (event: 'viewport', element: HTMLElement): void }>()
const emitViewport = () => {
  const viewport = scroller.value?.osInstance()?.elements().viewport
  if (viewport) emit('viewport', viewport)
}
onMounted(emitViewport)
defineExpose({ osInstance: () => scroller.value?.osInstance() })
</script>
<template>
  <OverlayScrollbarsComponent
    ref="scroller"
    :options="{
      scrollbars: { autoHide: 'leave', autoHideDelay: 50, clickScroll: true },
      overflow: { x: 'scroll', y: 'scroll' }
    }"
    element="div"
    style="height: 100%; width: 100%; position: relative"
    @os-initialized="emitViewport"
  >
    <slot />
  </OverlayScrollbarsComponent>
</template>
