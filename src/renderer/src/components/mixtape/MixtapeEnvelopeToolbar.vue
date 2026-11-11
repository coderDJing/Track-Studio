<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import type { MixtapeGainEnvelopeEditor } from '@renderer/composables/mixtape/useGainEnvelopeEditor'
import type { EnvelopeTool } from '@renderer/composables/mixtape/gainEnvelopeInteraction'

const props = defineProps<{
  editor: MixtapeGainEnvelopeEditor
  disabled: boolean
  expanded: boolean
}>()
const emit = defineEmits<{ (event: 'toggle-expanded'): void }>()
const { t } = useI18n()
const tools: EnvelopeTool[] = ['edit', 'line', 'range', 'curve']
const setGain = (event: Event) => {
  const input = event.target as HTMLInputElement
  props.editor.setSelectedEnvelopeDb(input.valueAsNumber)
  input.value = props.editor.selectedEnvelopeValue.value?.db.toFixed(1) ?? ''
}
</script>

<template>
  <div class="envelope-toolbar" :aria-label="t('mixtape.envelopeTools')">
    <div class="envelope-toolbar__tools" role="group" :aria-label="t('mixtape.envelopeTools')">
      <bubbleBoxTrigger
        v-for="tool in tools"
        :key="tool"
        tag="button"
        wrapper-tag="span"
        type="button"
        class="button envelope-toolbar__button"
        :class="{ 'is-active': editor.envelopeTool.value === tool }"
        :aria-pressed="editor.envelopeTool.value === tool"
        :disabled="disabled"
        :title="t(`mixtape.envelopeToolHint_${tool}`)"
        @click="editor.setEnvelopeTool(tool)"
        >{{ t(`mixtape.envelopeTool_${tool}`) }}</bubbleBoxTrigger
      >
    </div>
    <bubbleBoxTrigger
      tag="button"
      wrapper-tag="span"
      type="button"
      class="button envelope-toolbar__button"
      :class="{ 'is-active': editor.envelopeSnapEnabled.value }"
      :aria-pressed="editor.envelopeSnapEnabled.value"
      :disabled="disabled"
      :title="t('mixtape.envelopeSnapHint')"
      @click="editor.toggleEnvelopeSnap()"
      >{{ t('mixtape.envelopeSnap') }}</bubbleBoxTrigger
    >
    <bubbleBoxTrigger
      tag="button"
      wrapper-tag="span"
      type="button"
      class="button envelope-toolbar__button"
      :disabled="disabled || !editor.canUndoMixParam.value"
      :title="t('mixtape.undoActionHint')"
      @click="editor.undoLastMixParamChange()"
      >{{ t('mixtape.envelopeUndo') }}</bubbleBoxTrigger
    >
    <bubbleBoxTrigger
      tag="button"
      wrapper-tag="span"
      type="button"
      class="button envelope-toolbar__button"
      :disabled="disabled || !editor.canRedoMixParam.value"
      :title="t('mixtape.redoActionHint')"
      @click="editor.redoLastMixParamChange()"
      >{{ t('mixtape.envelopeRedo') }}</bubbleBoxTrigger
    >
    <bubbleBoxTrigger
      tag="button"
      wrapper-tag="span"
      type="button"
      class="button envelope-toolbar__button"
      :aria-pressed="expanded"
      :disabled="disabled || editor.isEnvelopeGestureActive.value"
      :title="t('mixtape.envelopeExpandHint')"
      @click="emit('toggle-expanded')"
      >{{ t(expanded ? 'mixtape.envelopeCollapse' : 'mixtape.envelopeExpand') }}</bubbleBoxTrigger
    >
    <label v-if="editor.selectedEnvelopeValue.value" class="envelope-toolbar__value">
      <span>{{ editor.selectedEnvelopeValue.value.sec.toFixed(3) }} s</span>
      <input
        type="number"
        step="0.1"
        :disabled="disabled || editor.isEnvelopeGestureActive.value"
        :aria-label="t('mixtape.envelopeExactValue')"
        :min="editor.selectedEnvelopeValue.value.min"
        :max="editor.selectedEnvelopeValue.value.max"
        :value="editor.selectedEnvelopeValue.value.db.toFixed(1)"
        @change="setGain"
        @keydown.stop
      /><span>dB</span>
    </label>
    <bubbleBoxTrigger
      v-if="editor.selectedEnvelopeValue.value"
      tag="button"
      wrapper-tag="span"
      type="button"
      class="button envelope-toolbar__button"
      :disabled="disabled || !editor.selectedEnvelopeValue.value.removable"
      :title="t('mixtape.envelopeDeleteHint')"
      @click="editor.deleteSelectedEnvelopePoint()"
      >{{ t('mixtape.envelopeDelete') }}</bubbleBoxTrigger
    >
    <span class="envelope-toolbar__hint">{{
      t(`mixtape.envelopeToolHint_${editor.envelopeTool.value}`)
    }}</span>
  </div>
</template>

<style scoped lang="scss">
.envelope-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 7px 10px;
  color: var(--text);
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  flex: 0 0 auto;
}
.envelope-toolbar__tools {
  display: flex;
  gap: 2px;
}
.envelope-toolbar__button {
  box-sizing: border-box;
  height: 26px;
  min-height: 26px;
  line-height: 18px;
  padding: 3px 8px;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.envelope-toolbar__button:disabled {
  opacity: 0.4;
  cursor: default;
}
.envelope-toolbar__button:disabled:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.envelope-toolbar__button.is-active {
  background: var(--hover);
  color: var(--accent);
  border-color: var(--accent);
}
.envelope-toolbar__value {
  display: flex;
  align-items: center;
  gap: 5px;
  font-variant-numeric: tabular-nums;
}
.envelope-toolbar__value input {
  width: 60px;
  padding: 3px 5px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
}
.envelope-toolbar__hint {
  color: var(--text-secondary);
  font-size: 11px;
  flex: 1 1 220px;
}
</style>
