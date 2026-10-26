<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import {
  bpmFixSnapshot as snapshot,
  bpmFixDraft as draft,
  bpmFixErrorText,
  bpmFixFocusedId as focusedId,
  repairBpmFix
} from '@renderer/utils/bpmFixActions'
import type { BpmFixTrack } from '@shared/bpmFix'

const emit = defineEmits<{ close: []; minimize: [] }>()
const { dialogVisible, closeWithAnimation } = useDialogTransition(160)
const uuid = uuidV4()
const error = ref('')
const submitting = ref(false)
const cancelling = ref(false)
const applyFactor = ref<0.5 | 1 | 2>(1)
const applyTarget = ref<number | ''>('')
const busy = computed(
  () => snapshot.value?.status === 'analyzing' || snapshot.value?.status === 'repairing'
)
const editable = computed(() => snapshot.value?.status === 'ready' && !submitting.value)
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
        checked && ((track.analysis?.confidence || 0) >= 0.5 || settings.allowLowConfidence)
  }
}
const start = async () => {
  submitting.value = true
  error.value = ''
  try {
    await repairBpmFix()
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
  hotkeys('Esc', uuid, minimize)
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  hotkeys.unbind('Esc', uuid)
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner bpm-fix-dialog">
      <div class="dialog-title dialog-header">
        <span>{{ t('bpmFix.title') }}</span>
        <div class="header-actions">
          <button @click="minimize">{{ t('bpmFix.minimize') }}</button
          ><button @click="close">×</button>
        </div>
      </div>
      <div v-if="snapshot" class="bpm-body">
        <p class="hint">{{ t('bpmFix.intro') }}</p>
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
        <div v-if="editable" class="batch-tools">
          <button @click="selectReliable(true)">{{ t('bpmFix.selectAll') }}</button>
          <button @click="selectReliable(false)">{{ t('bpmFix.selectNone') }}</button>
          <select v-model="applyFactor" :aria-label="t('bpmFix.interpretation')">
            <option :value="0.5">½×</option>
            <option :value="1">1×</option>
            <option :value="2">2×</option>
          </select>
          <input
            v-model="applyTarget"
            type="number"
            min="30"
            max="300"
            step="0.01"
            :placeholder="t('bpmFix.auto')"
            :aria-label="t('bpmFix.target')"
          />
          <button @click="applyToSelection">{{ t('bpmFix.applySelection') }}</button>
        </div>
        <div class="track-table">
          <table>
            <thead>
              <tr>
                <th>{{ t('bpmFix.process') }}</th>
                <th>{{ t('bpmFix.song') }}</th>
                <th>{{ t('bpmFix.detected') }}</th>
                <th>{{ t('bpmFix.confidence') }}</th>
                <th>{{ t('bpmFix.interpretation') }}</th>
                <th>{{ t('bpmFix.target') }}</th>
                <th>{{ t('bpmFix.status') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="track in snapshot.tracks"
                :key="track.id"
                :class="{ focused: focused?.id === track.id }"
                @click="focusedId = track.id"
              >
                <td>
                  <input
                    v-if="draft.tracks[track.id]"
                    v-model="draft.tracks[track.id].enabled"
                    type="checkbox"
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
                <td>{{ number(track.analysis?.sourceBpm) }}</td>
                <td
                  :class="{
                    warning:
                      (track.analysis?.confidence || 0) < 0.5 || track.analysis?.tempoAmbiguous
                  }"
                >
                  {{ percent(track.analysis?.confidence) }}
                </td>
                <td>
                  <select
                    v-if="draft.tracks[track.id]"
                    v-model="draft.tracks[track.id].tempoFactor"
                    :disabled="!editable || track.status !== 'ready'"
                    :aria-label="t('bpmFix.interpretation')"
                  >
                    <option :value="0.5">½×</option>
                    <option :value="1">1×</option>
                    <option :value="2">2×</option>
                  </select>
                </td>
                <td>
                  <input
                    v-if="draft.tracks[track.id]"
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
                </td>
                <td>
                  <button
                    v-if="track.outputPath"
                    class="link"
                    @click.stop="reveal(track.outputPath)"
                  >
                    {{ t('bpmFix.trackCompleted') }}</button
                  ><span v-else>{{
                    t(`bpmFix.track${track.status[0].toUpperCase()}${track.status.slice(1)}`)
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <section v-if="focused" class="details">
          <strong>{{ fileName(focused.filePath) }}</strong>
          <p v-if="focused.error" class="error">{{ bpmFixErrorText(focused.error) }}</p>
          <template v-if="focused.analysis">
            <div class="metrics">
              <span
                >{{ t('bpmFix.reference') }}
                <b>{{ number(focused.analysis.referenceBpm) }}</b></span
              >
              <span
                >{{ t('bpmFix.agreement') }} <b>{{ percent(focused.analysis.agreement) }}</b></span
              >
              <span
                >{{ t('bpmFix.regularity') }}
                <b>{{ percent(focused.analysis.regularity) }}</b></span
              >
              <span
                >{{ t('bpmFix.drift') }} <b>{{ number(focused.analysis.driftMs, 1) }} ms</b></span
              >
              <span
                >{{ t('bpmFix.coverage') }} <b>{{ percent(focused.analysis.coverage) }}</b></span
              >
              <span>{{
                t('bpmFix.detections', {
                  filled: focused.analysis.filledBeats,
                  ignored: focused.analysis.ignoredDetections
                })
              }}</span>
            </div>
            <p class="hint">{{ t('bpmFix.confidenceHint') }}</p>
            <p v-if="focused.analysis.tempoAmbiguous" class="warning">
              {{ t('bpmFix.ambiguityHint') }}
            </p>
            <label
              v-if="focused.analysis.confidence < 0.5 && draft.tracks[focused.id]"
              class="warning"
              ><input
                v-model="draft.tracks[focused.id].allowLowConfidence"
                type="checkbox"
                :disabled="!editable"
                @change="
                  draft.tracks[focused.id].enabled = draft.tracks[focused.id].allowLowConfidence
                "
              />{{ t('bpmFix.allowLow') }}</label
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
                  error: number(focused.summary.verification.gridRmsMs),
                  bpm: number(focused.summary.verification.detectedBpm),
                  delta: number(focused.summary.verification.bpmError, 4),
                  offgrid: focused.summary.verification.offGridBeats
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
          <label
            >{{ t('bpmFix.saveMode')
            }}<select v-model="draft.saveMode" :disabled="!editable">
              <option value="copy">{{ t('bpmFix.saveCopy') }}</option>
              <option value="overwrite">{{ t('bpmFix.saveOverwrite') }}</option>
            </select></label
          >
          <label
            >{{ t('bpmFix.format')
            }}<select v-model="draft.format" :disabled="!editable">
              <option value="wav">WAV · 24-bit</option>
              <option value="original">{{ t('bpmFix.keepFormat') }}</option>
            </select></label
          >
        </div>
        <p class="hint">
          {{ draft.saveMode === 'overwrite' ? t('bpmFix.overwriteHint') : t('bpmFix.copyHint') }}
          {{ draft.format === 'original' ? t('bpmFix.lossyHint') : '' }}
        </p>
        <p v-if="error || snapshot.error" class="error" role="alert">
          {{ error || bpmFixErrorText(snapshot.error) }}
        </p>
        <div class="bpm-footer">
          <span>{{ t('bpmFix.selected', { count: selected }) }}</span>
          <button @click="minimize">{{ t('bpmFix.minimize') }}</button>
          <button v-if="busy" :disabled="cancelling" @click="cancel">
            {{ t(cancelling ? 'bpmFix.cancelling' : 'bpmFix.cancel') }}
          </button>
          <button
            v-if="editable"
            class="primary"
            :disabled="!selected || submitting"
            @click="start"
          >
            {{ t('bpmFix.start') }}
          </button>
          <button v-if="!busy" @click="close">{{ t('bpmFix.close') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.bpm-fix-dialog {
  --bpm-fix-warning: #dba143;
  --bpm-fix-error: #ef8585;
  width: min(1060px, 95vw);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  color: var(--text);
  background: var(--bg);
}
:global(.theme-light) .bpm-fix-dialog {
  --bpm-fix-warning: #916004;
  --bpm-fix-error: #b32b2b;
}
.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header-actions {
  display: flex;
  gap: 8px;
}
.bpm-body {
  overflow: auto;
  padding: 16px 20px;
  font-size: 13px;
}
.hint {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.task-status,
.batch-tools,
.bpm-footer,
.save-options {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
  flex-wrap: wrap;
}
.task-status {
  justify-content: space-between;
}
.bpm-progress {
  height: 5px;
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
  max-height: 290px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 5px;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
th {
  position: sticky;
  top: 0;
  background: var(--bg-elev);
  z-index: 1;
  text-align: left;
  color: var(--text-secondary);
}
th,
td {
  padding: 9px 7px;
  border-bottom: 1px solid var(--border);
}
th:first-child {
  width: 42px;
}
th:nth-child(2) {
  width: 28%;
}
th:nth-child(5) {
  width: 66px;
}
th:nth-child(6) {
  width: 88px;
}
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
  width: 76px;
}
select,
input[type='number'],
button {
  background: var(--bg-elev);
  color: var(--text);
  border: 1px solid var(--border);
  padding: 5px 7px;
  border-radius: 4px;
}
button,
select,
input[type='checkbox'] {
  cursor: pointer;
}
button:disabled,
input:disabled,
select:disabled {
  opacity: 0.5;
  cursor: default;
}
button.primary {
  background: var(--accent);
  color: white;
}
button.link {
  color: var(--accent);
}
.details {
  margin: 14px 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elev);
}
.metrics {
  display: flex;
  gap: 8px 20px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.warning {
  color: var(--bpm-fix-warning);
}
.error {
  color: var(--bpm-fix-error);
}
.save-options label {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bpm-footer > span {
  margin-right: auto;
}
</style>
