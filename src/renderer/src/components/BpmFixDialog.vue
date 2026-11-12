<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import {
  bpmFixSnapshot as snapshot,
  bpmFixDraft as draft,
  bpmFixErrorText,
  bpmFixFocusedId as focusedId,
  bpmFixAdvanced as advanced,
  analyzeBpmFix,
  repairBpmFix
} from '@renderer/utils/bpmFixActions'
import type { BpmFixTrack } from '@shared/bpmFix'

const emit = defineEmits<{ close: []; minimize: [] }>()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const uuid = uuidV4()
const error = ref('')
const submitting = ref(false)
const cancelling = ref(false)
const applyFactor = ref<0.5 | 1 | 2>(1)
const applyTarget = ref<number | ''>('')
const tempoOptions = [
  { label: '½×', value: 0.5 },
  { label: '1×', value: 1 },
  { label: '2×', value: 2 }
]
const saveModeOptions = computed(() => [
  { label: t('bpmFix.saveCopy'), value: 'copy' },
  { label: t('bpmFix.saveOverwrite'), value: 'overwrite' }
])
const formatOptions = computed(() => [
  { label: 'WAV · 24-bit', value: 'wav' },
  { label: t('bpmFix.keepFormat'), value: 'original' }
])
const scrollbarOptions = {
  scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
  overflow: { x: 'hidden', y: 'scroll' } as const
}
const tableScrollbarOptions = {
  ...scrollbarOptions,
  overflow: { x: 'scroll', y: 'scroll' } as const
}
const busy = computed(
  () => snapshot.value?.status === 'analyzing' || snapshot.value?.status === 'repairing'
)
const editable = computed(() => snapshot.value?.status === 'ready' && !submitting.value)
const canConfigure = computed(
  () => ['pending', 'ready'].includes(snapshot.value?.status || '') && !submitting.value
)
const canMinimize = computed(() => busy.value || snapshot.value?.status === 'ready')
const focused = computed(
  () =>
    snapshot.value?.tracks.find((track) => track.id === focusedId.value) ||
    snapshot.value?.tracks.find((track) => track.analysis)
)
const selected = computed(() => Object.values(draft.tracks).filter((track) => track.enabled).length)
const complete = computed(
  () => snapshot.value?.tracks.filter((track) => track.status === 'completed').length || 0
)
const failed = computed(
  () => snapshot.value?.tracks.filter((track) => track.status === 'failed').length || 0
)
const fileName = (path: string) => path.split(/[\\/]/).pop() || path
const number = (value: number | undefined, digits = 2) =>
  value === undefined ? '—' : value.toFixed(digits)
const percent = (value: number | undefined) =>
  value === undefined ? '—' : `${Math.round(value * 100)}%`
