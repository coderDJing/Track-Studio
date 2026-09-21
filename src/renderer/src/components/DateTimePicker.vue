<template>
  <div class="dtp" :class="{ 'dtp--open': isOpen }">
    <div
      ref="triggerRef"
      class="dtp-trigger"
      role="combobox"
      :aria-expanded="isOpen"
      tabindex="0"
      @click="toggleOpen"
      @keydown="handleTriggerKeydown"
    >
      <div class="dtp-trigger__value" :class="{ 'is-placeholder': !hasCommittedValue }">
        {{ triggerDisplayValue }}
      </div>
      <div class="dtp-trigger__arrow" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </div>
    </div>
    <bubbleBox v-if="!isOpen" :dom="triggerRef || undefined" :title="triggerDisplayValue" />

    <Teleport to="body">
      <transition name="dtp-fade">
        <div v-if="isOpen" ref="panelRef" class="dtp-dropdown" :style="dropdownStyle" @click.stop>
          <div class="dtp-dropdown__head">
            <div class="dtp-draft" :class="{ 'is-placeholder': !hasSelection }">
              {{ draftDisplayValue }}
            </div>
            <div class="dtp-now" @click="setNow">{{ t('filters.dateTimeNow') }}</div>
          </div>

          <div class="dtp-nav">
            <div
              class="dtp-nav-btn"
              :class="{ 'is-disabled': !canShiftYear(-1) }"
              @click="shiftYear(-1)"
            >
              «
            </div>
            <div
              class="dtp-nav-btn"
              :class="{ 'is-disabled': !canShiftMonth(-1) }"
              @click="shiftMonth(-1)"
            >
              ‹
            </div>
            <div class="dtp-nav-title" @click="cycleViewMode">{{ yearMonthLabel }}</div>
            <div
              class="dtp-nav-btn"
              :class="{ 'is-disabled': !canShiftMonth(1) }"
              @click="shiftMonth(1)"
            >
              ›
            </div>
            <div
              class="dtp-nav-btn"
              :class="{ 'is-disabled': !canShiftYear(1) }"
              @click="shiftYear(1)"
            >
              »
            </div>
          </div>

          <div v-if="viewMode === 'day'" class="dtp-cal">
            <div v-for="weekday in 7" :key="`wd-${weekday}`" class="dtp-weekday">
              {{ t(`filters.dateTimeWeekdays.${weekday - 1}`) }}
            </div>
            <div
              v-for="(cell, index) in calendarCells"
              :key="`day-${index}`"
              class="dtp-day"
              :class="{
                'is-outside': cell.outside,
                'is-today': isToday(cell),
                'is-selected': isSelectedDay(cell)
              }"
              @click="selectDay(cell)"
            >
              {{ cell.day }}
            </div>
          </div>

          <div v-else-if="viewMode === 'month'" class="dtp-grid">
            <div
              v-for="month in 12"
              :key="`month-${month}`"
              class="dtp-grid-item"
              :class="{ 'is-selected': month === viewMonth }"
              @click="selectMonth(month)"
            >
              {{ t(`filters.dateTimeMonths.${month}`) }}
            </div>
          </div>

          <div v-else class="dtp-grid">
            <div
              v-for="year in yearPage"
              :key="`year-${year}`"
              class="dtp-grid-item"
              :class="{ 'is-selected': year === viewYear }"
              @click="selectYear(year)"
            >
              {{ year }}
            </div>
          </div>

          <div class="dtp-time">
            <div class="dtp-time-col">
              <div class="dtp-time-label">{{ t('filters.dateTimeHour') }}</div>
              <div ref="hourListRef" class="dtp-time-list" @wheel.stop>
                <div
                  v-for="item in hours"
                  :key="`h-${item}`"
                  class="dtp-time-item"
                  :class="{ 'is-selected': item === hour }"
                  @click="selectHour(item)"
                >
                  {{ pad2(item) }}
                </div>
              </div>
            </div>
            <div class="dtp-time-col">
              <div class="dtp-time-label">{{ t('filters.dateTimeMinute') }}</div>
              <div ref="minuteListRef" class="dtp-time-list" @wheel.stop>
                <div
                  v-for="item in minutes"
                  :key="`m-${item}`"
                  class="dtp-time-item"
                  :class="{ 'is-selected': item === minute }"
                  @click="selectMinute(item)"
                >
                  {{ pad2(item) }}
                </div>
              </div>
            </div>
            <div class="dtp-time-col">
              <div class="dtp-time-label">{{ t('filters.dateTimeSecond') }}</div>
              <div ref="secondListRef" class="dtp-time-list" @wheel.stop>
                <div
                  v-for="item in seconds"
                  :key="`s-${item}`"
                  class="dtp-time-item"
                  :class="{ 'is-selected': item === second }"
                  @click="selectSecond(item)"
                >
                  {{ pad2(item) }}
                </div>
              </div>
            </div>
          </div>
          <div class="dtp-dropdown__footer">
            <div class="dtp-action" @click.stop="confirmPanel">{{ t('common.confirm') }}</div>
            <div class="dtp-action" @click.stop="cancelPanel">{{ t('common.cancel') }}</div>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { i18n } from '@renderer/i18n'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import {
  formatFilterDateTime,
  parseFilterDateTime,
  type FilterDateTimeParts
} from '@shared/songAddedAt'
import {
  MAX_PICKER_YEAR,
  MIN_PICKER_YEAR,
  YEAR_PAGE_SIZE,
  buildCalendarCells,
  buildYearPage,
  scrollTimeListToValue,
  shiftYearMonth,
  type CalendarCell
} from './dateTimePickerCalendar'

