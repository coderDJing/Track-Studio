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
  isDynamicAnalysisGridAvailable,
  normalizeAnalysisGridMode,
  type AnalysisGridMode
} from '@shared/analysisGridMode'
import {
  ANALYSIS_GRID_MODE_HINT_KEYS,
  buildAnalysisGridModeOptions,
  isAnalysisGridSubmitBlocked
} from '@renderer/utils/analysisGridModeUi'
import {
  applyTrackReanalysisSelectionDependencies,
  hasAnyTrackReanalysisUserSelection,
  isTrackReanalysisBeatGridLocked,
  normalizeTrackReanalysisSelection,
  type TrackReanalysisUserSelection
} from '@shared/trackReanalysisSelection'
import { ensureAnalysisRuntimeForTrackReanalysis } from '@renderer/utils/trackReanalysisRuntimeGate'

type TrackAnalysisDialogPurpose = 'reanalysis' | 'missing'
type TrackAnalysisDialogResult = {
  selection: TrackReanalysisUserSelection
  analysisBpmRangeId?: AnalysisBpmRangePresetId
  analysisGridMode?: AnalysisGridMode
}

const props = defineProps<{
  count: number
  initialSelection: TrackReanalysisUserSelection
  canSelectStructureAlone: boolean
  purpose?: TrackAnalysisDialogPurpose
  initialBpmRangeId?: AnalysisBpmRangePresetId
  initialGridMode?: AnalysisGridMode
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
const selectedGridMode = ref<AnalysisGridMode>(normalizeAnalysisGridMode(props.initialGridMode))
const gateBusy = ref(false)
const gridModeAvailable = isDynamicAnalysisGridAvailable({ isDevelopment: import.meta.env.DEV })
const gridModeOptions = computed(() =>
  buildAnalysisGridModeOptions({ dynamicAvailable: gridModeAvailable })
)
const gridModeHintText = computed(() =>
  gridModeAvailable
    ? t(ANALYSIS_GRID_MODE_HINT_KEYS.dynamicScope)
    : t(ANALYSIS_GRID_MODE_HINT_KEYS.productionDisabled)
)
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const beatGridLocked = computed(() =>
  isTrackReanalysisBeatGridLocked(selection.value, props.canSelectStructureAlone)
)
const showBpmRange = computed(() => selection.value.beatGrid === true)
const gridSubmitBlocked = computed(() =>
  isAnalysisGridSubmitBlocked({
    beatGridSelected: showBpmRange.value,
    mode: selectedGridMode.value,
    dynamicAvailable: gridModeAvailable
  })
)
const warnGridWithoutStructure = computed(
  () => selection.value.beatGrid && !selection.value.structure
)
const canConfirm = computed(
  () => hasAnyTrackReanalysisUserSelection(selection.value) && !gridSubmitBlocked.value
)
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

const confirm = async () => {
  if (!canConfirm.value || gridSubmitBlocked.value) return
  // 门禁等待提示框期间，快捷键与连续点击都不能重复提交。
  if (gateBusy.value) return
  const next = applyTrackReanalysisSelectionDependencies(
    selection.value,
    props.canSelectStructureAlone
  )
  if (!hasAnyTrackReanalysisUserSelection(next)) return
  gateBusy.value = true
  try {
    // 需要分析运行时却没就绪时，在这里就地给出下载中 / 下载确认 / 失败提示，本次不提交。
    const runtimeReady = await ensureAnalysisRuntimeForTrackReanalysis(next)
    if (!runtimeReady) return
  } finally {
    gateBusy.value = false
  }
  closeWithAnimation(() =>
    props.confirmCallback?.({
      selection: next,
      analysisBpmRangeId: next.beatGrid ? selectedBpmRangeId.value : undefined,
      analysisGridMode: next.beatGrid ? selectedGridMode.value : undefined
    })
  )
}

const cancel = () => {
  closeWithAnimation(() => props.cancelCallback?.())
}

// 只补选依赖网格，避免替换整个 selection 后再次触发同一个监听器。
watch(beatGridLocked, (locked) => {
  if (locked) selection.value.beatGrid = true
})

onMounted(() => {
  runtime.confirmShow = true
  // hotkeys 的 handler 不能返回 Promise，门禁等待期间的重复触发由 gateBusy 拦截。
  hotkeys('E,Enter', uuid, () => {
    void confirm()
  })
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
          <div
            class="track-reanalysis-dialog__grid-mode"
            :class="{ 'is-hidden': !showBpmRange }"
            :inert="!showBpmRange"
          >
            <span>{{ t('settings.analysisGridMode.label') }}</span>
            <bubbleBoxTrigger
              tag="div"
              class="track-reanalysis-dialog__mode-select"
              :title="showBpmRange ? gridModeHintText : ''"
            >
              <BaseSelect
                v-model="selectedGridMode"
                :options="gridModeOptions"
                :disabled="!showBpmRange"
                :show-bubble="false"
                :width="168"
                :max-height="200"
              />
            </bubbleBoxTrigger>
          </div>
          <div class="track-reanalysis-dialog__mode-hint" :class="{ 'is-hidden': !showBpmRange }">
            {{ gridModeHintText }}
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
          :title="
            gridSubmitBlocked
              ? t(ANALYSIS_GRID_MODE_HINT_KEYS.productionDisabled)
              : t('tracks.reanalysisSelectAtLeastOne')
          "
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

.track-reanalysis-dialog__grid-mode {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  color: var(--text-secondary, #8c8c8c);
  font-size: 13px;
}

.track-reanalysis-dialog__grid-mode.is-hidden {
  visibility: hidden;
  pointer-events: none;
}

.track-reanalysis-dialog__mode-select {
  display: inline-flex;
}

.track-reanalysis-dialog__mode-hint {
  color: var(--text-secondary, #8c8c8c);
  font-size: 12px;
  line-height: 1.5;
}

.track-reanalysis-dialog__mode-hint.is-hidden {
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
