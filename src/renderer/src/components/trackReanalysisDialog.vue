<script setup lang="ts">
import hotkeys from 'hotkeys-js'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { buildAnalysisBpmRangeOptions } from '@renderer/utils/analysisBpmRangeUi'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import {
  normalizeAnalysisBpmRangeId,
  type AnalysisBpmRangePresetId
} from '@shared/analysisBpmRange'
import {
  applyTrackReanalysisSelectionDependencies,
  hasAnyTrackReanalysisUserSelection,
  isTrackReanalysisBeatGridLocked,
  normalizeTrackReanalysisSelection,
  type TrackReanalysisUserSelection
} from '@shared/trackReanalysisSelection'

type TrackAnalysisDialogPurpose = 'reanalysis' | 'missing'
type TrackAnalysisDialogResult = {
  selection: TrackReanalysisUserSelection
  analysisBpmRangeId?: AnalysisBpmRangePresetId
}

const props = defineProps<{
  count: number
  initialSelection: TrackReanalysisUserSelection
  canSelectStructureAlone: boolean
  purpose?: TrackAnalysisDialogPurpose
  initialBpmRangeId?: AnalysisBpmRangePresetId
  confirmCallback?: (value: TrackAnalysisDialogResult) => void
  cancelCallback?: () => void
}>()

const runtime = useRuntimeStore()
const uuid = uuidV4()
const purpose = computed(() => props.purpose || 'reanalysis')
const selection = ref(
  applyTrackReanalysisSelectionDependencies(
    normalizeTrackReanalysisSelection(props.initialSelection),
    props.canSelectStructureAlone
  )
)
const selectedBpmRangeId = ref<AnalysisBpmRangePresetId>(
  normalizeAnalysisBpmRangeId(props.initialBpmRangeId)
)
const bpmRangeOptions = computed(() => buildAnalysisBpmRangeOptions(selectedBpmRangeId.value))
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const beatGridLocked = computed(() =>
  isTrackReanalysisBeatGridLocked(selection.value, props.canSelectStructureAlone)
)
const showBpmRange = computed(() => selection.value.beatGrid === true)
const warnGridWithoutStructure = computed(
  () => selection.value.beatGrid && !selection.value.structure
)
const canConfirm = computed(() => hasAnyTrackReanalysisUserSelection(selection.value))
const dialogTitle = computed(() =>
  purpose.value === 'missing' ? t('tracks.analysisDialogTitle') : t('tracks.reanalysisDialogTitle')
)
const dialogSummary = computed(() =>
  purpose.value === 'missing'
    ? t('tracks.analysisDialogSummary', { count: props.count })
    : t('tracks.reanalysisDialogSummary', { count: props.count })
)
const startButtonText = computed(() => t('tracks.analysisStart'))
const dependencyHintText = computed(() => {
  if (beatGridLocked.value && selection.value.energy && !selection.value.structure) {
    return t('tracks.analysisEnergyGridLockedHint')
  }
  if (beatGridLocked.value) return t('tracks.analysisGridLockedHint')
  if (warnGridWithoutStructure.value) return t('tracks.analysisGridWithoutStructureHint')
  if (props.canSelectStructureAlone) return t('tracks.reanalysisStructureAloneHint')
  return t('tracks.reanalysisStructureUnavailableHint')
})

const applySelection = (next: TrackReanalysisUserSelection) => {
  selection.value = applyTrackReanalysisSelectionDependencies(next, props.canSelectStructureAlone)
}

const confirm = () => {
  if (!canConfirm.value) return
  const next = applyTrackReanalysisSelectionDependencies(
    selection.value,
    props.canSelectStructureAlone
  )
  if (!hasAnyTrackReanalysisUserSelection(next)) return
  closeWithAnimation(() =>
    props.confirmCallback?.({
      selection: next,
      analysisBpmRangeId: next.beatGrid ? selectedBpmRangeId.value : undefined
    })
  )
}

const cancel = () => {
  closeWithAnimation(() => props.cancelCallback?.())
}

watch(
  () => [selection.value.structure, selection.value.energy],
  () => {
    applySelection(selection.value)
  }
)

