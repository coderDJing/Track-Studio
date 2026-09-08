<script setup lang="ts">
import { ref, computed, onUnmounted, onMounted, useTemplateRef, reactive } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import singleCheckbox from './singleCheckbox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import selectSongListDialog from './selectSongListDialog.vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import hintIconAsset from '@renderer/assets/hint.svg?asset'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import customFileSelector from './customFileSelector/customFileSelector.vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
const hintIcon = hintIconAsset

type Mode = 'scan' | 'drop'

const uuid = uuidV4()
const props = defineProps({
  mode: { type: String as () => Mode, required: true },
  libraryName: { type: String, default: 'FilterLibrary' },
  songListUuid: { type: String },
  openSongListAfterImport: { type: Boolean, default: false },
  confirmCallback: { type: Function, required: true },
  cancelCallback: { type: Function, required: true }
})

type SettingData = {
  isDeleteSourceFile: boolean
  isComparisonSongFingerprint: boolean
  isPushSongFingerprintLibrary: boolean
  deduplicateMode: 'library' | 'batch' | 'none'
}
const settingData = ref<SettingData>({
  isDeleteSourceFile: true,
  isComparisonSongFingerprint: true,
  isPushSongFingerprintLibrary: true,
  deduplicateMode: 'library'
})
let localStorageData = localStorage.getItem('scanNewSongDialog')
if (localStorageData == null) {
  localStorage.setItem(
    'scanNewSongDialog',
    JSON.stringify({
      isDeleteSourceFile: true,
      isComparisonSongFingerprint: true,
      isPushSongFingerprintLibrary: true,
      deduplicateMode: 'library'
    })
  )
  localStorageData = JSON.stringify({
    isDeleteSourceFile: true,
    isComparisonSongFingerprint: true,
    isPushSongFingerprintLibrary: true,
    deduplicateMode: 'library'
  })
}
const parsedLocalStorageData = JSON.parse(localStorageData) as Partial<SettingData>
settingData.value = {
  isDeleteSourceFile: parsedLocalStorageData.isDeleteSourceFile ?? true,
  isComparisonSongFingerprint: parsedLocalStorageData.isComparisonSongFingerprint ?? true,
  isPushSongFingerprintLibrary: parsedLocalStorageData.isPushSongFingerprintLibrary ?? true,
  deduplicateMode:
    parsedLocalStorageData.deduplicateMode ??
    ((parsedLocalStorageData.isComparisonSongFingerprint ?? true) ? 'library' : 'none')
}

const runtime = useRuntimeStore()
runtime.activeMenuUUID = ''

const selectedPaths = ref<string[]>([]) // 选中的文件和文件夹路径

// 取消记忆选中路径功能：不再从会话或本地存储中恢复
const customFileSelectorVisible = ref(false)
let clickChooseDirFlag = false
const clickChooseDir = async () => {
  if (clickChooseDirFlag || props.mode !== 'scan') return
  clickChooseDirFlag = true
  customFileSelectorVisible.value = true
  clickChooseDirFlag = false
}

const onFileSelectorConfirm = (paths: string[]) => {
  if (paths.length === 0) {
    // 允许 0 项确认：清空已选
    selectedPaths.value = []
  } else {
    // 合并新选择的路径（去重）
    const existingPaths = new Set(selectedPaths.value)
    const newPaths = paths.filter((path) => !existingPaths.has(path))
    selectedPaths.value = [...selectedPaths.value, ...newPaths]
  }
  customFileSelectorVisible.value = false
}

const onFileSelectorCancel = () => {
  customFileSelectorVisible.value = false
}

const selectedPathsDisplay = computed(() => {
  if (selectedPaths.value.length === 0) return ''
  let newPaths = selectedPaths.value.map((path) => {
    let parts = path.split(/[/\\]/)
    return parts[parts.length - 1] || parts[parts.length - 2] || path
  })
  let str = [] as string[]
  for (let item of newPaths) {
    str.push('"' + item + '"')
  }
  return str.join(',')
})

const songListSelected = ref('')
const selectSongListDialogShow = ref(false)
const clickChooseSongList = () => {
  selectSongListDialogShow.value = true
}
let songListSelectedPath = ''
let importingSongListUUID = ''
if (props.songListUuid) {
  importingSongListUUID = props.songListUuid
  let dirPath = libraryUtils.findDirPathByUuid(props.songListUuid)
  if (dirPath === null) {
    throw new Error(`dirPath error: ${JSON.stringify(dirPath)}`)
  }
  songListSelectedPath = dirPath
  let songListSelectedPathArr = songListSelectedPath.split('/')
  songListSelectedPathArr.shift()
  songListSelected.value = songListSelectedPathArr.join('\\')
}

