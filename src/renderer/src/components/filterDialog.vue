<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import DateTimePicker from '@renderer/components/DateTimePicker.vue'
import { normalizeFilterDate, resolveFilterDateBounds } from '@shared/songAddedAt'

type CompareOp = 'eq' | 'gte' | 'lte'
type Op = CompareOp | 'between'

const props = defineProps<{
  type: 'text' | 'duration' | 'bpm' | 'number' | 'date'
  initText?: string
  initExcludeText?: string
  initOp?: Op
  initDuration?: string
  initDurationTo?: string
  initNumber?: string
  initNumberTo?: string
  initDate?: string
  initDateTo?: string
  numberTitle?: string
  numberPlaceholder?: string
  showCuratedOnly?: boolean
  initCuratedOnly?: boolean
}>()

const emits = defineEmits<{
  (
    e: 'confirm',
    payload:
      | { type: 'text'; text: string; excludeText: string; curatedOnly: boolean }
      | { type: 'duration'; op: Op; duration: string; durationTo?: string }
      | { type: 'bpm' | 'number'; op: Op; value: string; valueTo?: string }
      | { type: 'date'; op: Op; date: string; dateTo?: string }
  ): void
  (e: 'cancel'): void
  (e: 'clear'): void
}>()

const uuid = uuidV4()

const text = ref(props.initText || '')
const excludeText = ref(props.initExcludeText || '')
const op = ref<Op>(props.initOp || 'gte')
const duration = ref(props.initDuration || (props.initOp === 'between' ? '' : '00:00'))
const durationTo = ref(props.initDurationTo || '')
const numberValue = ref(props.initNumber || '')
const numberValueTo = ref(props.initNumberTo || '')
const dateValue = ref(props.initDate || '')
const dateValueTo = ref(props.initDateTo || '')
const curatedOnly = ref(props.initCuratedOnly || false)

watch(
  () => [
    props.initText,
    props.initExcludeText,
    props.initOp,
    props.initDuration,
    props.initDurationTo,
    props.initNumber,
    props.initNumberTo,
    props.initDate,
    props.initDateTo,
    props.initCuratedOnly,
    props.type
  ],
  () => {
    text.value = props.initText || ''
    excludeText.value = props.initExcludeText || ''
    op.value = props.initOp || 'gte'
    duration.value = props.initDuration || (props.initOp === 'between' ? '' : '00:00')
    durationTo.value = props.initDurationTo || ''
    numberValue.value = props.initNumber || ''
    numberValueTo.value = props.initNumberTo || ''
    dateValue.value = props.initDate || ''
    dateValueTo.value = props.initDateTo || ''
    curatedOnly.value = props.initCuratedOnly || false
  }
)

function normalizeMmSs(input: string): string {
  if (!input) return '00:00'
  const parts = String(input).split(':')
  let m = 0
  let s = 0
  if (parts.length >= 1) m = Number((parts[0] || '').replace(/\D/g, '')) || 0
  if (parts.length >= 2) s = Number((parts[1] || '').replace(/\D/g, '')) || 0
  if (s > 59) s = 59
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return `${mm}:${ss}`
}

function normalizeNumberInput(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return ''
  const cleaned = raw.replace(/[^0-9.]/g, '')
  if (!cleaned) return ''
  const parts = cleaned.split('.')
  return parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : parts[0]
}

const { dialogVisible, closeWithAnimation } = useDialogTransition()

function durationToSeconds(mmss: string): number {
  const normalized = normalizeMmSs(mmss)
  const parts = normalized.split(':')
  return Number(parts[0]) * 60 + Number(parts[1])
}

function orderDurationRange(
  fromValue: string,
  toValue: string
): { from: string; to: string } | undefined {
  if (!String(toValue || '').trim()) return undefined
  const from = normalizeMmSs(fromValue)
  const to = normalizeMmSs(toValue)
  if (durationToSeconds(from) <= durationToSeconds(to)) return { from, to }
  return { from: to, to: from }
}

function orderNumberRange(
  fromValue: string,
  toValue: string
): { from: string; to: string } | undefined {
  const from = normalizeNumberInput(fromValue)
  const to = normalizeNumberInput(toValue)
  if (!from || !to) return undefined
  if (Number(from) <= Number(to)) return { from, to }
  return { from: to, to: from }
}

