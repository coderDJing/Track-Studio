<script setup lang="ts">
import { computed } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { t } from '@renderer/utils/translate'

const props = defineProps<{
  songPresent: boolean
  writable: boolean
  preparing: boolean
  prepareFailed: boolean
  ready: boolean
  playing: boolean
  saving: boolean
  canUndo: boolean
  canRedo: boolean
  hasSelection: boolean
  startSet: boolean
  endSet: boolean
  hasClipboard: boolean
  loopCount: number
  hasLoopGroup: boolean
  selectionSummary: string
  dirty: boolean
  errorText?: string
  noticeText?: string
}>()

const emit = defineEmits<{
  (event: 'undo'): void
  (event: 'redo'): void
  (event: 'set-start'): void
  (event: 'set-end'): void
  (event: 'clear-selection'): void
  (event: 'cut'): void
  (event: 'copy'): void
  (event: 'paste'): void
  (event: 'loop'): void
  (event: 'loop-minus'): void
  (event: 'loop-plus'): void
  (event: 'retry-prepare'): void
  (event: 'save'): void
}>()

const timelineLocked = () => props.playing || props.saving || !props.writable
const mutationDisabled = () =>
  !props.songPresent || timelineLocked() || props.preparing || props.prepareFailed || !props.ready
const mutationHint = () => {
  if (!props.songPresent) return t('audioEdit.noSong')
  if (!props.writable) return t('audioEdit.readOnly')
  if (props.saving) return t('audioEdit.saving')
  if (props.playing) return t('audioEdit.playingLocked')
  if (props.preparing) return t('audioEdit.preparing')
  if (props.prepareFailed) return t('audioEdit.prepareFailed')
  return ''
}
const hasAnySelectionBound = computed(() => props.startSet || props.endSet)
const selectionActionHint = (fallback: string) =>
  mutationHint() || (!props.hasSelection ? t('audioEdit.completeSelection') : fallback)
const pasteHint = () =>
  mutationHint() || (!props.hasClipboard ? t('audioEdit.clipboardEmpty') : t('audioEdit.paste'))
const statusMessage = computed(() => {
  if (props.saving) return t('audioEdit.saving')
  if (props.errorText) return props.errorText
  if (!props.songPresent) return t('audioEdit.noSong')
  if (!props.writable) return t('audioEdit.readOnly')
  if (props.prepareFailed) return t('audioEdit.prepareFailed')
  if (props.preparing) return t('audioEdit.preparing')
  if (props.noticeText) return props.noticeText
  if (props.hasSelection && props.selectionSummary) {
    return t('audioEdit.selectionReady', { summary: props.selectionSummary })
  }
  if (props.startSet) return t('audioEdit.startReady')
  if (props.endSet) return t('audioEdit.endReady')
  return t('audioEdit.selectionGuide')
})
const statusTone = computed(() => {
  if (props.errorText || props.prepareFailed) return 'error'
  if (props.saving || props.preparing) return 'busy'
  if (props.noticeText) return 'success'
  return 'neutral'
})
const saveHint = () => {
  if (!props.songPresent) return t('audioEdit.noSong')
  if (!props.writable) return t('audioEdit.readOnly')
  if (props.saving) return t('audioEdit.saving')
  if (props.playing) return t('audioEdit.playingLocked')
  if (props.prepareFailed) return t('audioEdit.prepareFailed')
  if (props.preparing) return t('audioEdit.preparing')
  if (!props.ready) return t('audioEdit.notReadyToSave')
  if (!props.dirty) return t('audioEdit.noChanges')
  return t('audioEdit.save')
}
</script>

