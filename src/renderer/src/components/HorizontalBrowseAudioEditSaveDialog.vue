<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t, tLabel } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useRuntimeStore } from '@renderer/stores/runtime'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'

const props = defineProps<{
  originalTitle: string
  originalFormat: string
  versionPreviewName: string
  losslessSource: boolean
}>()

const emit = defineEmits<{
  (
    event: 'confirm',
    payload: { target: 'overwrite' | 'new-version'; format: 'original' | 'wav' }
  ): void
  (event: 'cancel'): void
}>()

const uuid = uuidV4()
const runtime = useRuntimeStore()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const target = ref<'overwrite' | 'new-version'>('new-version')
const format = ref<'original' | 'wav'>('original')
const confirmButtonRef = ref<HTMLElement | null>(null)

const effectiveCanOverwrite = computed(() => {
  if (format.value === 'original') return true
  return ['wav', 'wave'].includes(props.originalFormat.toLowerCase())
})

const targetOptions = computed(() => {
  const options = [{ label: t('audioEdit.newVersion'), value: 'new-version' }]
  if (effectiveCanOverwrite.value) {
    options.push({ label: t('audioEdit.overwrite'), value: 'overwrite' })
  }
  return options
})

const formatOptions = computed(() => [
  {
    label: t('audioEdit.keepFormat', { format: props.originalFormat }),
    value: 'original'
  },
  { label: t('audioEdit.pcmWav'), value: 'wav' }
])

const keepFormatHint = computed(() =>
  props.losslessSource ? t('audioEdit.keepFormatLossless') : t('audioEdit.keepFormatLossy')
)

watch(format, () => {
  if (!effectiveCanOverwrite.value) target.value = 'new-version'
})

watch(dialogVisible, (visible) => {
  if (visible) void nextTick(() => confirmButtonRef.value?.focus())
})

const confirmLabel = computed(() =>
  target.value === 'overwrite' ? t('audioEdit.confirmOverwrite') : t('audioEdit.confirmNewVersion')
)

const confirm = () => {
  const nextTarget = effectiveCanOverwrite.value ? target.value : 'new-version'
  closeWithAnimation(() => {
    emit('confirm', { target: nextTarget, format: format.value })
  })
}

const cancel = () => {
  closeWithAnimation(() => emit('cancel'))
}

onMounted(() => {
  hotkeys('E,Enter', uuid, () => confirm())
  hotkeys('Esc', uuid, () => cancel())
  utils.setHotkeysScpoe(uuid)
  runtime.confirmShow = true
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.confirmShow = false
})
</script>

<template>
  <div
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="`${uuid}-title`"
    style="font-size: 14px"
  >
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner"
      style="display: flex; flex-direction: column; width: 460px; height: auto"
    >
      <div class="dialog-title dialog-header">
        <span :id="`${uuid}-title`">{{ t('audioEdit.saveTitle') }}</span>
      </div>
      <div class="audio-edit-save">
        <div class="audio-edit-save__song">{{ originalTitle }}</div>
        <div class="audio-edit-save__label">{{ tLabel('audioEdit.saveTarget') }}</div>
        <singleRadioGroup
          v-model="target"
          class="audio-edit-save__target"
          :name="`${uuid}-target`"
          :options="targetOptions"
          :option-font-size="14"
        >
          <template #option="{ opt }">
            <span class="audio-edit-save__option-body">
              <span class="audio-edit-save__option-title">
                <span class="label">{{ opt.label }}</span>
                <span v-if="opt.value === 'new-version'" class="audio-edit-save__recommended">{{
                  t('audioEdit.recommended')
                }}</span>
              </span>
              <span v-if="opt.value === 'new-version'" class="audio-edit-save__option-hint">{{
                t('audioEdit.newVersionHint', { name: versionPreviewName })
              }}</span>
            </span>
          </template>
        </singleRadioGroup>
        <p v-if="!effectiveCanOverwrite" class="audio-edit-save__hint">
          {{ t('audioEdit.formatChangeForced') }}
        </p>

        <div class="audio-edit-save__label">{{ tLabel('audioEdit.outputFormat') }}</div>
        <singleRadioGroup
          v-model="format"
          class="audio-edit-save__format"
          :name="`${uuid}-format`"
          :options="formatOptions"
          :option-font-size="14"
        >
          <template #option="{ opt }">
            <span class="audio-edit-save__option-body">
              <span class="label">{{ opt.label }}</span>
              <span class="audio-edit-save__option-hint">{{
                opt.value === 'wav' ? t('audioEdit.pcmWavHint') : keepFormatHint
              }}</span>
            </span>
          </template>
        </singleRadioGroup>
      </div>
      <div class="dialog-footer">
        <div
          ref="confirmButtonRef"
          class="button audio-edit-save__confirm"
          :class="{ 'audio-edit-save__confirm--danger': target === 'overwrite' }"
          tabindex="0"
          @click="confirm()"
        >
          {{ confirmLabel }} (E)
        </div>
        <div class="button audio-edit-save__confirm" tabindex="0" @click="cancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.audio-edit-save {
  padding: 12px 20px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--text);
}

.audio-edit-save__label {
  margin-top: 8px;
}

.audio-edit-save__song {
  overflow: hidden;
  color: var(--text);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audio-edit-save__recommended {
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  font-size: 12px;
  line-height: 16px;
}

.audio-edit-save__target,
.audio-edit-save__format {
  gap: 12px;
}

.audio-edit-save__target :deep(.radio),
.audio-edit-save__format :deep(.radio) {
  align-items: flex-start;
  width: 100%;
}

.audio-edit-save__target :deep(.radio:hover) .label,
.audio-edit-save__format :deep(.radio:hover) .label {
  color: var(--accent);
}

.audio-edit-save__option-body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 4px;
}

.audio-edit-save__option-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.audio-edit-save__hint,
.audio-edit-save__option-hint {
  color: var(--text-weak);
  font-size: 12px;
  line-height: 1.4;
}

.audio-edit-save__hint {
  margin: 0 0 4px 26px;
}

.audio-edit-save__option-hint {
  margin: 0;
}

.audio-edit-save__confirm {
  min-width: 132px;
  padding: 0 14px;
  box-sizing: border-box;
  text-align: center;
  white-space: nowrap;
}

.audio-edit-save__confirm--danger {
  color: var(--danger, #d84a4a);
}

.dialog-footer {
  justify-content: center;
}
</style>
