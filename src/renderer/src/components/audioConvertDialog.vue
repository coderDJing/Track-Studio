<script setup lang="ts">
import { RendererFilePathSet, sameRendererFilePath } from '@renderer/utils/filePathComparison'

import { ref, onMounted, onUnmounted, computed, useTemplateRef, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { v4 as uuidV4 } from 'uuid'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import hintIconAsset from '@renderer/assets/hint.svg?asset'
import { SUPPORTED_AUDIO_FORMATS, type SupportedAudioFormat } from '../../../shared/audioFormats'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type { ConvertOptions, StandaloneConvertPayload } from './audioConvertDialog.types'
const hintIcon = hintIconAsset

const props = defineProps<{
  confirmCallback?: (payload: ConvertOptions | StandaloneConvertPayload) => void
  cancelCallback?: () => void
  sourceExts?: string[]
  standaloneMode?: boolean
  presetTargetFormat?: SupportedAudioFormat
  lockTargetFormat?: boolean
}>()
const uuid = uuidV4()

const isSupportedAudioFormat = (fmt: string): fmt is SupportedAudioFormat =>
  (SUPPORTED_AUDIO_FORMATS as readonly string[]).includes(fmt)

type ConvertDefaults = ConvertOptions
const isStandaloneMode = computed(() => Boolean(props.standaloneMode))
const selectedFiles = ref<string[]>([])
const outputDir = ref('')
const supportedFormats = ref<SupportedAudioFormat[]>([])
const availableTargetFormats = ref<SupportedAudioFormat[]>(
  SUPPORTED_AUDIO_FORMATS.filter(isSupportedAudioFormat)
)
const formatOptions = computed(() =>
  supportedFormats.value.map((fmt) => ({
    label: fmt.toUpperCase(),
    value: fmt
  }))
)
const targetFormatLocked = computed(() =>
  Boolean(props.lockTargetFormat && props.presetTargetFormat)
)
const form = ref<ConvertDefaults>({
  targetFormat: 'mp3',
  bitrateKbps: 320,
  sampleRate: 44100,
  channels: 2,
  preserveMetadata: true,
  normalize: false,
  strategy: 'new_file',
  overwrite: false,
  backupOnReplace: true,
  addFingerprint: false
})

// 依据容器/编码支持情况，尽量保留元数据；无法保留时 FFmpeg 会忽略
const metadataHint = computed(() => t('convert.metadataHint'))
const metadataHintRef = useTemplateRef<HTMLImageElement>('metadataHintRef')
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const selectedFilesLabel = computed(() => {
  const count = selectedFiles.value.length
  if (count === 0) return t('convert.selectSourceFiles')
  return t('convert.selectedFiles', { count })
})
const selectedFilesTooltip = computed(() => {
  if (selectedFiles.value.length === 0) return t('convert.selectSourceFiles')
  return selectedFiles.value.join('\n')
})
const outputDirLabel = computed(() => outputDir.value || t('convert.selectOutputDir'))
const outputDirTooltip = computed(() => outputDir.value || t('convert.selectOutputDir'))
const shouldShowOutputDir = computed(
  () => !isStandaloneMode.value || form.value.strategy === 'new_file'
)
const preserveMetadataModel = computed<boolean>({
  get: () => form.value.preserveMetadata !== false,
  set: (value) => {
    form.value.preserveMetadata = value
  }
})
const addFingerprintModel = computed<boolean>({
  get: () => form.value.addFingerprint === true,
  set: (value) => {
    form.value.addFingerprint = value
  }
})
const selectedFileItems = computed(() =>
  selectedFiles.value.map((filePath) => {
    const parts = filePath.split(/[/\\]/)
    const fileName = parts[parts.length - 1] || filePath
    const lastSeparatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
    return {
      filePath,
      fileName,
      parentPath: lastSeparatorIndex > 0 ? filePath.slice(0, lastSeparatorIndex) : ''
    }
  })
)
const scrollbarOptions = {
  scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
  overflow: { x: 'hidden', y: 'scroll' } as const
}

// 必填闪烁提示（参考项目其他弹窗）
const flashArea = ref('')
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = ''
    }
  }, 500)
}

