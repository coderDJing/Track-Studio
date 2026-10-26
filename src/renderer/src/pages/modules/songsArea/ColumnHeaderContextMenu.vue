<script setup lang="ts">
import { ref, watchEffect, PropType } from 'vue'
import { ISongsAreaColumn } from '../../../../../types/globals'
import SongAreaColRightClickMenu from '@renderer/components/songAreaColRightClickMenu.vue'

const props = defineProps({
  modelValue: Boolean, // for v-model
  independentSettings: Boolean,
  targetEvent: {
    type: Object as PropType<MouseEvent | null>,
    default: null
  },
  columns: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  }
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'toggle-column-visibility', columnKey: string): void
  (e: 'reset-to-shared-settings'): void
}>()

const internalShow = ref(props.modelValue)

watchEffect(() => {
  internalShow.value = props.modelValue
})

const handleMenuItemClick = (column: ISongsAreaColumn) => {
  emit('toggle-column-visibility', column.key)
}

const onMenuVModelUpdate = (value: boolean) => {
  emit('update:modelValue', value)
}
</script>

<template>
  <SongAreaColRightClickMenu
    :model-value="internalShow"
    :click-event="targetEvent"
    :column-data="columns"
    :show-reset-to-shared-settings="independentSettings"
    @update:model-value="onMenuVModelUpdate"
    @col-menu-handle-click="handleMenuItemClick"
    @reset-to-shared-settings="emit('reset-to-shared-settings')"
  />
</template>

<style scoped>
/* This component is primarily a logic wrapper, so specific styles might not be needed here */
/* Styles for SongAreaColRightClickMenu are within that component itself */
</style>