onMounted(() => {
  runtime.confirmShow = true
  hotkeys('E,Enter', uuid, confirm)
  hotkeys('Esc', uuid, cancel)
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  runtime.confirmShow = false
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner track-reanalysis-dialog">
      <div class="dialog-title dialog-header">
        <span>{{ dialogTitle }}</span>
      </div>

      <div class="track-reanalysis-dialog__content">
        <div class="track-reanalysis-dialog__summary">
          {{ dialogSummary }}
        </div>

        <div class="track-reanalysis-dialog__options">
          <singleCheckbox id="reanalysis-option-key" v-model="selection.key">
            {{ t('tracks.reanalysisOptionKey') }}
          </singleCheckbox>
          <div class="track-reanalysis-dialog__grid-row">
            <bubbleBoxTrigger
              tag="div"
              class="track-reanalysis-dialog__grid-option"
              :title="beatGridLocked ? dependencyHintText : ''"
            >
              <singleCheckbox
                id="reanalysis-option-beat-grid"
                v-model="selection.beatGrid"
                :disabled="beatGridLocked"
              >
                {{ t('tracks.reanalysisOptionBeatGrid') }}
              </singleCheckbox>
            </bubbleBoxTrigger>
            <bubbleBoxTrigger
              tag="div"
              class="track-reanalysis-dialog__bpm"
              :class="{ 'is-hidden': !showBpmRange }"
              :title="showBpmRange ? t('settings.analysisBpmRange.dialogHint') : ''"
              :inert="!showBpmRange"
            >
              <span>{{ t('settings.analysisBpmRange.label') }}</span>
              <BaseSelect
                v-model="selectedBpmRangeId"
                :options="bpmRangeOptions"
                :disabled="!showBpmRange"
                :show-bubble="false"
                :width="168"
                :max-height="280"
              />
            </bubbleBoxTrigger>
          </div>
          <singleCheckbox id="reanalysis-option-waveform" v-model="selection.waveform">
            {{ t('tracks.reanalysisOptionWaveform') }}
          </singleCheckbox>
          <singleCheckbox id="reanalysis-option-energy" v-model="selection.energy">
            {{ t('tracks.reanalysisOptionEnergy') }}
          </singleCheckbox>
          <singleCheckbox id="reanalysis-option-structure" v-model="selection.structure">
            {{ t('tracks.reanalysisOptionStructure') }}
          </singleCheckbox>
        </div>

        <div
          class="track-reanalysis-dialog__hint"
          :class="{ 'track-reanalysis-dialog__hint--warning': warnGridWithoutStructure }"
        >
          {{ dependencyHintText }}
        </div>
      </div>

      <div class="dialog-footer">
        <bubbleBoxTrigger
          v-if="!canConfirm"
          tag="div"
          class="button track-reanalysis-dialog__button is-disabled"
          :title="t('tracks.reanalysisSelectAtLeastOne')"
        >
          {{ startButtonText }} (E)
        </bubbleBoxTrigger>
        <div v-else class="button track-reanalysis-dialog__button" @click="confirm">
          {{ startButtonText }} (E)
        </div>
        <div class="button track-reanalysis-dialog__button" @click="cancel">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.track-reanalysis-dialog {
  width: 500px;
  height: auto;
  display: flex;
  flex-direction: column;
}

.track-reanalysis-dialog__content {
  display: flex;
  flex-direction: column;
  padding: 22px 28px 16px;
  color: var(--text);
}

.track-reanalysis-dialog__summary {
  min-height: 3.2em;
  margin-bottom: 18px;
  text-align: center;
  line-height: 1.6;
}

.track-reanalysis-dialog__options {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.track-reanalysis-dialog__grid-row {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 30px;
  width: 100%;
  box-sizing: border-box;
}

.track-reanalysis-dialog__grid-option {
  display: inline-flex;
  flex-shrink: 0;
}

.track-reanalysis-dialog__bpm {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  min-width: 0;
  color: var(--text-secondary, #8c8c8c);
  font-size: 13px;
  box-sizing: border-box;
}

.track-reanalysis-dialog__bpm.is-hidden {
  visibility: hidden;
  pointer-events: none;
}

.track-reanalysis-dialog__hint {
  margin-top: 18px;
  height: 4.8em;
  color: var(--text-secondary, #8c8c8c);
  font-size: 12px;
  line-height: 1.6;
}

.track-reanalysis-dialog__hint--warning {
  color: var(--warning, #b67500);
}

.track-reanalysis-dialog__button {
  width: 110px;
  text-align: center;
}

.track-reanalysis-dialog__button.is-disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
