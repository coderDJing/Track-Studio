<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const uuid = uuidV4()
const emits = defineEmits(['confirm', 'cancel'])
const props = defineProps({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  placeholder: { type: String, default: 'DELETE' },
  confirmKeyword: { type: String, default: 'DELETE' },
  innerHeight: { type: Number, default: 260 },
  innerWidth: { type: Number, default: 460 }
})

const inputText = ref('')
const isValid = computed(
  () => inputText.value.trim().toLowerCase() === String(props.confirmKeyword).toLowerCase()
)

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const clickConfirm = () => {
  if (!isValid.value) return
  closeWithAnimation(() => emits('confirm', { text: inputText.value }))
}
const clickCancel = () => closeWithAnimation(() => emits('cancel'))

onMounted(() => {
  hotkeys('E,Enter', uuid, () => {
    if (isValid.value) clickConfirm()
  })
  hotkeys('Esc', uuid, () => clickCancel())
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>
<template>
  <div
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    style="font-size: 14px"
  >
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner"
      :style="'height:' + innerHeight + 'px;' + 'width:' + innerWidth + 'px;'"
      style="display: flex; flex-direction: column"
    >
      <div class="dialog-title dialog-header">
        <span style="color: #e81123">{{ props.title }}</span>
      </div>
      <div style="padding: 10px 20px 20px; flex: 1; overflow-y: auto">
        <div style="margin-top: 10px; text-align: left; color: #ffb900">
          <span>{{ props.description }}</span>
        </div>
        <div style="margin-top: 16px; text-align: left">
          <div style="margin-bottom: 6px">
            {{ t('common.input') }}: <b>{{ props.confirmKeyword }}</b>
          </div>
          <input
            v-model="inputText"
            class="dangerInput"
            :placeholder="props.placeholder"
            style="width: 100%"
          />
        </div>
      </div>
      <div class="dialog-footer">
        <div
          class="button"
          :class="{ disabled: !isValid }"
          style="width: 90px; text-align: center"
          @click="clickConfirm()"
        >
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="clickCancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.dangerInput {
  height: 25px;
  line-height: 25px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  padding: 0 6px;
  border-radius: 3px;

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
}
.button.disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>