function resolveDurationBounds(fromValue: string, toValue: string): { from: string; to: string } {
  const from = String(fromValue || '').trim() ? normalizeMmSs(fromValue) : ''
  const to = String(toValue || '').trim() ? normalizeMmSs(toValue) : ''
  if (from && to) {
    const ordered = orderDurationRange(from, to)
    return ordered || { from, to }
  }
  return { from, to }
}

function resolveNumberBounds(fromValue: string, toValue: string): { from: string; to: string } {
  const from = normalizeNumberInput(fromValue)
  const to = normalizeNumberInput(toValue)
  if (from && to) {
    const ordered = orderNumberRange(from, to)
    return ordered || { from, to }
  }
  return { from, to }
}

const handleConfirm = () => {
  const dateBounds =
    props.type === 'date' && op.value === 'between'
      ? resolveFilterDateBounds(dateValue.value, dateValueTo.value)
      : undefined
  const durationBounds =
    props.type === 'duration' && op.value === 'between'
      ? resolveDurationBounds(duration.value, durationTo.value)
      : undefined
  const numberBounds =
    (props.type === 'bpm' || props.type === 'number') && op.value === 'between'
      ? resolveNumberBounds(numberValue.value, numberValueTo.value)
      : undefined
  const payload =
    props.type === 'text'
      ? ({
          type: 'text',
          text: text.value.trim(),
          excludeText: excludeText.value.trim(),
          curatedOnly: curatedOnly.value
        } as const)
      : props.type === 'duration'
        ? op.value === 'between'
          ? ({
              type: 'duration',
              op: 'between',
              duration: durationBounds?.from || '',
              durationTo: durationBounds?.to || ''
            } as const)
          : ({
              type: 'duration',
              op: op.value,
              duration: normalizeMmSs(duration.value),
              durationTo: ''
            } as const)
        : props.type === 'date'
          ? op.value === 'between'
            ? ({
                type: 'date',
                op: 'between',
                date: dateBounds?.from || '',
                dateTo: dateBounds?.to || ''
              } as const)
            : ({
                type: 'date',
                op: op.value,
                date: normalizeFilterDate(dateValue.value) || '',
                dateTo: ''
              } as const)
          : op.value === 'between'
            ? ({
                type: props.type,
                op: 'between',
                value: numberBounds?.from || '',
                valueTo: numberBounds?.to || ''
              } as const)
            : ({
                type: props.type,
                op: op.value,
                value: normalizeNumberInput(numberValue.value),
                valueTo: ''
              } as const)
  closeWithAnimation(() => emits('confirm', payload))
}
const handleCancel = () => closeWithAnimation(() => emits('cancel'))
const handleClear = () => closeWithAnimation(() => emits('clear'))