const selectSongListDialogConfirm = (uuid: string) => {
  importingSongListUUID = uuid
  let dirPath = libraryUtils.findDirPathByUuid(uuid)
  if (dirPath === null) {
    throw new Error(`dirPath error: ${JSON.stringify(dirPath)}`)
  }
  songListSelectedPath = dirPath
  let songListSelectedPathArr = dirPath.split('/')
  songListSelectedPathArr.shift()
  songListSelected.value = songListSelectedPathArr.join('\\')
  selectSongListDialogShow.value = false
}

const emits = defineEmits(['cancel'])
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const flashArea = ref('') // 控制动画是否正在播放
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

const songListSelectedDisplay = computed(() => {
  let arr = songListSelected.value.split(/[/\\]/)
  if (arr[0]) arr[0] = toLibraryDisplayName(arr[0])
  return arr.join('\\')
})

const confirm = () => {
  if (props.mode === 'scan') {
    if (selectedPaths.value.length === 0) {
      if (!flashArea.value) flashBorder('selectedPaths')
      return
    }
  }
  if (!songListSelected.value) {
    if (!flashArea.value) flashBorder('songListPathVal')
    return
  }

  if (props.mode === 'scan') {
    if (props.openSongListAfterImport) {
      runtime.openSongListAfterImportUUID = importingSongListUUID
    }
    runtime.importingSongListUUID = importingSongListUUID
    runtime.isProgressing = true
    window.electron.ipcRenderer.send('startImportSongs', {
      selectedPaths: JSON.parse(JSON.stringify(selectedPaths.value)),
      songListPath: songListSelectedPath,
      isDeleteSourceFile: settingData.value.isDeleteSourceFile,
      isComparisonSongFingerprint: settingData.value.deduplicateMode === 'library',
      isPushSongFingerprintLibrary: settingData.value.isPushSongFingerprintLibrary,
      deduplicateMode: settingData.value.deduplicateMode,
      songListUUID: importingSongListUUID
    })
    localStorage.setItem('scanNewSongDialog', JSON.stringify(settingData.value))
    // 清除已选中的路径，为下次使用做准备
    selectedPaths.value = []
    closeWithAnimation(() => {
      ;(props.confirmCallback as Function)()
    })
  } else if (props.mode === 'drop') {
    localStorage.setItem('scanNewSongDialog', JSON.stringify(settingData.value))
    closeWithAnimation(() => {
      ;(props.confirmCallback as Function)({
        importingSongListUUID: importingSongListUUID,
        songListPath: songListSelectedPath,
        isDeleteSourceFile: settingData.value.isDeleteSourceFile,
        isComparisonSongFingerprint: settingData.value.deduplicateMode === 'library',
        isPushSongFingerprintLibrary: settingData.value.isPushSongFingerprintLibrary,
        deduplicateMode: settingData.value.deduplicateMode
      })
    })
  }
}

const cancel = () => {
  localStorage.setItem('scanNewSongDialog', JSON.stringify(settingData.value))
  // 取消时清空当前已选，确保下次新打开为空
  selectedPaths.value = []
  closeWithAnimation(() => {
    ;(props.cancelCallback as Function)()
    emits('cancel')
  })
}

const hint2Ref = useTemplateRef<HTMLImageElement>('hint2Ref')
// 为单选项的 hint 采用映射存储，避免动态 ref 失效
const dedupOptionHintRefs = reactive<Record<string, HTMLImageElement | null>>({})
function setDedupOptionHintRef(value: string, el: HTMLImageElement | null) {
  if (el) dedupOptionHintRefs[value] = el
}
const bindDedupOptionHintRef =
  (value: string) => (el: Element | ComponentPublicInstance | null) => {
    setDedupOptionHintRef(value, el instanceof HTMLImageElement ? el : null)
  }