type ViewMode = 'day' | 'month' | 'year'

const props = defineProps<{
  modelValue?: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
}>()

const hours = Array.from({ length: 24 }, (_, index) => index)
const minutes = Array.from({ length: 60 }, (_, index) => index)
const seconds = Array.from({ length: 60 }, (_, index) => index)

const isOpen = ref(false)
const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const dropdownStyle = ref<Record<string, string>>({})

const viewMode = ref<ViewMode>('day')
const viewYear = ref(new Date().getFullYear())
const viewMonth = ref(new Date().getMonth() + 1)
const selectedYear = ref<number | null>(null)
const selectedMonth = ref<number | null>(null)
const selectedDay = ref<number | null>(null)
const hour = ref(0)
const minute = ref(0)
const second = ref(0)

const hourListRef = ref<HTMLElement | null>(null)
const minuteListRef = ref<HTMLElement | null>(null)
const secondListRef = ref<HTMLElement | null>(null)

const hasSelection = computed(
  () => selectedYear.value !== null && selectedMonth.value !== null && selectedDay.value !== null
)

const selectedParts = computed(() => {
  if (selectedYear.value === null || selectedMonth.value === null || selectedDay.value === null) {
    return null
  }
  return {
    year: selectedYear.value,
    month: selectedMonth.value,
    day: selectedDay.value,
    hour: hour.value,
    minute: minute.value,
    second: second.value,
    hasTime: true
  }
})

const isZh = computed(() => String(i18n.global.locale.value).toLowerCase().startsWith('zh'))

const yearMonthLabel = computed(() => {
  const monthLabel = t(`filters.dateTimeMonths.${viewMonth.value}`)
  if (isZh.value) return `${viewYear.value}${t('filters.dateTimeYear')} ${monthLabel}`
  return `${monthLabel} ${viewYear.value}`
})

const hasCommittedValue = computed(() => Boolean(parseFilterDateTime(props.modelValue)))

const triggerDisplayValue = computed(() => {
  const parts = parseFilterDateTime(props.modelValue)
  if (!parts) return t('filters.datePlaceholder')
  return formatFilterDateTime(parts, parts.hasTime)
})

const draftDisplayValue = computed(() => {
  if (!selectedParts.value) return t('filters.datePlaceholder')
  return formatFilterDateTime(selectedParts.value)
})

const calendarCells = computed(() => buildCalendarCells(viewYear.value, viewMonth.value))
const yearPage = computed(() => buildYearPage(viewYear.value))

const canShiftMonth = (delta: number) => {
  if (viewMode.value === 'year') {
    const nextYear = viewYear.value + delta * YEAR_PAGE_SIZE
    return nextYear >= MIN_PICKER_YEAR && nextYear <= MAX_PICKER_YEAR
  }
  const next = shiftYearMonth(viewYear.value, viewMonth.value, delta)
  return next.year !== viewYear.value || next.month !== viewMonth.value
}

const canShiftYear = (delta: number) => {
  const step = viewMode.value === 'year' ? YEAR_PAGE_SIZE : 1
  const nextYear = viewYear.value + delta * step
  return nextYear >= MIN_PICKER_YEAR && nextYear <= MAX_PICKER_YEAR
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function nowParts(): FilterDateTimeParts {
  const now = new Date()
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds(),
    hasTime: true
  }
}

function applyParts(parts: FilterDateTimeParts) {
  viewYear.value = parts.year
  viewMonth.value = parts.month
  selectedYear.value = parts.year
  selectedMonth.value = parts.month
  selectedDay.value = parts.day
  hour.value = parts.hasTime ? parts.hour : 0
  minute.value = parts.hasTime ? parts.minute : 0
  second.value = parts.hasTime ? parts.second : 0
  viewMode.value = 'day'
}

