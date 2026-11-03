<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useRuntimeStore } from '@renderer/stores/runtime'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import { resolveSongHotCueLabel } from '@shared/hotCues'
import {
  formatCueOverlapTime,
  isCueBoundarySlot,
  type CueBoundary,
  type MixtapeCueOverlapSettings,
  type MixtapeCueOverlapPlan
} from '@renderer/composables/mixtape/mixtapeCueOverlap'

const props = defineProps<{
  initialBpm: number
  buildPlan: (settings: MixtapeCueOverlapSettings) => MixtapeCueOverlapPlan
  confirm: (settings: MixtapeCueOverlapSettings) => Promise<void>
}>()
const emit = defineEmits<{ close: [] }>()
const runtime = useRuntimeStore()
const scope = uuidV4()
const dialogRef = ref<HTMLElement | null>(null)
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const startCue = ref<CueBoundary>(0),
  endCue = ref<CueBoundary>(1)
const bpm = ref(props.initialBpm)
const busy = ref(false),
  error = ref('')
// 与 SET 时长共用已选槽位；只有用户确认后才保存本次选择。
try {
  const saved: unknown = JSON.parse(
    localStorage.getItem('frkb_set_duration_cue_slots_v1') || 'null'
  )
  if (Array.isArray(saved) && saved.length === 2) {
    if (saved[0] === 'start' || isCueBoundarySlot(saved[0])) startCue.value = saved[0]
    if (saved[1] === 'end' || isCueBoundarySlot(saved[1])) endCue.value = saved[1]
    if (typeof startCue.value === 'number' && startCue.value === endCue.value) endCue.value = 'end'
  }
} catch {}
const settings = computed(() => ({
  startCue: startCue.value,
  endCue: endCue.value,
  bpm: Number(bpm.value)
}))
const plan = computed(() => props.buildPlan(settings.value))
const startOptions = computed(() => [
  { label: t('playlist.setDurationTrackStart'), value: 'start' },
  ...Array.from({ length: 8 }, (_, value) => ({
    label: resolveSongHotCueLabel(value),
    value,
    disabled: endCue.value === value
  }))
])
const endOptions = computed(() => [
  ...Array.from({ length: 8 }, (_, value) => ({
    label: resolveSongHotCueLabel(value),
    value,
    disabled: startCue.value === value
  })),
  { label: t('playlist.setDurationTrackEnd'), value: 'end' }
])
const cancel = () => {
  if (!busy.value) closeWithAnimation(() => emit('close'))
}
const apply = async () => {
  if (busy.value || !plan.value.valid) return
  busy.value = true
  error.value = ''
  try {
    await props.confirm(settings.value)
    try {
      localStorage.setItem(
        'frkb_set_duration_cue_slots_v1',
        JSON.stringify([startCue.value, endCue.value])
      )
    } catch {}
    closeWithAnimation(() => emit('close'))
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    error.value = t(
      message.includes('MISSING_FILE')
        ? 'mixtape.cueOverlapMissingFile'
        : message.includes('CHANGED')
          ? 'mixtape.cueOverlapChanged'
          : 'mixtape.cueOverlapFailed'
    )
    busy.value = false
  }
}
watch(settings, () => {
  error.value = ''
})
onMounted(() => {
  dialogRef.value?.focus({ preventScroll: true })
  runtime.confirmShow = true
  hotkeys('Esc', scope, cancel)
  utils.setHotkeysScpoe(scope)
})
onUnmounted(() => {
  runtime.confirmShow = false
  utils.delHotkeysScope(scope)
})
</script>

