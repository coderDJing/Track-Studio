<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { t } from '@renderer/utils/translate'
import utils from '../utils/utils'

const uuid = uuidV4()
const props = defineProps<{
  initialPath?: string
  storageKind?: 'rekordbox' | 'serato'
  confirmCallback: (path: string) => void
  cancelCallback: () => void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const selectedPath = ref(String(props.initialPath || '').trim())
const flashPath = ref(false)

const pathText = computed(
  () => selectedPath.value || t('rekordboxDesktop.storageDirSetupPathPlaceholder')
)
const textKey = (
  suffix: 'title' | 'intro' | 'why' | 'settingHint' | 'pathLabel' | 'confirmButton'
) =>
  props.storageKind === 'serato'
    ? t(`library.seratoStorageDirSetup${suffix[0].toUpperCase()}${suffix.slice(1)}`)
    : t(`rekordboxDesktop.storageDirSetup${suffix[0].toUpperCase()}${suffix.slice(1)}`)

const triggerFlash = () => {
  flashPath.value = true
  window.setTimeout(() => {
    flashPath.value = false
  }, 600)
}

const pickStorageDir = async () => {
  const result = (await window.electron.ipcRenderer.invoke('select-folder', false)) as
    | string[]
    | null
  const nextPath = Array.isArray(result) ? String(result[0] || '').trim() : ''
  if (nextPath) {
    selectedPath.value = nextPath
  }
}

const confirm = () => {
  if (!selectedPath.value) {
    triggerFlash()
    return
  }
  closeWithAnimation(() => {
    props.confirmCallback(selectedPath.value)
  })
}

const cancel = () => {
  closeWithAnimation(() => {
    props.cancelCallback()
  })
}

onMounted(() => {
  hotkeys('E,Enter', uuid, () => confirm())
  hotkeys('Esc', uuid, () => cancel())
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">
        {{ textKey('title') }}
      </div>
      <div class="content">
        <div class="description">
          <p>{{ textKey('intro') }}</p>
          <p>{{ textKey('why') }}</p>
          <p>{{ textKey('settingHint') }}</p>
        </div>
        <div class="path-section">
          <div class="path-label">{{ textKey('pathLabel') }}</div>
          <bubbleBoxTrigger
            tag="div"
            class="chooseDirDiv flashing-border"
            :class="{ 'chooseDirDiv--empty': !selectedPath, 'is-flashing': flashPath }"
            :title="pathText"
            @click="void pickStorageDir()"
          >
            {{ pathText }}
          </bubbleBoxTrigger>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button dialog-button" @click="confirm">{{ textKey('confirmButton') }} (E)</div>
        <div class="button dialog-button" @click="cancel">{{ t('common.cancel') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 500px;
  max-width: calc(100vw - 24px);
  min-height: 310px;
  display: flex;
  flex-direction: column;
}

.content {
  padding: 20px;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
  font-size: 14px;
  overflow-y: auto;
}

.description {
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--text);
  line-height: 1.6;
}

.description p {
  margin: 0;
}

.path-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.path-label {
  color: var(--text);
  font-size: 14px;
  line-height: 20px;
}

.chooseDirDiv {
  width: 100%;
  height: 25px;
  background-color: var(--bg-elev);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  font-size: 14px;
  padding-left: 5px;
  line-height: 25px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text);
  box-sizing: border-box;
  cursor: pointer;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.chooseDirDiv--empty {
  color: color-mix(in srgb, var(--text) 54%, transparent);
}

.is-flashing {
  border-color: var(--accent);
}

.dialog-footer {
  justify-content: center;
  gap: 12px;
  padding: 16px 20px 20px;
}

.dialog-button {
  width: 110px;
  text-align: center;
}
</style>
