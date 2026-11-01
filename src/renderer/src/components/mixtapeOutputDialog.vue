<script setup lang="ts">
import { computed, ref } from 'vue'
import { t, tLabel } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'

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
const dialogInnerStyle = computed(
  () => 'width: 500px; height: 280px; display: flex; flex-direction: column'
)

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
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner" :style="dialogInnerStyle">
      <div class="dialog-title dialog-header">
        <span>{{ t('mixtape.outputDialogTitle') }}</span>
      </div>
      <div class="dialog-body">
        <div class="form-row">
          <div class="form-label">{{ tLabel('mixtape.outputPath') }}</div>
          <div class="form-field">
            <bubbleBoxTrigger
              tag="div"
              class="chooseDirDiv"
              :class="{ 'chooseDirDiv--empty': !draftPath }"
              :title="outputPathDisplay"
              @click="handlePickOutputPath"
            >
              {{ outputPathDisplay }}
            </bubbleBoxTrigger>
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ tLabel('mixtape.outputFormat') }}</div>
          <div class="form-field">
            <BaseSelect v-model="draftFormat" :options="formatOptions" :width="140" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">{{ tLabel('mixtape.outputFilename') }}</div>
          <div class="form-field">
            <input v-model="draftFilename" class="dialog-input" type="text" />
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="confirm">{{ t('mixtape.outputAction') }}</div>
        <div class="button" @click="cancel">{{ t('common.cancel') }}</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.dialog-body {
  padding: 16px 20px 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.form-row--start {
  align-items: flex-start;
}

.form-label {
  width: 90px;
  text-align: left;
  font-size: 13px;
  color: var(--textColor);
  flex: 0 0 90px;
}

.form-field {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--textColor3);
}

.form-hint--sub {
  margin-top: -4px;
}

.dialog-input {
  width: 100%;
  height: 36px;
  box-sizing: border-box;
  background: var(--inputBG);
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  color: var(--textColor);
  padding: 0 12px;
  outline: none;
}

.dialog-input:focus {
  border-color: var(--mainColor);
}

.chooseDirDiv {
  width: 100%;
  min-height: 36px;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid var(--borderColor);
  background: var(--inputBG);
  color: var(--textColor);
  padding: 8px 12px;
  line-height: 20px;
  cursor: pointer;
  word-break: break-all;
}

.chooseDirDiv--empty {
  color: var(--textColor3);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px 20px;
}

.button {
  min-width: 88px;
  height: 34px;
  line-height: 34px;
  text-align: center;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  background: var(--buttonBG);
  color: var(--textColor);
  transition: opacity 0.2s ease;
}

.button:hover {
  opacity: 0.9;
}
</style>