const filterSupportedFormats = (available: SupportedAudioFormat[], sourceExts: string[]) => {
  // 过滤与源相同的格式（简单化：移除所有所选文件扩展名对应的目标格式）
  const srcSet = new Set(
    sourceExts
      .map((e) => String(e || '').toLowerCase())
      .map((e) => e.replace(/^\./, ''))
      .filter(Boolean) as Array<string>
  )
  let filtered = available
  if (srcSet.size === 1) {
    const only = Array.from(srcSet)[0]
    filtered = available.filter((fmt) => {
      // .aif 与 .aiff 视为同类
      if (only === 'aif' || only === 'aiff') {
        return !(fmt === 'aif' || fmt === 'aiff')
      }
      return fmt !== only
    })
    if (filtered.length === 0) filtered = available
  }
  return filtered
}

const resolvedSourceExts = computed(() => {
  if (!isStandaloneMode.value) return props.sourceExts || []
  return Array.from(
    new Set(
      selectedFiles.value
        .map((filePath) => filePath.match(/\.[^\\\/\.]+$/)?.[0] || '')
        .filter(Boolean)
    )
  )
})

const applySupportedFormats = () => {
  supportedFormats.value = filterSupportedFormats(
    availableTargetFormats.value,
    resolvedSourceExts.value
  )
  if (supportedFormats.value.length === 0) {
    return
  }
  if (
    props.presetTargetFormat &&
    supportedFormats.value.includes(props.presetTargetFormat) &&
    (targetFormatLocked.value || !supportedFormats.value.includes(form.value.targetFormat))
  ) {
    form.value.targetFormat = props.presetTargetFormat
    return
  }
  if (!supportedFormats.value.includes(form.value.targetFormat)) {
    form.value.targetFormat = supportedFormats.value[0]
  }
}

watch(resolvedSourceExts, () => {
  applySupportedFormats()
})

const normalizeUniquePaths = (values: string[]) =>
  Array.from(
    new RendererFilePathSet(values.map((item) => String(item || '').trim()).filter(Boolean))
  )

let clickChooseFileFlag = false
const clickChooseFiles = async () => {
  if (clickChooseFileFlag) return
  clickChooseFileFlag = true
  try {
    const filePaths = (await window.electron.ipcRenderer.invoke('select-audio-files')) as
      string[] | null
    if (Array.isArray(filePaths) && filePaths.length > 0) {
      selectedFiles.value = normalizeUniquePaths([...selectedFiles.value, ...filePaths])
    }
  } finally {
    clickChooseFileFlag = false
  }
}

let clickChooseOutputDirFlag = false
const clickChooseOutputDir = async () => {
  if (clickChooseOutputDirFlag) return
  clickChooseOutputDirFlag = true
  try {
    const folderPath = (await window.electron.ipcRenderer.invoke('select-folder', false)) as
      string[] | null
    if (Array.isArray(folderPath) && folderPath[0]) {
      outputDir.value = folderPath[0]
    }
  } finally {
    clickChooseOutputDirFlag = false
  }
}

const removeSelectedFile = (filePath: string) => {
  selectedFiles.value = selectedFiles.value.filter((item) => !sameRendererFilePath(item, filePath))
}

const clearSelectedFiles = () => {
  selectedFiles.value = []
}

onMounted(async () => {
  hotkeys('E,Enter', uuid, () => {
    confirm()
    return false
  })
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)

  // 先给一个可用列表，避免弹窗首次打开卡顿
  availableTargetFormats.value = SUPPORTED_AUDIO_FORMATS.filter(isSupportedAudioFormat)
  applySupportedFormats()

  const setting = await window.electron.ipcRenderer.invoke('getSetting')
  try {
    // 询问主进程：FFmpeg 可编码的目标格式
    const targetFormats: string[] = await window.electron.ipcRenderer.invoke(
      'audio:convert:list-target-formats'
    )
    availableTargetFormats.value = targetFormats.filter(isSupportedAudioFormat)
    applySupportedFormats()
  } catch (err) {
    console.error('[AudioConvertDialog] list-target-formats failed:', err)
  }
  if (setting?.convertDefaults) {
    const persisted = setting.convertDefaults
    const next: Partial<ConvertDefaults> = { ...persisted }
    if (next.targetFormat && !isSupportedAudioFormat(next.targetFormat)) {
      delete next.targetFormat
    }
    form.value = { ...form.value, ...next }
  }
  applySupportedFormats()
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})