<template>
  <div class="audio-edit-toolbar" :class="{ 'is-saving': saving }">
    <div
      v-if="songPresent"
      class="audio-edit-toolbar__group"
      role="group"
      :aria-label="t('audioEdit.undo')"
    >
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="t('audioEdit.undo')"
        shortcut="Ctrl+Z"
      >
        <button
          type="button"
          :disabled="!canUndo || mutationDisabled()"
          :aria-label="t('audioEdit.undo')"
          @click="emit('undo')"
        >
          ↶
        </button>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="t('audioEdit.redo')"
        shortcut="Ctrl+Shift+Z / Ctrl+Y"
      >
        <button
          type="button"
          :disabled="!canRedo || mutationDisabled()"
          :aria-label="t('audioEdit.redo')"
          @click="emit('redo')"
        >
          ↷
        </button>
      </bubbleBoxTrigger>
    </div>

    <div
      v-if="songPresent"
      class="audio-edit-toolbar__group audio-edit-toolbar__group--separated"
      role="group"
      :aria-label="t('audioEdit.clearSelection')"
    >
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="t('audioEdit.setStart')"
      >
        <button
          type="button"
          :class="{ 'is-set': startSet }"
          :disabled="saving || !writable"
          @click="emit('set-start')"
        >
          {{ t('audioEdit.setStartShort') }}
        </button>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="t('audioEdit.setEnd')"
      >
        <button
          type="button"
          :class="{ 'is-set': endSet }"
          :disabled="saving || !writable"
          @click="emit('set-end')"
        >
          {{ t('audioEdit.setEndShort') }}
        </button>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="t('audioEdit.clearSelection')"
      >
        <button
          type="button"
          :disabled="saving || !hasAnySelectionBound"
          @click="emit('clear-selection')"
        >
          {{ t('audioEdit.clearSelectionShort') }}
        </button>
      </bubbleBoxTrigger>
    </div>

    <div
      v-if="songPresent"
      class="audio-edit-toolbar__group audio-edit-toolbar__group--separated"
      role="group"
      :aria-label="t('audioEdit.copy')"
    >
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="selectionActionHint(t('audioEdit.cut'))"
        shortcut="Ctrl+X"
      >
        <button type="button" :disabled="!hasSelection || mutationDisabled()" @click="emit('cut')">
          {{ t('audioEdit.cut') }}
        </button>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="!hasSelection ? t('audioEdit.completeSelection') : t('audioEdit.copy')"
        shortcut="Ctrl+C"
      >
        <button
          type="button"
          :disabled="!hasSelection || saving || !writable"
          @click="emit('copy')"
        >
          {{ t('audioEdit.copy') }}
        </button>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="pasteHint()"
        shortcut="Ctrl+V"
      >
        <button
          type="button"
          :disabled="!hasClipboard || mutationDisabled()"
          @click="emit('paste')"
        >
          {{ t('audioEdit.paste') }}
        </button>
      </bubbleBoxTrigger>
    </div>

    <div
      v-if="songPresent"
      class="audio-edit-toolbar__group audio-edit-toolbar__group--separated"
      role="group"
      :aria-label="t('audioEdit.loop')"
    >
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="selectionActionHint(t('audioEdit.loopHint'))"
      >
        <button type="button" :disabled="!hasSelection || mutationDisabled()" @click="emit('loop')">
          {{ t('audioEdit.loop') }}
        </button>
      </bubbleBoxTrigger>
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="mutationHint() || t('audioEdit.loopMinus')"
      >
        <button
          type="button"
          :disabled="!hasLoopGroup || loopCount <= 0 || mutationDisabled()"
          :aria-label="t('audioEdit.loopMinus')"
          @click="emit('loop-minus')"
        >
          −
        </button>
      </bubbleBoxTrigger>
      <span class="audio-edit-toolbar__count">×{{ hasLoopGroup ? loopCount : 0 }}</span>
      <bubbleBoxTrigger
        tag="span"
        wrapper-tag="span"
        wrapper-class="audio-edit-toolbar__anchor"
        :title="mutationHint() || t('audioEdit.loopPlus')"
      >
        <button
          type="button"
          :disabled="!hasLoopGroup || mutationDisabled()"
          :aria-label="t('audioEdit.loopPlus')"
          @click="emit('loop-plus')"
        >
          +
        </button>
      </bubbleBoxTrigger>
    </div>

    <bubbleBoxTrigger
      tag="span"
      wrapper-tag="span"
      wrapper-class="audio-edit-toolbar__status-anchor"
      :title="statusMessage"
    >
      <span class="audio-edit-toolbar__status" :class="`is-${statusTone}`" aria-live="polite">
        {{ statusMessage }}
      </span>
    </bubbleBoxTrigger>

    <bubbleBoxTrigger
      v-if="songPresent && prepareFailed"
      tag="span"
      wrapper-tag="span"
      wrapper-class="audio-edit-toolbar__anchor"
      :title="t('audioEdit.retryPrepare')"
    >
      <button type="button" :disabled="saving" @click="emit('retry-prepare')">
        {{ t('audioEdit.retryPrepare') }}
      </button>
    </bubbleBoxTrigger>

    <bubbleBoxTrigger
      v-if="songPresent"
      tag="span"
      wrapper-tag="span"
      wrapper-class="audio-edit-toolbar__save-anchor"
      :title="saveHint()"
      shortcut="Ctrl+S"
    >
      <button
        type="button"
        class="audio-edit-toolbar__save"
        :disabled="!writable || saving || playing || !dirty || !ready"
        @click="emit('save')"
      >
        {{ t('audioEdit.save') }}
      </button>
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.audio-edit-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.audio-edit-toolbar__group {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 0 0 auto;
}

.audio-edit-toolbar__group--separated {
  padding-left: 6px;
  border-left: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
}

.audio-edit-toolbar__anchor,
.audio-edit-toolbar__save-anchor {
  flex: 0 0 auto;
}

.audio-edit-toolbar button {
  height: 26px;
  min-width: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: color-mix(in srgb, var(--bg-elev) 86%, transparent);
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  line-height: 24px;
  cursor: pointer;
}

.audio-edit-toolbar button:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.audio-edit-toolbar button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 1px;
}

.audio-edit-toolbar button.is-set {
  border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--bg-elev));
}

.audio-edit-toolbar button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.audio-edit-toolbar__count {
  min-width: 24px;
  text-align: center;
  color: var(--text-weak);
  font-size: 11px;
  white-space: nowrap;
}

.audio-edit-toolbar__status-anchor {
  min-width: 72px;
  flex: 1 1 160px;
  overflow: hidden;
}

.audio-edit-toolbar__status {
  display: block;
  overflow: hidden;
  color: var(--text-weak);
  font-size: 11px;
  line-height: 26px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audio-edit-toolbar__status.is-error {
  color: var(--danger, #d84a4a);
}

.audio-edit-toolbar__status.is-busy {
  color: var(--accent);
}

.audio-edit-toolbar__status.is-success {
  color: var(--shell-play, #79b98f);
}

.audio-edit-toolbar__save {
  min-width: 48px !important;
  border-color: color-mix(in srgb, var(--accent) 72%, var(--border)) !important;
  color: var(--shell-active-control-text, #fff) !important;
  background: var(--accent) !important;
}

.audio-edit-toolbar__save:hover:not(:disabled) {
  filter: brightness(1.08);
}

.audio-edit-toolbar__save:disabled {
  color: var(--text-weak) !important;
  background: color-mix(in srgb, var(--bg-elev) 86%, transparent) !important;
  border-color: var(--border) !important;
}
</style>
