<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, useTemplateRef } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
const uuid = uuidV4()
const emits = defineEmits(['cancel'])

const flashArea = ref('') // 控制动画是否正在播放

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

const folderPathVal = ref<string[]>([]) //文件夹路径
let clickChooseDirFlag = false
const clickChooseDir = async () => {
  if (clickChooseDirFlag) {
    return
  }
  clickChooseDirFlag = true
  const folderPath = (await window.electron.ipcRenderer.invoke('select-songFingerprintFile')) as
    | string[]
    | 'error'
    | null
  clickChooseDirFlag = false
  if (folderPath) {
    if (folderPath === 'error') {
      await confirm({
        title: t('common.error'),
        content: [t('fingerprints.notValidFile')],
        confirmShow: false
      })
    } else {
      folderPathVal.value = folderPath
    }
  }
}

const folderPathDisplay = computed(() => {
  let newPaths = folderPathVal.value.map((path) => {
    let parts = path.split(/[/\\]/)
    return parts[parts.length - 1] ? parts[parts.length - 1] : parts[parts.length - 2]
  })
  let str = []
  for (let item of newPaths) {
    str.push('"' + item + '"')
  }
  return str.join(',')
})
const folderPathDisplayWithPlaceholder = computed(() => {
  return folderPathDisplay.value || t('library.clickToSelect')
})
const folderPathTooltip = computed(() => {
  return folderPathDisplay.value || t('library.clickToSelect')
})
const chooseDirRef = useTemplateRef<HTMLDivElement>('chooseDirRef')
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const handleConfirm = async () => {
  if (folderPathVal.value.length === 0) {
    if (!flashArea.value) {
      flashBorder('folderPathVal')
    }
    return
  }
  await window.electron.ipcRenderer.invoke('importSongFingerprint', folderPathVal.value[0])
  await confirm({
    title: t('common.success'),
    content: [t('import.completed')],
    confirmShow: false
  })
  cancel()
}
const cancel = () => {
  closeWithAnimation(() => emits('cancel'))
}
onMounted(() => {
  hotkeys('E,Enter', uuid, () => {
    handleConfirm()
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
      style="width: 500px; height: 320px; display: flex; flex-direction: column"
      class="inner"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t('fingerprints.importDatabase') }}</span>
      </div>
      <div style="padding: 20px; font-size: 14px; flex: 1; overflow-y: auto">
        <div>{{ t('fingerprints.selectDatabaseFile') }}：</div>
        <div style="margin-top: 10px">
          <div
            ref="chooseDirRef"
            class="chooseDirDiv flashing-border"
            :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
            @click="clickChooseDir()"
          >
            {{ folderPathDisplayWithPlaceholder }}
          </div>
          <bubbleBox :dom="chooseDirRef || undefined" :title="folderPathTooltip" :max-width="320" />
        </div>
        <div style="margin-top: 20px; font-size: 12px; color: var(--text-secondary)">
          {{ t('fingerprints.importMergeHint') }}
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" style="width: 90px; text-align: center" @click="handleConfirm()">
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
.chooseDirDiv {
  width: 100%;
  height: 25px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  max-width: 100%;
  font-size: 14px;
  padding-left: 5px;
  border-radius: 3px;
  box-sizing: border-box;
  line-height: 25px;
  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}
</style>