// 空值打开时落在当天 00:00:00，作为面板当前停留的默认值；确定才写回，取消仍保持空
function applyFromModel(value: string | undefined) {
  const parts = parseFilterDateTime(value)
  if (!parts) {
    const now = nowParts()
    applyParts({
      year: now.year,
      month: now.month,
      day: now.day,
      hour: 0,
      minute: 0,
      second: 0,
      hasTime: true
    })
    return
  }
  applyParts(parts)
}

function emitCurrent() {
  if (!selectedParts.value) return
  emit('update:modelValue', formatFilterDateTime(selectedParts.value))
}

// 还没点过日期时，默认落到今天（时分秒沿用面板当前停留值）
function ensureSelectedDate() {
  if (hasSelection.value) return
  const now = nowParts()
  selectedYear.value = now.year
  selectedMonth.value = now.month
  selectedDay.value = now.day
  viewYear.value = now.year
  viewMonth.value = now.month
}

function isToday(cell: CalendarCell): boolean {
  const now = nowParts()
  return cell.year === now.year && cell.month === now.month && cell.day === now.day
}

function isSelectedDay(cell: CalendarCell): boolean {
  return (
    hasSelection.value &&
    cell.year === selectedYear.value &&
    cell.month === selectedMonth.value &&
    cell.day === selectedDay.value
  )
}

function selectDay(cell: CalendarCell) {
  selectedYear.value = cell.year
  selectedMonth.value = cell.month
  selectedDay.value = cell.day
  viewYear.value = cell.year
  viewMonth.value = cell.month
}

function selectMonth(month: number) {
  viewMonth.value = month
  viewMode.value = 'day'
}

function selectYear(year: number) {
  viewYear.value = year
  viewMode.value = 'month'
}

function selectHour(value: number) {
  ensureSelectedDate()
  hour.value = value
}

function selectMinute(value: number) {
  ensureSelectedDate()
  minute.value = value
}

function selectSecond(value: number) {
  ensureSelectedDate()
  second.value = value
}

function setNow() {
  applyParts(nowParts())
}

function shiftMonth(delta: number) {
  if (!canShiftMonth(delta)) return
  if (viewMode.value === 'year') {
    viewYear.value += delta * YEAR_PAGE_SIZE
    return
  }
  const next = shiftYearMonth(viewYear.value, viewMonth.value, delta)
  viewYear.value = next.year
  viewMonth.value = next.month
}

function shiftYear(delta: number) {
  if (!canShiftYear(delta)) return
  const step = viewMode.value === 'year' ? YEAR_PAGE_SIZE : 1
  viewYear.value += delta * step
}

function cycleViewMode() {
  if (viewMode.value === 'day') {
    viewMode.value = 'month'
    return
  }
  if (viewMode.value === 'month') {
    viewMode.value = 'year'
    return
  }
  viewMode.value = 'day'
}

function syncTimeScroll() {
  nextTick(() => {
    scrollTimeListToValue(hourListRef.value, hour.value)
    scrollTimeListToValue(minuteListRef.value, minute.value)
    scrollTimeListToValue(secondListRef.value, second.value)
  })
}

function updateDropdownPosition() {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const panel = panelRef.value
  const width = Math.max(rect.width, 360)
  const height = panel?.offsetHeight || 0
  const gap = 4
  const padding = 8
  let top = rect.bottom + gap
  let left = rect.left
  if (height > 0 && top + height > window.innerHeight - padding) {
    top = Math.max(padding, rect.top - gap - height)
  }
  if (left + width > window.innerWidth - padding) {
    left = Math.max(padding, window.innerWidth - padding - width)
  }
  dropdownStyle.value = {
    top: `${top}px`,
    left: `${left}px`,
    width: `${width}px`
  }
}

function openPanel() {
  if (isOpen.value) return
  applyFromModel(props.modelValue)
  isOpen.value = true
  viewMode.value = 'day'
}

function closePanel() {
  isOpen.value = false
}

function confirmPanel() {
  ensureSelectedDate()
  emitCurrent()
  closePanel()
}

function cancelPanel() {
  applyFromModel(props.modelValue)
  closePanel()
}

function toggleOpen() {
  if (isOpen.value) cancelPanel()
  else openPanel()
}

function handleTriggerKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === ' ') {
    event.preventDefault()
    openPanel()
  }
}

