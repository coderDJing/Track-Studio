<script setup lang="ts">
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import { t } from '@renderer/utils/translate'
const value = defineModel<boolean>({ required: true })
defineProps<{ hint: string }>()
</script>
<template>
  <bubbleBoxTrigger class="songs-pane-header__key-filter" :title="hint" @click.stop @keydown.stop
    ><singleCheckbox v-model="value"
      ><span class="songs-pane-header__label-full">{{ t('tracks.independentListSettings') }}</span
      ><span class="songs-pane-header__label-compact">{{
        t('tracks.independentListSettingsCompact')
      }}</span></singleCheckbox
    ></bubbleBoxTrigger
  >
</template>
<style scoped lang="scss" src="./SongListPaneChrome.scss"></style>
