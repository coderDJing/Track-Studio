<script setup lang="ts">
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useSearchFocusHintTargets } from '@renderer/composables/useSearchFocus'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'

// Only registered Ctrl/Cmd+F inputs receive a hint; no list or waveform hover surface.
const targets = useSearchFocusHintTargets()
const runtime = useRuntimeStore()
</script>

<template>
  <bubbleBox
    v-for="target in targets"
    :key="target.id"
    :dom="target.input.disabled ? target.input.parentElement || target.input : target.input"
    :title="t('search.focusSearch')"
    :shortcut="runtime.platform === 'Mac' ? 'Cmd+F' : 'Ctrl+F'"
  />
</template>