const fileSelectRef = useTemplateRef<HTMLDivElement>('fileSelectRef')
const songListSelectRef = useTemplateRef<HTMLDivElement>('songListSelectRef')
onMounted(() => {
  hotkeys('E,Enter', uuid, () => {
    confirm()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
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
      style="width: 500px; height: 530px; display: flex; flex-direction: column"
      class="inner"
    >
      <div class="dialog-title dialog-header">
        <span>{{
          t('library.importNewTracks', { libraryType: toLibraryDisplayName(props.libraryName) })
        }}</span>
      </div>
      <div style="padding: 20px; font-size: 14px; flex: 1; overflow-y: auto">
        <template v-if="props.mode === 'scan'">
          <div>{{ t('library.selectFilesAndFolders') }}：</div>
          <div style="margin-top: 10px">
            <div
              ref="fileSelectRef"
              class="chooseDirDiv flashing-border"
              :class="{ 'is-flashing': flashArea == 'selectedPaths' }"
              @click="clickChooseDir()"
            >
              {{ selectedPathsDisplay || t('library.clickToSelect') }}
            </div>
            <bubbleBox
              :dom="fileSelectRef || undefined"
              :title="selectedPathsDisplay || t('library.clickToSelect')"
              :max-width="320"
            />
          </div>
        </template>

        <div style="margin-top: 20px">{{ t('library.selectPlaylist') }}：</div>
        <div style="margin-top: 10px">
          <div
            ref="songListSelectRef"
            class="chooseDirDiv flashing-border"
            :class="{ 'is-flashing': flashArea == 'songListPathVal' }"
            @click="clickChooseSongList()"
          >
            {{ songListSelectedDisplay || t('library.clickToSelect') }}
          </div>
          <bubbleBox
            :dom="songListSelectRef || undefined"
            :title="songListSelectedDisplay || t('library.clickToSelect')"
            :max-width="320"
          />
        </div>

        <div style="margin-top: 20px">
          <label for="import-checkbox-deleteAfterImport" style="user-select: none"
            >{{ t('library.deleteAfterImport') }}：</label
          >
        </div>
        <div style="margin-top: 10px">
          <singleCheckbox
            id="import-checkbox-deleteAfterImport"
            v-model="settingData.isDeleteSourceFile"
          />
        </div>

        <div style="margin-top: 20px">
          <label for="import-checkbox-addToFingerprintLibrary" style="user-select: none"
            >{{ t('library.addToFingerprintLibrary') }}：</label
          >
        </div>
        <div style="margin-top: 10px; display: inline-flex; align-items: center; gap: 6px">
          <singleCheckbox
            id="import-checkbox-addToFingerprintLibrary"
            v-model="settingData.isPushSongFingerprintLibrary"
          />
          <img
            ref="hint2Ref"
            :src="hintIcon"
            style="width: 15px; height: 15px"
            :draggable="false"
            class="theme-icon"
          />
          <bubbleBox
            :dom="hint2Ref || undefined"
            :title="t('library.fingerprintHint')"
            :max-width="240"
          />
        </div>

        <div style="margin-top: 20px">{{ t('library.deduplicateMode') }}：</div>
        <div style="margin-top: 10px">
          <singleRadioGroup
            v-model="settingData.deduplicateMode"
            :options="[
              { label: t('library.deduplicateModeLibrary'), value: 'library' },
              { label: t('library.deduplicateModeBatch'), value: 'batch' },
              { label: t('library.deduplicateModeNone'), value: 'none' }
            ]"
            name="dedupMode"
            :option-font-size="12"
          >
            <template #option="{ opt }">
              <span class="label">{{ opt.label }}</span>
              <template v-if="opt.value !== 'none'">
                <img
                  :ref="bindDedupOptionHintRef(opt.value)"
                  :src="hintIcon"
                  style="width: 14px; height: 14px; margin-left: 6px"
                  :draggable="false"
                  class="theme-icon"
                />
                <bubbleBox
                  :dom="dedupOptionHintRefs[opt.value] || null"
                  :title="
                    opt.value === 'library'
                      ? t('library.deduplicateHint')
                      : t('library.deduplicateBatchHint')
                  "
                  :max-width="320"
                />
              </template>
            </template>
          </singleRadioGroup>
        </div>
      </div>

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
  <selectSongListDialog
    v-if="selectSongListDialogShow"
    :library-name="props.libraryName"
    @confirm="selectSongListDialogConfirm"
    @cancel="
      () => {
        selectSongListDialogShow = false
      }
    "
  />

  <customFileSelector
    v-model:visible="customFileSelectorVisible"
    :multi-select="true"
    :allow-mixed-selection="true"
    :initial-selected-paths="selectedPaths"
    @confirm="onFileSelectorConfirm"
    @cancel="onFileSelectorCancel"
  />
</template>
<style lang="scss" scoped>
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
  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.formLabel {
  width: 110px;
  min-width: 110px;
  text-align: right;
  font-size: 14px;
  line-height: 20px;
  display: inline-flex;
  align-items: center;
}

/* 已统一 label 为右对齐，这里移除遗留类 */

.settingLabel {
  display: table-cell;
  text-align: right;
  font-size: 14px;
  white-space: nowrap;
  padding-right: 8px;
  height: 20px;
  line-height: 20px;
  vertical-align: middle;
}

.settingsTable {
  display: table;
  width: 100%;
  border-collapse: separate;
  border-spacing: 0 10px;
}

/* 仅对第一组表格（选择路径/歌单）启用固定布局与固定标签列宽，避免改变其他区域视觉布局 */
.settingsTable:first-of-type {
  table-layout: fixed;
}

.settingsTable:first-of-type .settingLabel {
  width: 126px;
}

.settingsRow {
  display: table-row;
}

.settingCell {
  display: table-cell;
  width: 100%;
  height: 20px;
  vertical-align: middle;
  overflow: hidden; /* 避免内容撑开表格，配合子元素省略号 */
}
</style>
