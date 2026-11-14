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
/** 网格被锁定时的原因，同时用于勾选框气泡与底部提示。 */
const gridLockedHint = computed(() => {
  if (!beatGridLocked.value) return ''
  return selection.value.energy && !selection.value.structure
    ? t('tracks.analysisEnergyGridLockedHint')
    : t('tracks.analysisGridLockedHint')
})
/** 段落能否单独分析，放在段落的悬停气泡里，不占正文版面。 */
const structureOptionHint = computed(() =>
  props.canSelectStructureAlone
    ? t('tracks.reanalysisStructureAloneHint')
    : t('tracks.reanalysisStructureUnavailableHint')
)
/** 底部提示只在需要用户注意时出现，其余情况不保留空行。 */
const statusHint = computed<{ text: string; warning: boolean } | null>(() => {
  if (gridSubmitBlocked.value) {
    return { text: t(ANALYSIS_GRID_MODE_HINT_KEYS.productionDisabled), warning: true }
  }
  if (gridLockedHint.value) return { text: gridLockedHint.value, warning: false }
  if (warnGridWithoutStructure.value) {
    return { text: t('tracks.analysisGridWithoutStructureHint'), warning: true }
  }
  return null
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

          <div class="track-reanalysis-dialog__grid-group">
            <bubbleBoxTrigger
              tag="div"
              class="track-reanalysis-dialog__option-tip"
              :title="gridLockedHint"
            >
              <singleCheckbox
                id="reanalysis-option-beat-grid"
                v-model="selection.beatGrid"
                :disabled="beatGridLocked"
              >
                {{ t('tracks.reanalysisOptionBeatGrid') }}
              </singleCheckbox>
            </bubbleBoxTrigger>

            <!-- 网格参数只在勾选网格时展开，收起时不占布局高度。 -->
            <div
              class="track-reanalysis-dialog__grid-settings"
              :class="{ 'is-open': showBpmRange }"
              :inert="!showBpmRange"
            >
              <div class="track-reanalysis-dialog__grid-settings-inner">
                <div class="track-reanalysis-dialog__grid-settings-rows">
                  <div class="track-reanalysis-dialog__spread">
                    <span class="track-reanalysis-dialog__field-label">
                      {{ t('settings.analysisBpmRange.label') }}
                    </span>
                    <bubbleBoxTrigger
                      tag="div"
                      class="track-reanalysis-dialog__field-control"
                      :title="t('settings.analysisBpmRange.dialogHint')"
                    >
                      <BaseSelect
                        v-model="selectedBpmRangeId"
                        :options="bpmRangeOptions"
                        :disabled="!showBpmRange"
                        :show-bubble="false"
                        :width="132"
                        :max-height="280"
                      />
                    </bubbleBoxTrigger>
                  </div>
                  <div class="track-reanalysis-dialog__spread">
                    <span class="track-reanalysis-dialog__field-label">
                      {{ t('settings.analysisGridMode.label') }}
                    </span>
                    <bubbleBoxTrigger
                      tag="div"
                      class="track-reanalysis-dialog__field-control"
                      :title="gridModeHintText"
                    >
                      <BaseSelect
                        v-model="selectedGridMode"
                        :options="gridModeOptions"
                        :disabled="!showBpmRange"
                        :show-bubble="false"
                        :width="132"
                        :max-height="200"
                      />
                    </bubbleBoxTrigger>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <singleCheckbox id="reanalysis-option-waveform" v-model="selection.waveform">
            {{ t('tracks.reanalysisOptionWaveform') }}
          </singleCheckbox>
          <singleCheckbox id="reanalysis-option-energy" v-model="selection.energy">
            {{ t('tracks.reanalysisOptionEnergy') }}
          </singleCheckbox>
          <bubbleBoxTrigger
            tag="div"
            class="track-reanalysis-dialog__option-tip"
            :title="structureOptionHint"
          >
            <singleCheckbox id="reanalysis-option-structure" v-model="selection.structure">
              {{ t('tracks.reanalysisOptionStructure') }}
            </singleCheckbox>
          </bubbleBoxTrigger>
        </div>

        <div
          v-if="statusHint"
          class="track-reanalysis-dialog__hint"
          :class="{ 'track-reanalysis-dialog__hint--warning': statusHint.warning }"
        >
          {{ statusHint.text }}
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
        <div v-else class="button button--primary track-reanalysis-dialog__button" @click="confirm">
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
  width: 440px;
  height: auto;
  display: flex;
  flex-direction: column;
}

.track-reanalysis-dialog__content {
  display: flex;
  flex-direction: column;
  padding: 20px 28px 18px;
  color: var(--text);
}

.track-reanalysis-dialog__summary {
  margin-bottom: 18px;
  text-align: center;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary, #8c8c8c);
}

.track-reanalysis-dialog__options {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.track-reanalysis-dialog__option-tip {
  display: inline-flex;
  align-self: flex-start;
}

.track-reanalysis-dialog__grid-group {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

/* 0fr → 1fr 让折叠高度可动画，收起时占位真正为 0 */
.track-reanalysis-dialog__grid-settings {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows 0.18s ease,
    opacity 0.14s ease;
}

.track-reanalysis-dialog__grid-settings.is-open {
  grid-template-rows: 1fr;
  opacity: 1;
}

/* 缩进到复选框文字对齐的位置：参数挂在「网格 / BPM」下面，不额外套卡片 */
.track-reanalysis-dialog__grid-settings-inner {
  overflow: hidden;
  min-height: 0;
  padding: 10px 0 2px 26px;
}

.track-reanalysis-dialog__grid-settings-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.track-reanalysis-dialog__spread {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.track-reanalysis-dialog__field-label {
  color: var(--text-secondary, #8c8c8c);
  font-size: 12px;
  white-space: nowrap;
}

.track-reanalysis-dialog__field-control {
  display: inline-flex;
  flex-shrink: 0;
}

.track-reanalysis-dialog__hint {
  margin-top: 14px;
  color: var(--text-secondary, #8c8c8c);
  font-size: 12px;
  line-height: 1.6;
}

.track-reanalysis-dialog__hint--warning {
  color: var(--warning-text, #ffb74d);
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
