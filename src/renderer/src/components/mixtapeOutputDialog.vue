<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import { t, tLabel } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import utils from '@renderer/utils/utils'

const scope = uuidV4()

const props = defineProps({
  outputPath: {
    type: String,
    default: ''
  },
  outputFormat: {
    type: String as () => 'wav' | 'mp3',
    default: 'wav'
  },
  outputFilename: {
    type: String,
    default: ''
  }
})

const emit = defineEmits<{
  (
    event: 'confirm',
    payload: {
      outputPath: string
      outputFormat: 'wav' | 'mp3'
      outputFilename: string
    }
  ): void
  (event: 'cancel'): void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const draftPath = ref(props.outputPath)
const draftFormat = ref<'wav' | 'mp3'>(props.outputFormat)
const draftFilename = ref(props.outputFilename)
const dialogInnerStyle = computed(() => 'width: 480px; display: flex; flex-direction: column')

const outputPathDisplay = computed(() => {
  return draftPath.value || t('mixtape.outputPathPlaceholder')
})

const formatOptions = computed(() => [
  { label: 'WAV', value: 'wav' },
  { label: 'MP3', value: 'mp3' }
])

const handlePickOutputPath = async () => {
  const result = (await window.electron.ipcRenderer.invoke('select-folder', false)) as
    string[] | null
  const nextPath = Array.isArray(result) ? result[0] : ''
  if (nextPath) {
    draftPath.value = nextPath
  }
}

const confirm = () => {
  emit('confirm', {
    outputPath: draftPath.value,
    outputFormat: draftFormat.value,
    outputFilename: draftFilename.value
  })
}

const cancel = () => {
  closeWithAnimation(() => {
    emit('cancel')
  })
}

onMounted(() => {
  hotkeys('E,Enter', scope, () => {
    confirm()
    return false
  })
  hotkeys('Esc', scope, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(scope)
})

onUnmounted(() => {
  utils.delHotkeysScope(scope)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner" :style="dialogInnerStyle">
      <div class="dialog-title dialog-header">
        <span>{{ t('mixtape.outputDialogTitle') }}</span>
      </div>
      <div class="dialog-content">
        <div class="form-row">
          <div class="form-label">{{ tLabel('mixtape.outputPath') }}</div>
          <div class="form-control">
            <bubbleBoxTrigger
              tag="div"
              class="choose-dir"
              :class="{ 'choose-dir--empty': !draftPath }"
              :title="outputPathDisplay"
              @click="handlePickOutputPath"
            >
              {{ outputPathDisplay }}
            </bubbleBoxTrigger>
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ tLabel('mixtape.outputFormat') }}</div>
          <div class="form-control">
            <BaseSelect
              v-model="draftFormat"
              :options="formatOptions"
              width="100%"
              :show-bubble="false"
            />
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ tLabel('mixtape.outputFilename') }}</div>
          <div class="form-control">
            <input v-model="draftFilename" class="text-input" type="text" />
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="confirm">{{ t('mixtape.outputAction') }} (E)</div>
        <div class="button" @click="cancel">{{ t('common.cancel') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.dialog-content {
  padding: 16px 18px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
}

.form-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.form-label {
  width: 100px;
  flex: 0 0 100px;
  text-align: right;
  font-size: 14px;
  color: var(--text);
}

.form-control {
  flex: 1 1 auto;
  min-width: 0;
}

/* BaseSelect 自带横向 padding 且未设 border-box，必须显式收敛，否则 width:100% 会溢出 */
.form-control :deep(.base-select) {
  box-sizing: border-box;
  width: 100%;
  height: 30px;
}

/* 与 BaseSelect 的 28px 内容高 + 1px 边框保持一致，三个控件外高统一为 30px */
.choose-dir,
.text-input {
  width: 100%;
  height: 30px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg-elev);
  color: var(--text);
  font-size: 14px;
}

.choose-dir {
  padding: 0 10px;
  line-height: 28px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.choose-dir--empty {
  color: var(--text-secondary);
}

.text-input {
  padding: 0 10px;
  outline: none;

  &:focus {
    border-color: var(--accent);
  }
}
</style>