const target = (track: BpmFixTrack) => {
  const settings = draft.tracks[track.id]
  return (
    settings?.targetBpm ??
    Math.round((track.analysis?.sourceBpm || 0) * (settings?.tempoFactor || 1))
  )
}
const setTarget = (id: string, event: Event) => {
  const value = (event.target as HTMLInputElement).value
  draft.tracks[id].targetBpm = value === '' ? null : Number(value)
}
const applyToSelection = () => {
  for (const settings of Object.values(draft.tracks))
    if (settings.enabled) {
      settings.tempoFactor = applyFactor.value
      settings.targetBpm = applyTarget.value === '' ? null : Number(applyTarget.value)
    }
}
const selectReliable = (checked: boolean) => {
  for (const track of snapshot.value?.tracks || []) {
    const settings = draft.tracks[track.id]
    if (settings && track.status === 'ready')
      settings.enabled =
        checked &&
        (((track.analysis?.confidence || 0) >= 0.5 && !track.analysis?.tempoAmbiguous) ||
          settings.allowLowConfidence)
  }
}
const start = async () => {
  submitting.value = true
  error.value = ''
  try {
    if (snapshot.value?.status === 'pending') await analyzeBpmFix(!advanced.value)
    else await repairBpmFix()
  } catch (err) {
    error.value = bpmFixErrorText(err)
  } finally {
    submitting.value = false
  }
}
const cancel = async () => {
  cancelling.value = true
  try {
    await window.electron.ipcRenderer.invoke('audio:bpm-fix:cancel', snapshot.value?.id)
  } catch (err) {
    error.value = bpmFixErrorText(err)
    cancelling.value = false
  }
}
const close = () => closeWithAnimation(() => (busy.value ? emit('minimize') : emit('close')))
const minimize = () => closeWithAnimation(() => emit('minimize'))
const reveal = (path: string) => window.electron.ipcRenderer.send('show-item-in-folder', path)
onMounted(() => {
  hotkeys('Esc', uuid, () => (canMinimize.value ? minimize() : close()))
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  hotkeys.unbind('Esc', uuid)
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner bpm-fix-dialog"
      :class="{ 'bpm-fix-dialog--advanced': advanced }"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t('bpmFix.title') }}</span>
      </div>
      <OverlayScrollbarsComponent
        v-if="snapshot"
        class="bpm-body-scroll"
        :options="scrollbarOptions"
        element="div"
      >
        <div class="bpm-body">
          <div class="task-card">
            <div class="task-status" role="status">
              <strong>{{ t(`bpmFix.${snapshot.stage}`) }}</strong>
              <span v-if="busy"
                >{{ snapshot.current }} / {{ snapshot.tracks.length }} ·
                {{
                  t('bpmFix.currentProgress', { percent: Math.floor(snapshot.currentPercent || 0) })
                }}</span
              >
              <span v-else>{{
                t('bpmFix.counts', { complete, failed, total: snapshot.tracks.length })
              }}</span>
            </div>
            <div v-if="busy" class="bpm-progress">
              <div :style="{ width: `${snapshot.percent}%` }" />
            </div>
          </div>
          <div v-if="snapshot.status === 'pending'" class="analysis-options">
            <p v-if="!advanced" class="hint">{{ t('bpmFix.automaticHint') }}</p>
            <singleCheckbox v-model="advanced" :disabled="submitting">
              {{ t('bpmFix.advanced') }}
            </singleCheckbox>
          </div>
          <div v-if="editable" class="batch-tools">
            <button class="button" @click="selectReliable(true)">
              {{ t('bpmFix.selectAll') }}
            </button>
            <button class="button" @click="selectReliable(false)">
              {{ t('bpmFix.selectNone') }}
            </button>
            <div class="batch-field">
              <span>{{ t('bpmFix.interpretation') }}</span>
              <BaseSelect
                v-model="applyFactor"
                :options="tempoOptions"
                :width="72"
                :aria-label="t('bpmFix.interpretation')"
              />
            </div>
            <label class="batch-field">
              <span>{{ t('bpmFix.target') }}</span>
              <input
                v-model="applyTarget"
                type="number"
                min="30"
                max="300"
                step="0.01"
                :placeholder="t('bpmFix.auto')"
                :aria-label="t('bpmFix.target')"
              />
            </label>
            <button class="button" @click="applyToSelection">
              {{ t('bpmFix.applySelection') }}
            </button>
            <span class="selection-count">{{ t('bpmFix.selected', { count: selected }) }}</span>
          </div>
          <OverlayScrollbarsComponent
            class="track-table"
            :options="tableScrollbarOptions"
            element="div"
          >
            <table :class="{ 'advanced-table': advanced }">
              <thead>
                <tr>
                  <th v-if="advanced" class="selection-column">{{ t('bpmFix.process') }}</th>
                  <th class="song-column">{{ t('bpmFix.song') }}</th>
                  <th class="number-column">{{ t('bpmFix.detected') }}</th>
                  <th v-if="advanced" class="confidence-column">{{ t('bpmFix.confidence') }}</th>
                  <th v-if="advanced" class="tempo-column">{{ t('bpmFix.interpretation') }}</th>
                  <th class="target-column">{{ t('bpmFix.target') }}</th>
                  <th class="status-column">{{ t('bpmFix.status') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="track in snapshot.tracks"
                  :key="track.id"
                  :class="{ focused: focused?.id === track.id }"
                  @click="focusedId = track.id"
                >
                  <td v-if="advanced">
                    <singleCheckbox
                      v-if="draft.tracks[track.id]"
                      v-model="draft.tracks[track.id].enabled"
                      :disabled="
                        !editable ||
                        track.status !== 'ready' ||
                        ((track.analysis?.confidence || 0) < 0.5 &&
                          !draft.tracks[track.id].allowLowConfidence)
                      "
                      :aria-label="t('bpmFix.process')"
                      @click.stop
                    />
                  </td>
                  <td class="song-cell">
                    <bubbleBoxTrigger :title="track.filePath"
                      ><span>{{ fileName(track.filePath) }}</span></bubbleBoxTrigger
                    >
                  </td>
                  <td class="number-cell">{{ number(track.analysis?.sourceBpm) }}</td>
                  <td
                    v-if="advanced"
                    class="number-cell"
                    :class="{
                      warning:
                        track.analysis &&
                        (track.analysis.confidence < 0.5 || track.analysis.tempoAmbiguous)
                    }"
                  >
                    {{ percent(track.analysis?.confidence) }}
                  </td>
                  <td v-if="advanced" class="tempo-cell">
                    <BaseSelect
                      v-if="draft.tracks[track.id]"
                      v-model="draft.tracks[track.id].tempoFactor"
                      :options="tempoOptions"
                      :width="76"
                      :disabled="!editable || track.status !== 'ready'"
                      :aria-label="t('bpmFix.interpretation')"
                    />
                  </td>
                  <td class="number-cell">
                    <input
                      v-if="advanced && draft.tracks[track.id]"
                      :value="draft.tracks[track.id].targetBpm ?? ''"
                      type="number"
                      min="30"
                      max="300"
                      step="0.01"
                      :placeholder="String(target(track))"
                      :disabled="!editable || track.status !== 'ready'"
                      :aria-label="t('bpmFix.target')"
                      @input="setTarget(track.id, $event)"
                    />
                    <span v-else>{{
                      track.summary?.targetBpm ?? (track.analysis ? target(track) : '—')
                    }}</span>
                  </td>
                  <td>
                    <button
                      v-if="track.outputPath"
                      class="link"
                      @click.stop="reveal(track.outputPath)"
                    >
                      {{ t('bpmFix.trackCompleted') }}</button
                    ><span v-else>{{
                      t(
                        track.status === 'ready' && !advanced
                          ? 'bpmFix.trackQueued'
                          : `bpmFix.track${track.status[0].toUpperCase()}${track.status.slice(1)}`
                      )
                    }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </OverlayScrollbarsComponent>
          <section
            v-if="focused && ((advanced && focused.analysis) || focused.summary || focused.error)"
            class="details"
          >
            <strong>{{ fileName(focused.filePath) }}</strong>
            <p v-if="focused.error" class="error">{{ bpmFixErrorText(focused.error) }}</p>
            <template v-if="advanced && focused.analysis">
              <div class="metrics">
                <span
                  >{{ t('bpmFix.drift') }} <b>{{ number(focused.analysis.driftMs, 1) }} ms</b></span
                >
              </div>
              <p class="hint">
                {{
                  t('bpmFix.analysisEvidence', {
                    coverage: percent(focused.analysis.coverage),
                    agreement: percent(
                      focused.analysis.phaseAlignedAgreement ?? focused.analysis.agreement
                    ),
                    reference: number(focused.analysis.referenceBpm)
                  })
                }}
              </p>
              <p v-if="Math.abs(focused.analysis.referencePhaseShiftMs || 0) > 70" class="hint">
                {{ t('bpmFix.phaseDifferenceHint') }}
              </p>
              <p v-if="focused.analysis.confidence < 0.5" class="warning">
                {{ t('bpmFix.lowConfidenceHint') }}
              </p>
              <p v-if="focused.analysis.tempoAmbiguous" class="warning">
                {{ t('bpmFix.ambiguityHint') }}
              </p>
              <singleCheckbox
                v-if="focused.analysis.confidence < 0.5 && draft.tracks[focused.id]"
                v-model="draft.tracks[focused.id].allowLowConfidence"
                :disabled="!editable"
                class="warning"
                @change="
                  draft.tracks[focused.id].enabled = draft.tracks[focused.id].allowLowConfidence
                "
                >{{ t('bpmFix.allowLow') }}</singleCheckbox
              >
            </template>
            <template v-if="focused.summary">
              <p>
                {{
                  t('bpmFix.result', {
                    source: number(focused.summary.sourceBpm),
                    target: focused.summary.targetBpm
                  })
                }}
                ·
                {{
                  t('bpmFix.verified', {
                    bpm: number(focused.summary.verification.detectedBpm)
                  })
                }}
              </p>
              <p v-if="focused.summary.verification.offGridBeats" class="warning">
                {{
                  t('bpmFix.localBeatWarning', {
                    count: focused.summary.verification.offGridBeats
                  })
                }}
              </p>
              <p v-if="focused.summary.noticeableSegments" class="warning">
                {{ t('bpmFix.stretchWarning', { count: focused.summary.noticeableSegments }) }}
              </p>
              <p v-if="focused.summary.peakGain < 1" class="hint">{{ t('bpmFix.peakAdjusted') }}</p>
            </template>
          </section>
          <div class="save-options">
            <div class="save-option">
              <span>{{ t('bpmFix.saveMode') }}</span>
              <BaseSelect
                v-model="draft.saveMode"
                :options="saveModeOptions"
                width="100%"
                :disabled="!canConfigure"
                :aria-label="t('bpmFix.saveMode')"
              />
            </div>
            <div class="save-option">
              <span>{{ t('bpmFix.format') }}</span>
              <BaseSelect
                v-model="draft.format"
                :options="formatOptions"
                width="100%"
                :disabled="!canConfigure"
                :aria-label="t('bpmFix.format')"
              />
            </div>
          </div>
          <p v-if="draft.saveMode === 'overwrite' || draft.format === 'original'" class="hint">
            {{ draft.saveMode === 'overwrite' ? t('bpmFix.overwriteHint') : '' }}
            {{ draft.format === 'original' ? t('bpmFix.lossyHint') : '' }}
          </p>
          <p v-if="error || snapshot.error" class="error" role="alert">
            {{ error || bpmFixErrorText(snapshot.error) }}
          </p>
        </div>
      </OverlayScrollbarsComponent>
      <div v-if="snapshot" class="dialog-footer bpm-footer">
        <button
          v-if="snapshot.status === 'pending' || snapshot.status === 'ready'"
          class="button button-primary"
          :disabled="(snapshot.status === 'ready' && !selected) || submitting"
          @click="start"
        >
          {{
            t(snapshot.status === 'pending' && advanced ? 'bpmFix.startAnalysis' : 'bpmFix.start')
          }}
        </button>
        <button v-if="busy" class="button" :disabled="cancelling" @click="cancel">
          {{ t(cancelling ? 'bpmFix.cancelling' : 'bpmFix.cancel') }}
        </button>
        <button v-if="canMinimize" class="button" @click="minimize">
          {{ t('bpmFix.minimize') }} (Esc)
        </button>
        <button v-if="!busy" class="button" :disabled="submitting" @click="close">
          {{ t('bpmFix.close') }}{{ canMinimize ? '' : ' (Esc)' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.bpm-fix-dialog {
  --bpm-fix-warning: var(--warning-text);
  --bpm-fix-error: var(--danger-text);
  width: min(860px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  color: var(--text);
  background: var(--bg-elev);
  overflow: hidden;
  font-size: 13px;
  line-height: 1.5;
}
.bpm-fix-dialog--advanced {
  width: min(1060px, calc(100vw - 32px));
}
.dialog-header {
  min-height: 40px;
  padding: 0 20px;
}
.bpm-body-scroll {
  flex: 1 1 auto;
  min-height: 0;
}
.bpm-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
}
.bpm-body p {
  margin: 0;
}
.analysis-options {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.hint {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.batch-tools {
  display: flex;
  align-items: center;
  gap: 10px 12px;
  flex-wrap: wrap;
}
.task-card {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
.task-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--text-secondary);
}
.task-status strong {
  color: var(--text);
}
.selection-count {
  margin-left: auto;
  color: var(--text-secondary);
}
.bpm-fix-dialog :deep(.base-select) {
  box-sizing: border-box;
}
.bpm-progress {
  height: 5px;
  margin-top: 8px;
  background: var(--bg-elev);
  border-radius: 4px;
  overflow: hidden;
}
.bpm-progress > div {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.track-table {
  flex: none;
  max-height: 290px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}
table {
  width: 100%;
  min-width: 800px;
  border-collapse: collapse;
  table-layout: fixed;
  font: inherit;
  color: var(--text);
}
th {
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 1;
  text-align: left;
  color: var(--text-secondary);
}
th,
td {
  height: 40px;
  box-sizing: border-box;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
tbody tr:last-child td {
  border-bottom: 0;
}
th.selection-column {
  width: 56px;
  text-align: center;
}
th.song-column {
  width: auto;
}
th.number-column {
  width: 116px;
  text-align: center;
}
th.confidence-column {
  width: 112px;
  text-align: center;
}
th.tempo-column {
  width: 104px;
  text-align: center;
}
th.target-column {
  width: 108px;
  text-align: center;
}
th.status-column {
  width: 132px;
}
.number-cell,
.tempo-cell,
.advanced-table td:first-child {
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.tempo-cell :deep(.base-select) {
  margin-inline: auto;
}
table:not(.advanced-table) {
  min-width: 600px;
}
tbody tr {
  cursor: pointer;
}
tbody tr:hover,
tr.focused {
  background: var(--hover);
}
.song-cell span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
input[type='number'] {
  box-sizing: border-box;
  width: 76px;
  height: 28px;
  background: var(--bg-elev);
  color: var(--text);
  border: 1px solid var(--border);
  padding: 0 7px;
  border-radius: 5px;
  font: inherit;
}
.batch-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
}
input[type='number']:hover:not(:disabled) {
  border-color: var(--accent);
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
input:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}
button {
  cursor: pointer;
}
button:disabled,
input:disabled {
  opacity: 0.5;
  cursor: default;
}
.button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  font: inherit;
  white-space: nowrap;
}
.button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
  border-color: var(--text-secondary);
}
.button-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.button-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 85%, var(--text));
  border-color: var(--accent);
  color: #fff;
}
.button:disabled {
  background: var(--hover);
  color: var(--text);
}
button.link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
}
.details {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  overflow-wrap: anywhere;
}
.metrics {
  display: flex;
  gap: 8px 20px;
  flex-wrap: wrap;
}
.warning {
  color: var(--bpm-fix-warning);
}
.error {
  color: var(--bpm-fix-error);
}
.save-options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.save-option {
  display: grid;
  grid-template-columns: auto minmax(0, 180px);
  gap: 10px;
  align-items: center;
  min-width: 0;
}
.save-option > span {
  white-space: nowrap;
}
.save-option :deep(.base-select) {
  height: 30px;
}
.bpm-footer {
  padding: 12px 20px;
  gap: 8px;
}
@media (max-width: 560px) {
  .bpm-body {
    padding: 16px 12px;
  }
  .selection-count {
    margin-left: 0;
  }
  .save-options {
    align-items: stretch;
    flex-direction: column;
    gap: 12px;
  }
  .save-option {
    grid-template-columns: minmax(80px, auto) minmax(0, 1fr);
  }
  .bpm-footer {
    padding: 12px;
  }
}
.bpm-footer .button {
  min-width: 96px;
  height: 32px;
  text-align: center;
  white-space: nowrap;
}
</style>
