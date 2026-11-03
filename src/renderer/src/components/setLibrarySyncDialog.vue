<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import SetLibrarySyncSettings from './settingDialog/SetLibrarySyncSettings.vue'

const emits = defineEmits(['cancel'])
const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const close = () => closeWithAnimation(() => emits('cancel'))
onMounted(() => {
  utils.setHotkeysScpoe(uuid)
  hotkeys('esc', uuid, close)
})
onUnmounted(() => utils.delHotkeysScope(uuid))
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="title dialog-title dialog-header">{{ t('cloudSync.syncSetLibrary') }}</div>
      <div class="body"><SetLibrarySyncSettings /></div>
      <div class="dialog-footer">
        <button class="button" @click="close">{{ t('common.close') }} (Esc)</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inner {
  width: 600px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  padding: 0;
  display: flex;
  flex-direction: column;
}
.title {
  color: var(--text);
}
.body {
  padding: 20px;
  overflow-y: auto;
  min-height: 0;
}
button {
  font: inherit;
}
</style>