function handleDocumentClick(event: MouseEvent) {
  if (!isOpen.value) return
  const target = event.target as Node | null
  if (!target) return
  if (triggerRef.value?.contains(target) || panelRef.value?.contains(target)) return
  cancelPanel()
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (!isOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    cancelPanel()
    return
  }
  if (event.key === 'Enter' || event.key === 'e' || event.key === 'E') {
    event.preventDefault()
    event.stopImmediatePropagation()
    confirmPanel()
  }
}

watch(
  () => props.modelValue,
  (value) => {
    applyFromModel(value)
    if (isOpen.value) syncTimeScroll()
  },
  { immediate: true }
)

watch([hour, minute, second], () => {
  if (isOpen.value) syncTimeScroll()
})

watch(isOpen, (open) => {
  if (!open) return
  nextTick(() => {
    updateDropdownPosition()
    syncTimeScroll()
    requestAnimationFrame(updateDropdownPosition)
  })
})

watch(viewMode, () => {
  if (!isOpen.value) return
  nextTick(updateDropdownPosition)
})

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
  window.addEventListener('keydown', handleGlobalKeydown, true)
  window.addEventListener('resize', updateDropdownPosition)
  window.addEventListener('scroll', updateDropdownPosition, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  window.removeEventListener('keydown', handleGlobalKeydown, true)
  window.removeEventListener('resize', updateDropdownPosition)
  window.removeEventListener('scroll', updateDropdownPosition, true)
})
</script>

<style scoped lang="scss">
.dtp {
  position: relative;
  width: 100%;
  user-select: none;
}

.dtp-trigger {
  position: relative;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 30px 0 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg-elev);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;

  &:hover {
    border-color: var(--accent);
  }

  &:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
}

.dtp--open .dtp-trigger {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.dtp-trigger__value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.is-placeholder {
    color: var(--text-weak);
  }
}

.dtp-trigger__arrow {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: var(--text-weak);
  pointer-events: none;
  transition: transform 0.2s ease;

  svg {
    width: 100%;
    height: 100%;
  }
}

.dtp--open .dtp-trigger__arrow {
  transform: translateY(-50%) rotate(180deg);
}

.dtp-dropdown {
  position: fixed;
  z-index: var(--z-dialog-raised);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg-elev);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  box-sizing: border-box;
}

.dtp-dropdown__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dtp-draft {
  flex: 1;
  min-width: 0;
  height: 28px;
  line-height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 13px;
  box-sizing: border-box;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.is-placeholder {
    color: var(--text-weak);
  }
}

.dtp-now {
  height: 28px;
  line-height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 5px;
  cursor: pointer;
  font-size: 13px;
  box-sizing: border-box;

  &:hover {
    background: var(--hover);
    border-color: var(--accent);
  }
}

.dtp-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.dtp-nav-btn,
.dtp-nav-title {
  height: 28px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 5px;
  cursor: pointer;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover:not(.is-disabled) {
    background: var(--hover);
    border-color: var(--accent);
  }
}

.dtp-nav-btn {
  width: 28px;
  font-size: 14px;
  flex-shrink: 0;

  &.is-disabled {
    cursor: default;
    color: var(--text-weak);
    opacity: 0.45;
  }
}

.dtp-nav-title {
  flex: 1;
  font-size: 13px;
  padding: 0 8px;
}

.dtp-cal {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.dtp-weekday {
  height: 24px;
  line-height: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-weak);
}

.dtp-day {
  height: 28px;
  line-height: 28px;
  text-align: center;
  font-size: 13px;
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }

  &.is-outside {
    color: var(--text-weak);
    opacity: 0.55;
  }

  &.is-today:not(.is-selected) {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  &.is-selected {
    background: var(--accent);
    color: #ffffff;
    font-weight: 600;
    opacity: 1;
  }
}

.dtp-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  min-height: 196px;
}

.dtp-grid-item {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: var(--hover);
    border-color: var(--accent);
  }

  &.is-selected {
    color: var(--accent);
    font-weight: 600;
    border-color: var(--accent);
  }
}

.dtp-time {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}

.dtp-time-col {
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elev);
  overflow: hidden;
}

.dtp-time-label {
  height: 24px;
  line-height: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-weak);
  border-bottom: 1px solid var(--border);
}

.dtp-time-list {
  max-height: 140px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar) transparent;

  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--scrollbar);
    border-radius: 4px;
  }
}

.dtp-time-item {
  height: 28px;
  line-height: 28px;
  text-align: center;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }

  &.is-selected {
    color: var(--accent);
    font-weight: 600;
  }
}

.dtp-dropdown__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 2px;
}

.dtp-action {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  text-align: center;
  box-sizing: border-box;

  &:hover {
    color: #ffffff;
    background-color: var(--accent);
  }
}

.dtp-fade-enter-active,
.dtp-fade-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.dtp-fade-enter-from,
.dtp-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