onMounted(() => {
  // 切换热键作用域，防止与全局热键干扰
  utils.setHotkeysScpoe(uuid)
  hotkeys('E,Enter', uuid, () => {
    handleConfirm()
    return false
  })
  hotkeys('Q', uuid, () => {
    handleClear()
    return false
  })
  hotkeys('Esc', uuid, () => {
    handleCancel()
    return false
  })
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    style="font-size: 14px; color: var(--text)"
  >
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner"
      :style="{
        width: '420px',
        minHeight: op === 'between' ? '340px' : '240px',
        display: 'flex',
        flexDirection: 'column'
      }"
    >
      <div class="dialog-title dialog-header">
        <span>
          {{
            props.type === 'text'
              ? t('filters.filterByText')
              : props.type === 'duration'
                ? t('filters.filterByDuration')
                : props.type === 'bpm'
                  ? t('filters.filterByBpm')
                  : props.type === 'date'
                    ? t('filters.filterByDate')
                    : props.numberTitle || t('filters.filterByNumber')
          }}
        </span>
      </div>
      <div style="padding: 10px 20px; flex: 1; overflow-y: auto">
        <template v-if="props.type === 'text'">
          <div class="filter-field">
            <div class="filter-label">{{ t('filters.includeKeyword') }}</div>
            <input
              v-model="text"
              class="filter-input"
              type="text"
              :placeholder="t('filters.keywordPlaceholder')"
              style="width: 100%"
              @keydown.enter.prevent.stop="handleConfirm"
            />
          </div>
          <div class="filter-field" style="margin-top: 10px">
            <div class="filter-label">{{ t('filters.excludeKeyword') }}</div>
            <input
              v-model="excludeText"
              class="filter-input"
              type="text"
              :placeholder="t('filters.excludeKeywordPlaceholder')"
              style="width: 100%"
              @keydown.enter.prevent.stop="handleConfirm"
            />
          </div>
          <div
            v-if="showCuratedOnly"
            style="margin-top: 10px; display: inline-flex; align-items: center; gap: 4px"
          >
            <singleCheckbox id="filter-checkbox-curatedOnly" v-model="curatedOnly" />
            <label class="checkbox-text" for="filter-checkbox-curatedOnly">{{
              t('filters.onlyCuratedArtists')
            }}</label>
          </div>
        </template>
        <template v-else-if="props.type === 'duration'">
          <div class="radio-group">
            <label class="radio"
              ><input v-model="op" type="radio" value="gte" /><span class="dot"></span
              >{{ t('filters.greaterOrEqual') }}</label
            >
            <label class="radio"
              ><input v-model="op" type="radio" value="lte" /><span class="dot"></span
              >{{ t('filters.lessOrEqual') }}</label
            >
            <label class="radio"
              ><input v-model="op" type="radio" value="eq" /><span class="dot"></span
              >{{ t('filters.equals') }}</label
            >
            <label class="radio"
              ><input v-model="op" type="radio" value="between" /><span class="dot"></span
              >{{ t('filters.between') }}</label
            >
          </div>
          <div v-if="op === 'between'" class="filter-range">
            <div class="filter-field">
              <div class="filter-label">{{ t('filters.rangeFrom') }}</div>
              <input
                v-model="duration"
                class="filter-input"
                type="text"
                :placeholder="t('filters.durationPlaceholder')"
                @blur="duration = duration.trim() ? normalizeMmSs(duration) : ''"
                @keydown.enter.prevent.stop="handleConfirm"
              />
            </div>
            <div class="filter-field">
              <div class="filter-label">{{ t('filters.rangeTo') }}</div>
              <input
                v-model="durationTo"
                class="filter-input"
                type="text"
                :placeholder="t('filters.durationPlaceholder')"
                @blur="durationTo = durationTo.trim() ? normalizeMmSs(durationTo) : ''"
                @keydown.enter.prevent.stop="handleConfirm"
              />
            </div>
          </div>
          <template v-else>
            <input
              v-model="duration"
              class="filter-input"
              type="text"
              :placeholder="t('filters.durationPlaceholder')"
              style="width: 100%"
              @blur="duration = normalizeMmSs(duration)"
              @keydown.enter.prevent.stop="handleConfirm"
            />
            <div style="margin-top: 8px; display: flex; gap: 8px">
              <div class="tag" @click="duration = '01:30'">01:30</div>
              <div class="tag" @click="duration = '03:00'">03:00</div>
              <div class="tag" @click="duration = '05:00'">05:00</div>
            </div>
          </template>
        </template>
        <template v-else-if="props.type === 'date'">
          <div class="radio-group">
            <label class="radio"
              ><input v-model="op" type="radio" value="gte" /><span class="dot"></span
              >{{ t('filters.greaterOrEqual') }}</label
            >
            <label class="radio"
              ><input v-model="op" type="radio" value="lte" /><span class="dot"></span
              >{{ t('filters.lessOrEqual') }}</label
            >
            <label class="radio"
              ><input v-model="op" type="radio" value="eq" /><span class="dot"></span
              >{{ t('filters.equals') }}</label
            >
            <label class="radio"
              ><input v-model="op" type="radio" value="between" /><span class="dot"></span
              >{{ t('filters.between') }}</label
            >
          </div>
          <div v-if="op === 'between'" class="filter-range">
            <div class="filter-field">
              <div class="filter-label">{{ t('filters.rangeFrom') }}</div>
              <DateTimePicker v-model="dateValue" />
            </div>
            <div class="filter-field">
              <div class="filter-label">{{ t('filters.rangeTo') }}</div>
              <DateTimePicker v-model="dateValueTo" />
            </div>
          </div>
          <DateTimePicker v-else v-model="dateValue" />
        </template>
        <template v-else>
          <div class="radio-group">
            <label class="radio"
              ><input v-model="op" type="radio" value="gte" /><span class="dot"></span
              >{{ t('filters.greaterOrEqual') }}</label
            >
            <label class="radio"
              ><input v-model="op" type="radio" value="lte" /><span class="dot"></span
              >{{ t('filters.lessOrEqual') }}</label
            >
            <label class="radio"
              ><input v-model="op" type="radio" value="eq" /><span class="dot"></span
              >{{ t('filters.equals') }}</label
            >
            <label class="radio"
              ><input v-model="op" type="radio" value="between" /><span class="dot"></span
              >{{ t('filters.between') }}</label
            >
          </div>
          <div v-if="op === 'between'" class="filter-range">
            <div class="filter-field">
              <div class="filter-label">{{ t('filters.rangeFrom') }}</div>
              <input
                v-model="numberValue"
                class="filter-input"
                type="text"
                inputmode="decimal"
                :placeholder="props.numberPlaceholder || t('filters.numberPlaceholder')"
                @blur="numberValue = normalizeNumberInput(numberValue)"
                @keydown.enter.prevent.stop="handleConfirm"
              />
            </div>
            <div class="filter-field">
              <div class="filter-label">{{ t('filters.rangeTo') }}</div>
              <input
                v-model="numberValueTo"
                class="filter-input"
                type="text"
                inputmode="decimal"
                :placeholder="props.numberPlaceholder || t('filters.numberPlaceholder')"
                @blur="numberValueTo = normalizeNumberInput(numberValueTo)"
                @keydown.enter.prevent.stop="handleConfirm"
              />
            </div>
          </div>
          <input
            v-else
            v-model="numberValue"
            class="filter-input"
            type="text"
            inputmode="decimal"
            :placeholder="props.numberPlaceholder || t('filters.numberPlaceholder')"
            style="width: 100%"
            @blur="numberValue = normalizeNumberInput(numberValue)"
            @keydown.enter.prevent.stop="handleConfirm"
          />
        </template>
      </div>
      <div class="dialog-footer" style="padding: 10px 20px 18px; gap: 10px">
        <div class="button" style="width: 90px; text-align: center" @click="handleConfirm">
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 120px; text-align: center" @click="handleClear">
          {{ t('filters.clearThisColumn') }} (Q)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="handleCancel">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.filter-input {
  height: 28px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  padding: 0 8px;
  box-sizing: border-box; /* 防止 width:100% 加上边框后溢出，保证左右视觉边距一致 */
  outline: none;

  &::placeholder {
    color: var(--text-weak);
  }
  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
}

.filter-field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  .filter-input {
    width: 100%;
  }
}
.filter-label {
  font-size: 12px;
  color: var(--text-weak);
}
.filter-range {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.checkbox-text {
  font-size: 13px;
  color: var(--text);
  user-select: none;
}
.radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  margin-bottom: 10px;
  color: var(--text);
}
.radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.radio input[type='radio'] {
  /* 隐藏原生单选 */
  appearance: none;
  -webkit-appearance: none;
  width: 0;
  height: 0;
  position: absolute;
}
.radio .dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--border); /* 外圈边框保留 */
  background: transparent; /* 外圈无填充色 */
  position: relative;
  transition: all 0.15s ease;
}
.radio .dot::after {
  content: '';
  position: absolute;
  inset: 4px; /* 内圈更小 */
  border-radius: 50%;
  background: var(--accent); /* 内圈蓝色 */
  opacity: 0;
  transition: opacity 0.12s ease;
}
.radio input[type='radio']:checked + .dot::after {
  opacity: 1; /* 勾选时显示蓝色内圈 */
}
.radio:hover .dot {
  border-color: var(--text-weak);
  background: rgba(0, 0, 0, 0.02);
}
.tag {
  height: 24px;
  line-height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }
}
.button {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  font-size: 14px;
  user-select: none;
  cursor: pointer;
  &:hover {
    color: #ffffff;
    background-color: var(--accent);
  }
}
.dangerButton {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  font-size: 14px;
  user-select: none;
  cursor: pointer;
  &:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}
</style>