const confirm = async () => {
  if (isStandaloneMode.value && selectedFiles.value.length === 0) {
    if (!flashArea.value) flashBorder('selectedFiles')
    return
  }
  if (isStandaloneMode.value && shouldShowOutputDir.value && outputDir.value.trim().length === 0) {
    if (!flashArea.value) flashBorder('outputDir')
    return
  }
  // 校验：目标格式必选且在可选列表中
  if (!supportedFormats.value.includes(form.value.targetFormat)) {
    if (!flashArea.value) flashBorder('targetFormat')
    return
  }
  const payloadOptions: ConvertOptions = isStandaloneMode.value
    ? {
        ...form.value,
        outputDir: shouldShowOutputDir.value ? outputDir.value.trim() : undefined
      }
    : { ...form.value }
  try {
    const setting = await window.electron.ipcRenderer.invoke('getSetting')
    const nextConvertDefaults: ConvertDefaults = { ...form.value }
    const persistedTargetFormat = setting?.convertDefaults?.targetFormat
    if (
      targetFormatLocked.value &&
      typeof persistedTargetFormat === 'string' &&
      isSupportedAudioFormat(persistedTargetFormat)
    ) {
      nextConvertDefaults.targetFormat = persistedTargetFormat
    }
    const next = { ...setting, convertDefaults: nextConvertDefaults }
    await window.electron.ipcRenderer.invoke('setSetting', next)
  } catch {}
  closeWithAnimation(() => {
    if (isStandaloneMode.value) {
      props.confirmCallback?.({
        files: [...selectedFiles.value],
        outputDir: outputDir.value.trim(),
        options: payloadOptions
      })
      return
    }
    props.confirmCallback?.(payloadOptions)
  })
}
const cancel = () => {
  closeWithAnimation(() => {
    props.cancelCallback?.()
  })
}
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      style="
        width: 560px;
        height: min(90vh, 800px);
        min-height: 520px;
        display: flex;
        flex-direction: column;
      "
      class="inner"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t(isStandaloneMode ? 'menu.formatConversionTool' : 'convert.title') }}</span>
      </div>
      <OverlayScrollbarsComponent
        class="dialog-content-scroll"
        :options="scrollbarOptions"
        element="div"
      >
        <div class="dialog-content">
          <template v-if="isStandaloneMode">
            <div>{{ t('convert.sourceFiles') }}：</div>
            <div class="standalone-actions">
              <bubbleBoxTrigger
                tag="div"
                class="picker-box flashing-border"
                :class="{ 'is-flashing': flashArea == 'selectedFiles' }"
                :title="selectedFilesTooltip"
                @click="clickChooseFiles()"
              >
                {{ selectedFilesLabel }}
              </bubbleBoxTrigger>
              <div class="button action-button" @click="clickChooseFiles()">
                {{ t('convert.chooseFiles') }}
              </div>
              <div
                class="button action-button"
                :class="{ 'action-button-disabled': selectedFiles.length === 0 }"
                @click="selectedFiles.length > 0 && clearSelectedFiles()"
              >
                {{ t('fileSelector.clearAll') }}
              </div>
            </div>

            <div class="selected-files-panel">
              <div class="selected-files-header">{{ t('convert.selectedFilesTitle') }}</div>
              <div class="selected-files-body">
                <div v-if="selectedFileItems.length === 0" class="selected-files-empty">
                  {{ t('convert.noSelectedFiles') }}
                </div>
                <OverlayScrollbarsComponent
                  v-else
                  class="selected-files-scroll"
                  :options="scrollbarOptions"
                  element="div"
                >
                  <div class="selected-files-list">
                    <div
                      v-for="item in selectedFileItems"
                      :key="item.filePath"
                      class="selected-file-item"
                    >
                      <div class="selected-file-meta">
                        <bubbleBoxTrigger
                          tag="div"
                          class="selected-file-name"
                          :title="item.fileName"
                        >
                          {{ item.fileName }}
                        </bubbleBoxTrigger>
                        <bubbleBoxTrigger
                          tag="div"
                          class="selected-file-path"
                          :title="item.filePath"
                        >
                          {{ item.parentPath || item.filePath }}
                        </bubbleBoxTrigger>
                      </div>
                      <div
                        class="button action-button delete-button"
                        @click="removeSelectedFile(item.filePath)"
                      >
                        {{ t('common.delete') }}
                      </div>
                    </div>
                  </div>
                </OverlayScrollbarsComponent>
              </div>
            </div>

            <template v-if="shouldShowOutputDir">
              <div style="margin-top: 20px">{{ t('convert.outputDir') }}：</div>
              <div style="margin-top: 10px">
                <bubbleBoxTrigger
                  tag="div"
                  class="picker-box flashing-border"
                  :class="{ 'is-flashing': flashArea == 'outputDir' }"
                  :title="outputDirTooltip"
                  @click="clickChooseOutputDir()"
                >
                  {{ outputDirLabel }}
                </bubbleBoxTrigger>
              </div>
            </template>
          </template>

          <div :style="{ marginTop: isStandaloneMode ? '20px' : '0' }">
            {{ t('convert.targetFormat') }}：
          </div>
          <div style="margin-top: 10px">
            <BaseSelect
              v-model="form.targetFormat"
              :options="formatOptions"
              :width="220"
              :disabled="targetFormatLocked"
              class="flashing-border"
              :class="{ 'is-flashing': flashArea == 'targetFormat' }"
            />
          </div>

          <div style="margin-top: 20px">{{ t('convert.strategy') }}：</div>
          <div style="margin-top: 10px">
            <singleRadioGroup
              v-model="form.strategy"
              name="convertStrategy"
              :options="[
                { label: t('convert.newFile'), value: 'new_file' },
                { label: t('convert.replaceOriginal'), value: 'replace' }
              ]"
              :option-font-size="12"
            />
          </div>

          <div style="margin-top: 20px">
            <label for="convert-checkbox-preserveMetadata" style="user-select: none"
              >{{ t('convert.preserveMetadata') }}：</label
            >
            <img
              ref="metadataHintRef"
              :src="hintIcon"
              style="width: 15px; height: 15px; margin-left: 6px"
              :draggable="false"
              class="theme-icon"
            />
            <bubbleBox :dom="metadataHintRef || undefined" :title="metadataHint" :max-width="240" />
          </div>
          <div style="margin-top: 10px">
            <singleCheckbox
              id="convert-checkbox-preserveMetadata"
              v-model="preserveMetadataModel"
            />
          </div>

          <div style="margin-top: 20px">
            <label for="convert-checkbox-addFingerprint" style="user-select: none"
              >{{ t('convert.addFingerprint') }}：</label
            >
          </div>
          <div style="margin-top: 10px">
            <singleCheckbox id="convert-checkbox-addFingerprint" v-model="addFingerprintModel" />
          </div>
        </div>
      </OverlayScrollbarsComponent>
      <div class="dialog-footer">
        <div class="button" style="width: 90px; text-align: center" @click="confirm()">
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.formLabel {
  text-align: left;
  font-size: 14px;
  width: 140px;
}

