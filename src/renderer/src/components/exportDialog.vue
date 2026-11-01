<script setup lang="ts">
import singleCheckbox from './singleCheckbox.vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { ref, onUnmounted, onMounted } from 'vue'
import { t, tLabel } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
const uuid = uuidV4()
const props = defineProps({
  title: {
    type: String,
    default: ''
  },
  confirmCallback: {
    type: Function,
    required: true
  },
  cancelCallback: {
    type: Function,
    required: true
  },
  forceCopyOnly: {
    type: Boolean,
    default: false
  }
})
const flashArea = ref('') // 控制动画是否正在播放
const { dialogVisible, closeWithAnimation } = useDialogTransition()

// 模拟闪烁三次的逻辑（使用 setTimeout）
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = '' // 动画结束，不再闪烁
    }
  }, 500) // 每次闪烁间隔 500 毫秒
}
const folderPathVal = ref('') //文件夹路径
const pathNotExist = ref(false)
let clickChooseDirFlag = false
const clickChooseDir = async () => {
  if (clickChooseDirFlag) {
    return
  }
  clickChooseDirFlag = true
  const folderPath = await window.electron.ipcRenderer.invoke('select-folder', false)
  clickChooseDirFlag = false
  if (folderPath) {
    folderPathVal.value = folderPath[0]
  }
}
const deleteSongsAfterExport = ref(false)
const localStorageKey = 'exportDialog'
let localStorageData = localStorage.getItem(localStorageKey)
if (localStorageData === null) {
  localStorage.setItem(
    localStorageKey,
    JSON.stringify({
      deleteSongsAfterExport: true,
      folderPathVal: ''
    })
  )
  deleteSongsAfterExport.value = true
} else {
  const parsedLocalStorageData = JSON.parse(localStorageData) as {
    deleteSongsAfterExport: boolean
    folderPathVal?: string
  }
  deleteSongsAfterExport.value = parsedLocalStorageData.deleteSongsAfterExport
  if (parsedLocalStorageData.folderPathVal) {
    folderPathVal.value = parsedLocalStorageData.folderPathVal
  }
}
if (props.forceCopyOnly) {
  deleteSongsAfterExport.value = false
}

const saveLocalStorage = () => {
  localStorage.setItem(
    localStorageKey,
    JSON.stringify({
      deleteSongsAfterExport: props.forceCopyOnly ? false : deleteSongsAfterExport.value,
      folderPathVal: folderPathVal.value
    })
  )
}

const confirm = async () => {
  if (folderPathVal.value === '') {
    if (!flashArea.value) {
      flashBorder('folderPathVal')
    }
    return
  }
  const exists = await window.electron.ipcRenderer.invoke('check-path-exists', folderPathVal.value)
  if (!exists) {
    pathNotExist.value = true
    setTimeout(() => {
      pathNotExist.value = false
    }, 3000)
    return
  }
  saveLocalStorage()
  closeWithAnimation(() => {
    props.confirmCallback({
      folderPathVal: folderPathVal.value,
      deleteSongsAfterExport: props.forceCopyOnly ? false : deleteSongsAfterExport.value
    })
  })
}

const cancel = () => {
  saveLocalStorage()
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
      style="width: 450px; height: 300px; display: flex; flex-direction: column"
      class="inner"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t(props.title) }} {{ t('export.exportTo') }}</span>
      </div>
      <div
        style="
          padding: 20px 20px 0;
          flex: 1 1 auto;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          gap: 30px;
        "
      >
        <div style="display: flex">
          <div class="formLabel">
            <span>{{ tLabel('tracks.exportToFolder') }}</span>
          </div>
          <div style="width: 290px">
            <bubbleBoxTrigger
              tag="div"
              class="chooseDirDiv flashing-border"
              :title="folderPathVal"
              :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
              @click="clickChooseDir()"
            >
              {{ folderPathVal }}
            </bubbleBoxTrigger>
            <div v-if="pathNotExist" class="pathNotExistHint">
              {{ t('tracks.exportPathNotExist') }}
            </div>
          </div>
        </div>
        <div v-if="!props.forceCopyOnly" style="display: flex">
          <div class="formLabel" style="text-align: right">
            <label for="export-checkbox-deleteAfterExport" style="user-select: none">{{
              tLabel('tracks.deleteAfterExport')
            }}</label>
          </div>
          <div style="flex: 1; width: 21px; height: 21px; display: flex; align-items: center">
            <singleCheckbox
              id="export-checkbox-deleteAfterExport"
              v-model="deleteSongsAfterExport"
            />
          </div>
        </div>
        <div v-else class="copyOnlyHint">
          {{ t('tracks.exportCopyOnlyHint') }}
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
.chooseDirDiv {
  width: 100%;
  height: 100%;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  font-size: 14px;
  padding-left: 5px;
  border-radius: 3px;
  box-sizing: border-box;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.formLabel {
  text-align: left;
  font-size: 14px;
}

.copyOnlyHint {
  font-size: 13px;
  color: var(--text-weak);
  line-height: 1.5;
}

.pathNotExistHint {
  font-size: 12px;
  color: var(--error, #f56c6c);
  margin-top: 4px;
  line-height: 1.4;
}
</style>
