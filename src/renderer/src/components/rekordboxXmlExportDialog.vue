<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { t, tLabel } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import type { RekordboxXmlExportMode } from '@shared/rekordboxXmlExport'

type DialogPayload = {
  targetRootDir: string
  exportDirName: string
  xmlFileName: string
  xmlPlaylistName: string
  mode: RekordboxXmlExportMode
}

const STORAGE_KEY = 'rekordboxXmlExportDialog'
const uuid = uuidV4()

const props = defineProps<{
  dialogTitle: string
  defaultExportDirName: string
  defaultXmlFileName: string
  defaultXmlPlaylistName: string
  confirmCallback: (payload: DialogPayload) => void
  cancelCallback: () => void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const targetRootDir = ref('')
const exportDirName = ref(String(props.defaultExportDirName || '').trim())
const xmlFileName = ref(String(props.defaultXmlFileName || '').trim())
const xmlPlaylistName = ref(String(props.defaultXmlPlaylistName || '').trim())
const mode = ref<RekordboxXmlExportMode>('copy')
const flashArea = ref('')

const modeOptions: Array<{ key: RekordboxXmlExportMode; labelKey: string }> = [
  { key: 'copy', labelKey: 'rekordboxXmlExport.modeCopy' },
  { key: 'move', labelKey: 'rekordboxXmlExport.modeMove' }
]

const loadPersistedDefaults = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as {
      targetRootDir?: string
      mode?: RekordboxXmlExportMode
    }
    targetRootDir.value = String(parsed?.targetRootDir || '').trim()
    mode.value = parsed?.mode === 'move' ? 'move' : 'copy'
  } catch {
    targetRootDir.value = ''
    mode.value = 'copy'
  }
}

const persistStableDefaults = () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      targetRootDir: targetRootDir.value,
      mode: mode.value
    })
  )
}

loadPersistedDefaults()

const flashBorder = (field: string) => {
  flashArea.value = field
  let count = 0
  const interval = setInterval(() => {
    count += 1
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = ''
    }
  }, 500)
}

let choosingDir = false
const chooseDirectory = async () => {
  if (choosingDir) return
  choosingDir = true
  const folderPath = await window.electron.ipcRenderer.invoke('select-folder', false)
  choosingDir = false
  if (Array.isArray(folderPath) && folderPath[0]) {
    targetRootDir.value = String(folderPath[0] || '').trim()
  }
}

const moveHint = computed(() => t('rekordboxXmlExport.moveModeHint'))

const confirm = () => {
  const normalizedRoot = String(targetRootDir.value || '').trim()
  const normalizedExportDirName = String(exportDirName.value || '').trim()
  const normalizedXmlFileName = String(xmlFileName.value || '').trim()
  const normalizedPlaylistName = String(xmlPlaylistName.value || '').trim()

  if (!normalizedRoot) {
    if (!flashArea.value) flashBorder('targetRootDir')
    return
  }
  if (!normalizedExportDirName) {
    if (!flashArea.value) flashBorder('exportDirName')
    return
  }
  if (!normalizedXmlFileName) {
    if (!flashArea.value) flashBorder('xmlFileName')
    return
  }
  if (!normalizedPlaylistName) {
    if (!flashArea.value) flashBorder('xmlPlaylistName')
    return
  }

  persistStableDefaults()
  closeWithAnimation(() => {
    props.confirmCallback({
      targetRootDir: normalizedRoot,
      exportDirName: normalizedExportDirName,
      xmlFileName: normalizedXmlFileName,
      xmlPlaylistName: normalizedPlaylistName,
      mode: mode.value
    })
  })
}

const cancel = () => {
  persistStableDefaults()
  closeWithAnimation(() => {
    props.cancelCallback()
  })
}

onMounted(() => {
  hotkeys('E,Enter', uuid, () => {
    confirm()
    return false
  })
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      style="width: 560px; min-height: 420px; display: flex; flex-direction: column"
      class="inner"
    >
      <div class="dialog-title dialog-header">
        <span>{{ props.dialogTitle }}</span>
      </div>
      <div class="dialog-content">
        <div class="form-row">
          <div class="form-label">{{ tLabel('rekordboxXmlExport.exportRootDir') }}</div>
          <div class="form-control">
            <bubbleBoxTrigger
              tag="div"
              class="choose-dir flashing-border"
              :title="targetRootDir"
              :class="{ 'is-flashing': flashArea === 'targetRootDir' }"
              @click="chooseDirectory()"
            >
              {{ targetRootDir || t('rekordboxXmlExport.selectExportRootDir') }}
            </bubbleBoxTrigger>
          </div>
        </div>

        <div class="form-row">
          <div class="form-label">{{ tLabel('rekordboxXmlExport.exportMode') }}</div>
          <div class="form-control mode-options">
            <div
              v-for="option in modeOptions"
              :key="option.key"
              class="mode-option"
              :class="{ active: mode === option.key }"
              @click="mode = option.key"
            >
              {{ t(option.labelKey) }}
            </div>
          </div>
        </div>

        <div class="mode-hint" :class="{ danger: mode === 'move' }">
          {{ moveHint }}
        </div>

        <div class="form-row">
          <div class="form-label">{{ tLabel('rekordboxXmlExport.exportDirName') }}</div>
          <div class="form-control">
            <input
              v-model.trim="exportDirName"
              class="text-input flashing-border"
              :class="{ 'is-flashing': flashArea === 'exportDirName' }"
              type="text"
            />
          </div>
        </div>

        <div class="form-row">
          <div class="form-label">{{ tLabel('rekordboxXmlExport.xmlFileName') }}</div>
          <div class="form-control">
            <input
              v-model.trim="xmlFileName"
              class="text-input flashing-border"
              :class="{ 'is-flashing': flashArea === 'xmlFileName' }"
              type="text"
            />
          </div>
        </div>

        <div class="form-row">
          <div class="form-label">{{ tLabel('rekordboxXmlExport.xmlPlaylistName') }}</div>
          <div class="form-control">
            <input
              v-model.trim="xmlPlaylistName"
              class="text-input flashing-border"
              :class="{ 'is-flashing': flashArea === 'xmlPlaylistName' }"
              type="text"
            />
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="confirm()">{{ t('common.confirm') }} (E)</div>
        <div class="button" @click="cancel()">{{ t('common.cancel') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.dialog-content {
  padding: 18px 20px 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1 1 auto;
}

.form-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.form-label {
  width: 132px;
  font-size: 14px;
  text-align: right;
  flex: 0 0 auto;
}

.form-control {
  flex: 1 1 auto;
}

.choose-dir,
.text-input {
  width: 100%;
  min-height: 36px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 3px;
  box-sizing: border-box;
  font-size: 14px;
}

.choose-dir {
  padding: 7px 10px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.text-input {
  padding: 7px 10px;
  outline: none;

  &:focus {
    border-color: var(--accent);
  }
}

.mode-options {
  display: flex;
  gap: 10px;
}

.mode-option {
  min-width: 110px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
  user-select: none;
  font-size: 14px;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }

  &.active {
    border-color: var(--accent);
    background-color: color-mix(in srgb, var(--accent) 14%, var(--bg-elev));
  }
}

.mode-hint {
  margin-left: 144px;
  font-size: 13px;
  color: var(--text-weak);
  line-height: 1.5;

  &.danger {
    color: #c05c34;
  }
}

.is-flashing {
  border-color: #be1100 !important;
}
</style>