.dialog-content-scroll {
  flex: 1;
  min-height: 0;
}

.dialog-content {
  padding: 20px;
  font-size: 14px;
  min-height: 100%;
  box-sizing: border-box;
}

.picker-box {
  min-height: 36px;
  width: 100%;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background-color: var(--bg-elev);
  color: var(--text);
  box-sizing: border-box;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.standalone-actions {
  margin-top: 10px;
  display: flex;
  gap: 10px;
  align-items: center;
}

.standalone-actions .picker-box {
  flex: 1;
}

.action-button {
  min-width: 68px;
  text-align: center;
  flex-shrink: 0;
}

.action-button-disabled {
  pointer-events: none;
  color: var(--text-weak);
  background-color: var(--bg);
}

.selected-files-panel {
  margin-top: 12px;
  height: 192px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg);
  display: flex;
  flex-direction: column;
}

.selected-files-header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-weight: 600;
  flex-shrink: 0;
}

.selected-files-body {
  flex: 1;
  min-height: 0;
}

.selected-files-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 12px;
  box-sizing: border-box;
  color: var(--text-weak);
}

.selected-files-scroll {
  height: 100%;
}

.selected-files-list {
  display: flex;
  flex-direction: column;
}

.selected-file-item {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.selected-file-item:last-child {
  border-bottom: none;
}

.selected-file-meta {
  min-width: 0;
  flex: 1;
}

.selected-file-name,
.selected-file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selected-file-name {
  color: var(--text);
}

.selected-file-path {
  margin-top: 4px;
  color: var(--text-weak);
  font-size: 12px;
}

.delete-button {
  min-width: 56px;
  background-color: #dc3545;
  color: #ffffff;
}

.delete-button:hover {
  background-color: #c82333;
  color: #ffffff;
}
</style>
