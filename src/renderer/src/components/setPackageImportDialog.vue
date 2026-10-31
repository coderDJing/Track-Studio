<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { onMounted, onUnmounted, ref } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import bubbleBoxTrigger from './bubbleBoxTrigger.vue'
import singleCheckbox from './singleCheckbox.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { getSetPackageFailureLines } from '@renderer/utils/setPackageMessages'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import type { SetPackageImportDialogResult, SetPackagePickResult } from '@shared/setPackage'

const props = defineProps<{
  confirmCallback?: (value: SetPackageImportDialogResult) => void
  cancelCallback?: () => void
}>()
const runtime = useRuntimeStore()
const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const picked = ref<SetPackageImportDialogResult['picked'] | null>(null)
const deleteSourceAfterImport = ref(false)
const isPicking = ref(false)
const errorLines = ref<string[]>([])

const pickFile = async () => {
  if (isPicking.value) return
  isPicking.value = true
  errorLines.value = []
  try {
    const result = (await window.electron.ipcRenderer.invoke(
      'setList:pick-package'
    )) as SetPackagePickResult
    if (!result.ok) {
      picked.value = null
      errorLines.value = getSetPackageFailureLines(result)
    } else if (!result.canceled) {
      picked.value = result
    }
  } catch (error) {
    picked.value = null
    errorLines.value = [t('library.setPackageReadFailed')]
    console.error('[setPackage] select manifest failed', error)
  } finally {
    isPicking.value = false
  }
}
const confirm = () => {
  if (!picked.value || isPicking.value) return
  const result = { picked: picked.value, deleteSourceAfterImport: deleteSourceAfterImport.value }
  closeWithAnimation(() => props.confirmCallback?.(result))
}
const cancel = () => {
  if (!isPicking.value) closeWithAnimation(() => props.cancelCallback?.())
}
onMounted(() => {
  runtime.confirmShow = true
  hotkeys('E,Enter', uuid, confirm)
  hotkeys('Esc', uuid, cancel)
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  runtime.confirmShow = false
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner set-package-import-dialog">
      <div class="dialog-title dialog-header">{{ t('library.importSetPackage') }}</div>
      <div class="set-package-import-dialog__content">
        <p class="set-package-import-dialog__intro">{{ t('library.setPackageImportHint') }}</p>
        <div class="set-package-import-dialog__file-row">
          <bubbleBoxTrigger
            class="set-package-import-dialog__path"
            :title="picked?.manifestPath || ''"
          >
            {{ picked?.manifestPath || t('library.setPackageChoosePlaceholder') }}
          </bubbleBoxTrigger>
          <button class="button" :disabled="isPicking" @click="pickFile">
            {{ t('library.setPackageChooseFile') }}
          </button>
        </div>
        <p v-if="picked" class="set-package-import-dialog__summary">
          {{
            t('library.setPackageSelectedSummary', {
              name: picked.setName,
              count: picked.trackCount
            })
          }}
        </p>
        <div v-if="errorLines.length" class="set-package-import-dialog__error" role="alert">
          <div v-for="(line, index) in errorLines" :key="index">{{ line }}</div>
        </div>
        <div class="set-package-import-dialog__cleanup">
          <singleCheckbox v-model="deleteSourceAfterImport">
            {{ t('library.setPackageDeleteSource') }}
          </singleCheckbox>
        </div>
      </div>
      <div class="dialog-footer">
        <button class="button" :disabled="!picked || isPicking" @click="confirm">
          {{ t('library.setPackageStartImport') }} (E)
        </button>
        <button class="button" :disabled="isPicking" @click="cancel">
          {{ t('common.cancel') }} (Esc)
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.set-package-import-dialog {
  width: min(540px, calc(100vw - 40px));
  height: auto;
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
}
.set-package-import-dialog__content {
  padding: 22px 26px;
  overflow-y: auto;
  color: var(--text);
  line-height: 1.6;
}
p {
  margin: 0;
}
.set-package-import-dialog__intro {
  margin-bottom: 18px;
}
.set-package-import-dialog__file-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.set-package-import-dialog__path {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.set-package-import-dialog__summary {
  margin-top: 10px;
  overflow-wrap: anywhere;
}
.set-package-import-dialog__error {
  margin-top: 12px;
  color: var(--danger-text);
  overflow-wrap: anywhere;
}
.set-package-import-dialog__cleanup {
  margin-top: 22px;
}
.button {
  flex-shrink: 0;
  min-width: 100px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  font: inherit;
  color: var(--text);
}
.button:hover:not(:disabled) {
  color: #fff;
}
.button:disabled:hover {
  background: var(--hover);
}
.button:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