<template>
  <div
    ref="dialogRef"
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    :aria-label="t('mixtape.cueOverlapTitle')"
    @keydown.esc.stop.prevent="cancel"
    @keydown.stop
  >
    <div v-dialog-drag="'.dialog-title'" class="inner cue-overlap-dialog">
      <div class="dialog-title dialog-header">
        <span>{{ t('mixtape.cueOverlapTitle') }}</span>
      </div>
      <div class="cue-overlap-dialog__content">
        <p class="cue-overlap-dialog__hint">{{ t('mixtape.cueOverlapHint') }}</p>
        <div class="cue-overlap-dialog__settings">
          <label
            ><span>{{ t('playlist.setDurationStartCue') }}</span>
            <BaseSelect
              v-model="startCue"
              :options="startOptions"
              :width="110"
              :disabled="busy"
              :show-bubble="false"
            />
          </label>
          <label
            ><span>{{ t('playlist.setDurationEndCue') }}</span>
            <BaseSelect
              v-model="endCue"
              :options="endOptions"
              :width="110"
              :disabled="busy"
              :show-bubble="false"
            />
          </label>
          <label
            ><span>{{ t('mixtape.cueOverlapBpm') }}</span>
            <input
              v-model="bpm"
              type="number"
              min="1.01"
              max="999"
              step="0.01"
              :disabled="busy"
              :aria-label="t('mixtape.cueOverlapBpm')"
            />
          </label>
        </div>
        <p class="cue-overlap-dialog__notice">{{ t('mixtape.cueOverlapTempoNotice') }}</p>
        <div class="cue-overlap-dialog__summary">
          <strong>{{
            t('mixtape.cueOverlapDuration', {
              duration: formatCueOverlapTime(plan.snapshot.bpmEnvelopeDurationSec)
            })
          }}</strong>
          <span>{{ t('playlist.setDurationTrackCount', { count: plan.rows.length }) }}</span>
          <span v-if="plan.missingStartCount">{{
            t('playlist.setDurationStartFallback', { count: plan.missingStartCount })
          }}</span>
          <span v-if="plan.missingEndCount">{{
            t('playlist.setDurationEndFallback', { count: plan.missingEndCount })
          }}</span>
        </div>
        <div class="cue-overlap-dialog__table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{{ t('mixtape.cueOverlapTrack') }}</th>
                <th>{{ t('mixtape.cueOverlapPosition') }}</th>
                <th>{{ t('playlist.setDurationStartCue') }}</th>
                <th>{{ t('playlist.setDurationEndCue') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, index) in plan.rows"
                :key="row.id"
                :class="{ 'has-error': row.error }"
              >
                <td>{{ index + 1 }}</td>
                <td>
                  <bubbleBoxTrigger
                    tag="span"
                    :title="row.title"
                    class="cue-overlap-dialog__track"
                    >{{ row.title }}</bubbleBoxTrigger
                  >
                  <span v-if="row.error" class="cue-overlap-dialog__error">{{
                    t(`mixtape.cueOverlapError_${row.error}`)
                  }}</span>
                </td>
                <td>{{ formatCueOverlapTime(row.startSec) }}</td>
                <td>{{ formatCueOverlapTime(row.inSec) }}</td>
                <td>{{ formatCueOverlapTime(row.outSec) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-if="!plan.valid && !plan.rows.some((row) => row.error)"
          class="cue-overlap-dialog__error"
        >
          {{ t('mixtape.cueOverlapInvalid') }}
        </p>
        <p v-if="error" role="alert" class="cue-overlap-dialog__error">{{ error }}</p>
      </div>
      <div class="dialog-footer">
        <button class="button" :disabled="busy" @click="cancel">
          {{ t('common.cancel') }} (Esc)
        </button>
        <button class="button" :disabled="busy || !plan.valid" @click="apply">
          {{ t(busy ? 'mixtape.cueOverlapApplying' : 'mixtape.cueOverlapApply') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.cue-overlap-dialog {
  width: min(820px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  color: var(--text);
}
.cue-overlap-dialog__content {
  padding: 18px 24px;
  overflow: auto;
  min-height: 0;
}
.cue-overlap-dialog__hint {
  margin: 0 0 18px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.cue-overlap-dialog__settings {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
}
.cue-overlap-dialog__settings label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cue-overlap-dialog__settings input {
  width: 82px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-elev);
  color: var(--text);
}
.cue-overlap-dialog__notice {
  margin: 16px 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.cue-overlap-dialog__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin-bottom: 14px;
  font-size: 12px;
}
.cue-overlap-dialog__table-wrap {
  max-height: 270px;
  overflow: auto;
  border: 1px solid var(--border);
}
table {
  color: var(--text);
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  table-layout: fixed;
}
th,
td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
th {
  position: sticky;
  top: 0;
  background: var(--bg-elev);
  z-index: 1;
}
th:first-child {
  width: 28px;
}
th:nth-child(2) {
  width: 43%;
}
.cue-overlap-dialog__track {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cue-overlap-dialog__error {
  display: block;
  margin: 5px 0 0;
  color: var(--danger-text);
  line-height: 1.5;
}
.has-error {
  background: color-mix(in srgb, var(--danger-text) 7%, var(--bg));
}
.dialog-footer {
  gap: 12px;
}
.dialog-footer button {
  min-width: 100px;
  font: inherit;
  color: var(--text);
  border: 1px solid var(--border);
  background: var(--hover);
  appearance: none;
  cursor: pointer;
}
.dialog-footer button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
