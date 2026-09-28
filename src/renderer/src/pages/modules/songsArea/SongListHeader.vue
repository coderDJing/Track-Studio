<script setup lang="ts">
import { ref, computed, PropType, watch, onMounted } from 'vue'
import { ISongsAreaColumn } from '../../../../../types/globals' // Corrected path
import filterIconAsset from '@renderer/assets/filterIcon.svg?asset'
import { UseDraggableOptions, vDraggable } from 'vue-draggable-plus'
import { MIN_WIDTH_BY_KEY } from './minWidth'
import filterDialog from '@renderer/components/filterDialog.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { normalizeFilterDate, resolveFilterDateBounds } from '@shared/songAddedAt'
const filterIcon = filterIconAsset
const filterIconMaskStyle = {
  '--icon-mask': `url("${filterIcon}")`
}

// 类型定义
type VDraggableBinding = [list: ISongsAreaColumn[], options?: UseDraggableOptions<ISongsAreaColumn>]
type FilterDialogType = 'text' | 'duration' | 'bpm' | 'number' | 'date'
type FilterOp = 'eq' | 'gte' | 'lte' | 'between'
type FilterDialogPayload =
  | { type: 'text'; text: string; excludeText: string; curatedOnly: boolean }
  | { type: 'duration'; op: FilterOp; duration: string; durationTo?: string }
  | { type: 'bpm' | 'number'; op: FilterOp; value: string; valueTo?: string }
  | { type: 'date'; op: FilterOp; date: string; dateTo?: string }

// Props
const props = defineProps({
  columns: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  },
  t: {
    type: Function as PropType<(key: string) => string>,
    required: true
  },
  ascendingOrder: {
    type: String,
    required: true
  },
  descendingOrder: {
    type: String,
    required: true
  },
  totalWidth: {
    type: Number,
    required: true
  },
  showIndexAction: {
    type: Boolean,
    default: false
  },
  indexActionTitle: {
    type: String,
    default: ''
  },
  indexActionDisabled: {
    type: Boolean,
    default: false
  }
})

// Emits
const emit = defineEmits<{
  (e: 'update:columns', value: ISongsAreaColumn[]): void
  (e: 'column-click', column: ISongsAreaColumn): void
  (e: 'header-contextmenu', event: MouseEvent): void
  (e: 'drag-start'): void
  (e: 'drag-end'): void
  (e: 'columns-preview', value: ISongsAreaColumn[] | null): void
  (e: 'index-action-click'): void
}>()

// 创建一个 ref 来存储可见的、可拖拽的列
const draggableVisibleColumns = ref<ISongsAreaColumn[]>([])
const draggableInstanceKey = ref(0) // 新增：用于强制重新渲染 draggable 容器的 key
const indexActionButtonRef = ref<HTMLElement | null>(null)
const setIndexActionButtonRef = (el: Element | null) => {
  indexActionButtonRef.value = (el as HTMLElement | null) || null
}

// 监听 props.columns 的变化，以更新 draggableVisibleColumns
watch(
  () => props.columns,
  (newFullColumns) => {
    draggableVisibleColumns.value = newFullColumns.filter((item) => item.show)
    draggableInstanceKey.value++ // 关键：当可见列数据源可能改变实例时，更新 key
  },
  { immediate: true, deep: true } // immediate 确保初始加载，deep 监听 show 属性等变化
)

// CSS 变量工具：将列宽与总宽写入同一滚动宿主，拖动中仅写 CSS 变量，结束再持久化
const headerRoot = ref<HTMLElement | null>(null)
function getHostEl(): HTMLElement | null {
  const root = headerRoot.value
  if (!root) return null
  const host = root.closest('.os-host') as HTMLElement | null
  return host || root.parentElement || document.body
}
function setColVar(key: string, px: number) {
  const host = getHostEl()
  if (!host) return
  host.style.setProperty(`--songs-col-${key}`, `${px}px`)
}
function setTotalVar(px: number) {
  const host = getHostEl()
  if (!host) return
  host.style.setProperty(`--songs-total-width`, `${px}px`)
}
function syncCssVarsFromColumns() {
  const visible = props.columns.filter((c) => c.show)
  let total = 0
  for (const c of visible) {
    const w = Math.max(MIN_WIDTH_BY_KEY[c.key] ?? 50, c.width)
    setColVar(c.key, w)
    total += w
  }
  setTotalVar(total)
}

// 列宽调整逻辑
let startX = 0
let resizingColInternal: ISongsAreaColumn | null = null // 使用 internal 后缀避免与 props 中的命名冲突
let isResizing = false
let initWidth = 0
let initTotalWidth = 0
const isResizeClick = ref(false) // 用于防止调整大小时触发单击
let rafId = 0
let lastFrameWidth = -1

const startResize = (e: MouseEvent, col: ISongsAreaColumn) => {
  // 封面列禁止调整宽度
  if (col.key === 'cover') return
  e.stopPropagation()
  e.preventDefault()
  isResizing = true
  isResizeClick.value = true
  startX = e.clientX
  resizingColInternal = col
  initWidth = col.width
  // 初始总宽
  initTotalWidth = props.columns.filter((c) => c.show).reduce((sum, c) => sum + (c.width || 0), 0)
  document.addEventListener('mousemove', resize)
  document.addEventListener('mouseup', stopResize)
}

const resize = (e: MouseEvent) => {
  e.stopPropagation()
  e.preventDefault()
  if (!isResizing || !resizingColInternal) return
  const deltaX = e.clientX - startX
  const minWidth = MIN_WIDTH_BY_KEY[resizingColInternal.key] ?? 50
  const newWidth = Math.max(minWidth, initWidth + deltaX) // 约束最小宽度

  // 拖动中：仅更新 CSS 变量，不改动响应式数据
  if (newWidth !== lastFrameWidth) {
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => {
      setColVar(resizingColInternal!.key, newWidth)
      const total = initTotalWidth + (newWidth - initWidth)
      setTotalVar(total)
      lastFrameWidth = newWidth
    })
  }
}

const stopResize = (e: MouseEvent) => {
  e.stopPropagation()
  e.preventDefault()
  if (!isResizing) return
  isResizing = false
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)

  // 在调整大小结束后，发出 columns 更新事件
  // 使用 [...props.columns] 创建一个新数组的浅拷贝以触发父组件的响应性
  if (resizingColInternal) {
    const finalWidth = lastFrameWidth > 0 ? lastFrameWidth : initWidth
    const minWidth = MIN_WIDTH_BY_KEY[resizingColInternal.key] ?? 50
    const safeWidth = Math.max(minWidth, finalWidth)
    const updated = props.columns.map((c) =>
      c.key === resizingColInternal!.key ? { ...c, width: safeWidth } : c
    )
    emit('update:columns', updated)
    // 同步一次 CSS 变量，避免父级回写前闪动
    syncCssVarsFromColumns()
  } else {
    emit('update:columns', [...props.columns])
  }

  setTimeout(() => {
    isResizeClick.value = false
  }, 0)
}

// 拖拽逻辑
// 表头 DOM 由 Sortable 在拖动中直接换位；歌曲行不读这份 DOM。
// 这里只按当前插入位置发出临时列序，松手后的 onUpdate 才提交并落盘。
type HeaderDragEvent = {
  oldDraggableIndex?: number
  newDraggableIndex?: number
}
let dragOriginKeys: string[] = []
let dragOriginIndex = -1
let lastPreviewSignature = ''

const emitColumnPreview = (keys: string[]) => {
  const signature = keys.join('\0')
  if (signature === lastPreviewSignature) return
  lastPreviewSignature = signature
  const byKey = new Map(draggableVisibleColumns.value.map((col) => [col.key, col]))
  const preview: ISongsAreaColumn[] = []
  for (const key of keys) {
    const col = byKey.get(key)
    if (!col) return
    preview.push(col)
  }
  emit('columns-preview', preview)
}

const resetColumnPreview = () => {
  dragOriginKeys = []
  dragOriginIndex = -1
  lastPreviewSignature = ''
  emit('columns-preview', null)
}

const onStartDraggable = (evt: HeaderDragEvent) => {
  dragOriginKeys = draggableVisibleColumns.value.map((col) => col.key)
  dragOriginIndex = evt.oldDraggableIndex ?? 0
  lastPreviewSignature = dragOriginKeys.join('\0')
  emit('drag-start')
}

const onChangeDraggable = (evt: HeaderDragEvent) => {
  const nextIndex = evt.newDraggableIndex
  if (nextIndex == null || nextIndex < 0 || dragOriginIndex < 0 || !dragOriginKeys.length) return
  const keys = dragOriginKeys.slice()
  const [moved] = keys.splice(dragOriginIndex, 1)
  if (!moved) return
  keys.splice(Math.min(nextIndex, keys.length), 0, moved)
  emitColumnPreview(keys)
}

const onEndDraggable = () => {
  // v-draggable 的 onUpdate 会在顺序改变后调用，那里会 emit('update:columns')
  // onEnd 只清掉拖动中的临时列序
  resetColumnPreview()
  emit('drag-end')
}

// v-draggable 的数据和选项
// vue-draggable-plus 会直接修改传入的 list (即 draggableVisibleColumns.value)
const vDraggableData = computed<VDraggableBinding>(() => [
  draggableVisibleColumns.value, // 将 draggableVisibleColumns.value 直接传递给 v-draggable
  {
    animation: 150,
    easing: 'ease',
    direction: 'horizontal',
    onUpdate: () => {
      // 当列顺序通过拖拽更新后 (draggableVisibleColumns.value 已被修改)
      // 我们需要根据 draggableVisibleColumns.value (新的可见列顺序)
      // 和 props.columns (原始完整列表，用于获取隐藏列)
      // 来重建完整的列顺序
      const newOrderedVisibleColumns = draggableVisibleColumns.value
      const reconstructedFullList: ISongsAreaColumn[] = []
      let currentVisibleIdx = 0

      for (const originalCol of props.columns) {
        if (originalCol.show) {
          // 这个 "槽位" 在原始结构中是给可见列的
          // 用 newOrderedVisibleColumns 中的下一个列来填充它
          if (currentVisibleIdx < newOrderedVisibleColumns.length) {
            reconstructedFullList.push(newOrderedVisibleColumns[currentVisibleIdx])
            currentVisibleIdx++
          } else {
          }
        } else {
          // 这个 "槽位" 是给隐藏列的，保留它
          reconstructedFullList.push(originalCol)
        }
      }
      emit('update:columns', reconstructedFullList)
    },
    onStart: onStartDraggable,
    onChange: onChangeDraggable,
    onEnd: onEndDraggable
  }
])
onMounted(() => {
  syncCssVarsFromColumns()
})
watch(
  () => props.columns,
  () => {
    // 列变化（顺序/显示/宽度）时，同步 CSS 变量
    syncCssVarsFromColumns()
  },
  { deep: true }
)

// 处理列头点击事件（用于排序）
const handleColumnClick = (col: ISongsAreaColumn) => {
  if (isResizeClick.value) {
    return // 如果正在调整大小（或刚刚调整完），则不触发点击
  }
  emit('column-click', col)
}

// 弹窗状态与临时输入
const filterActiveKey = ref<string>('')
const tempText = ref<string>('')
const tempExcludeText = ref<string>('')
const tempOp = ref<FilterOp>('gte')
const tempDuration = ref<string>('00:00')
const tempDurationTo = ref<string>('')
const tempNumber = ref<string>('')
const tempNumberTo = ref<string>('')
const tempDate = ref<string>('')
const tempDateTo = ref<string>('')
const tempCuratedOnly = ref<boolean>(false)

// 打开筛选弹窗
function handleFilterIconClick(e: MouseEvent, col: ISongsAreaColumn) {
  e.stopPropagation() // 不触发排序
  filterActiveKey.value = col.key
  if (col.filterType === 'text') {
    tempText.value = col.filterValue || ''
    tempExcludeText.value = col.filterExcludeValue || ''
    tempCuratedOnly.value = col.filterCuratedOnly || false
  } else if (col.filterType === 'duration') {
    tempOp.value = col.filterOp || 'gte'
    tempDuration.value = col.filterDuration || (col.filterOp === 'between' ? '' : '00:00')
    tempDurationTo.value = col.filterDurationTo || ''
  } else if (col.filterType === 'bpm' || col.filterType === 'number') {
    tempOp.value = col.filterOp || 'gte'
    tempNumber.value = col.filterNumber || ''
    tempNumberTo.value = col.filterNumberTo || ''
  } else if (col.filterType === 'date') {
    tempOp.value = col.filterOp || 'gte'
    tempDate.value = col.filterDate || ''
    tempDateTo.value = col.filterDateTo || ''
  }
}

function closeFilterDialog() {
  filterActiveKey.value = ''
}

// 规范 MM:SS（仅保留数字与冒号，自动补零）
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

function parseDurationToSecondsLocal(mmss: string): number {
  const parts = mmss.split(':')
  if (parts.length !== 2) return NaN
  const minutes = Number(parts[0])
  const seconds = Number(parts[1])
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return NaN
  return minutes * 60 + seconds
}

function normalizeNumberInput(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return ''
  const cleaned = raw.replace(/[^0-9.]/g, '')
  if (!cleaned) return ''
  const parts = cleaned.split('.')
  return parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : parts[0]
}

function parseExcludeKeywords(input: string): string[] {
  if (!input) return []
  return String(input)
    .split(/[,\n;\r，；、|]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
}

function applyFilterConfirm(target: ISongsAreaColumn) {
  const newColumns = props.columns.map((c) => {
    if (c.key !== target.key) return c
    const next = { ...c }
    if (c.filterType === 'text') {
      const includeText = tempText.value.trim()
      const excludeText = tempExcludeText.value.trim()
      const excludeKeywords = parseExcludeKeywords(excludeText)
      next.filterValue = includeText || undefined
      next.filterExcludeValue = excludeKeywords.length > 0 ? excludeText : undefined
      next.filterCuratedOnly = tempCuratedOnly.value || undefined
      next.filterActive = !!includeText || excludeKeywords.length > 0 || tempCuratedOnly.value
      next.filterOp = undefined
      next.filterDuration = undefined
      next.filterNumber = undefined
      next.filterDate = undefined
      next.filterDateTo = undefined
      next.filterDurationTo = undefined
      next.filterNumberTo = undefined
    } else if (c.filterType === 'duration') {
      next.filterOp = tempOp.value
      if (tempOp.value === 'between') {
        const from = tempDuration.value.trim() ? normalizeMmSs(tempDuration.value) : ''
        const to = tempDurationTo.value.trim() ? normalizeMmSs(tempDurationTo.value) : ''
        if (from && to) {
          const fromSec = parseDurationToSecondsLocal(from)
          const toSec = parseDurationToSecondsLocal(to)
          next.filterDuration = fromSec <= toSec ? from : to
          next.filterDurationTo = fromSec <= toSec ? to : from
        } else {
          next.filterDuration = from || undefined
          next.filterDurationTo = to || undefined
        }
        next.filterActive = Boolean(from || to)
      } else {
        next.filterDuration = normalizeMmSs(tempDuration.value)
        next.filterDurationTo = undefined
        next.filterActive = !!next.filterDuration
      }
      next.filterValue = undefined
      next.filterExcludeValue = undefined
      next.filterNumber = undefined
      next.filterNumberTo = undefined
      next.filterDate = undefined
      next.filterDateTo = undefined
    } else if (c.filterType === 'bpm' || c.filterType === 'number') {
      next.filterOp = tempOp.value
      if (tempOp.value === 'between') {
        const from = normalizeNumberInput(tempNumber.value)
        const to = normalizeNumberInput(tempNumberTo.value)
        if (from && to) {
          next.filterNumber = Number(from) <= Number(to) ? from : to
          next.filterNumberTo = Number(from) <= Number(to) ? to : from
        } else {
          next.filterNumber = from || undefined
          next.filterNumberTo = to || undefined
        }
        next.filterActive = Boolean(from || to)
      } else {
        next.filterNumber = normalizeNumberInput(tempNumber.value)
        next.filterNumberTo = undefined
        next.filterActive = !!next.filterNumber
      }
      next.filterValue = undefined
      next.filterDuration = undefined
      next.filterDurationTo = undefined
      next.filterExcludeValue = undefined
      next.filterDate = undefined
      next.filterDateTo = undefined
    } else if (c.filterType === 'date') {
      next.filterOp = tempOp.value
      if (tempOp.value === 'between') {
        const bounds = resolveFilterDateBounds(tempDate.value, tempDateTo.value)
        next.filterDate = bounds.from
        next.filterDateTo = bounds.to
        next.filterActive = Boolean(bounds.from || bounds.to)
      } else {
        next.filterDate = normalizeFilterDate(tempDate.value)
        next.filterDateTo = undefined
        next.filterActive = !!next.filterDate
      }
      next.filterValue = undefined
      next.filterDuration = undefined
      next.filterDurationTo = undefined
      next.filterExcludeValue = undefined
      next.filterNumber = undefined
      next.filterNumberTo = undefined
    }
    return next
  })
  emit('update:columns', newColumns)
  closeFilterDialog()
}

function clearFilter(target: ISongsAreaColumn) {
  const newColumns = props.columns.map((c) => {
    if (c.key !== target.key) return c
    return {
      ...c,
      filterActive: false,
      filterValue: undefined,
      filterExcludeValue: undefined,
      filterCuratedOnly: undefined,
      filterOp: undefined,
      filterDuration: undefined,
      filterDurationTo: undefined,
      filterNumber: undefined,
      filterNumberTo: undefined,
      filterDate: undefined,
      filterDateTo: undefined
    }
  })
  emit('update:columns', newColumns)
  closeFilterDialog()
}

function formatBetweenTooltip(prefix: string, fromValue?: string, toValue?: string): string {
  const from = String(fromValue || '').trim()
  const to = String(toValue || '').trim()
  if (from && to) {
    return `${prefix}: ${props.t('filters.between')} ${from} ${props.t('filters.rangeAnd')} ${to}`
  }
  if (from) return `${prefix}: ${props.t('filters.greaterOrEqual')} ${from}`
  if (to) return `${prefix}: ${props.t('filters.lessOrEqual')} ${to}`
  return ''
}

function getFilterTooltip(col: ISongsAreaColumn): string {
  if (!col.filterActive) return ''
  if (col.filterType === 'text') {
    const includeText = (col.filterValue || '').trim()
    const excludeKeywords = parseExcludeKeywords((col.filterExcludeValue || '').trim())
    const parts = []
    if (includeText) parts.push(`${props.t('filters.includeKeyword')}: "${includeText}"`)
    if (excludeKeywords.length > 0) {
      parts.push(`${props.t('filters.excludeKeyword')}: "${excludeKeywords.join(', ')}"`)
    }
    if (col.filterCuratedOnly) parts.push(props.t('filters.onlyCuratedArtists'))
    if (parts.length === 0) return ''
    const hasTextFilter = !!includeText || excludeKeywords.length > 0
    const prefix = hasTextFilter ? props.t('filters.filterByText') : ''
    return prefix ? `${prefix}: ${parts.join(' / ')}` : parts.join(' / ')
  }
  if (col.filterType === 'duration') {
    if (col.filterOp === 'between') {
      return formatBetweenTooltip(
        props.t('filters.filterByDuration'),
        col.filterDuration,
        col.filterDurationTo
      )
    }
    const op =
      col.filterOp === 'eq'
        ? props.t('filters.equals')
        : col.filterOp === 'gte'
          ? props.t('filters.greaterOrEqual')
          : props.t('filters.lessOrEqual')
    return `${props.t('filters.filterByDuration')}: ${op} ${col.filterDuration || ''}`
  }
  if (col.filterType === 'bpm') {
    if (col.filterOp === 'between') {
      return formatBetweenTooltip(
        props.t('filters.filterByBpm'),
        col.filterNumber,
        col.filterNumberTo
      )
    }
    const op =
      col.filterOp === 'eq'
        ? props.t('filters.equals')
        : col.filterOp === 'gte'
          ? props.t('filters.greaterOrEqual')
          : props.t('filters.lessOrEqual')
    return `${props.t('filters.filterByBpm')}: ${op} ${col.filterNumber || ''}`
  }
  if (col.filterType === 'number') {
    if (col.filterOp === 'between') {
      return formatBetweenTooltip(
        props.t(`filters.filterBy.${col.key}`),
        col.filterNumber,
        col.filterNumberTo
      )
    }
    const op =
      col.filterOp === 'eq'
        ? props.t('filters.equals')
        : col.filterOp === 'gte'
          ? props.t('filters.greaterOrEqual')
          : props.t('filters.lessOrEqual')
    return `${props.t(`filters.filterBy.${col.key}`)}: ${op} ${col.filterNumber || ''}`
  }
  if (col.filterType === 'date') {
    if (col.filterOp === 'between') {
      return formatBetweenTooltip(props.t('filters.filterByDate'), col.filterDate, col.filterDateTo)
    }
    const op =
      col.filterOp === 'eq'
        ? props.t('filters.equals')
        : col.filterOp === 'gte'
          ? props.t('filters.greaterOrEqual')
          : props.t('filters.lessOrEqual')
    return `${props.t('filters.filterByDate')}: ${op} ${col.filterDate || ''}`
  }
  return ''
}

function resolveFilterDialogType(col: ISongsAreaColumn): FilterDialogType {
  return col.filterType === 'duration' ||
    col.filterType === 'bpm' ||
    col.filterType === 'number' ||
    col.filterType === 'date'
    ? col.filterType
    : 'text'
}

function resolveNumberFilterTitle(col: ISongsAreaColumn): string {
  if (col.filterType === 'bpm') return props.t('filters.filterByBpm')
  return props.t(`filters.filterBy.${col.key}`)
}

function resolveNumberFilterPlaceholder(col: ISongsAreaColumn): string {
  if (col.filterType === 'bpm') return props.t('filters.bpmPlaceholder')
  return props.t(`filters.placeholder.${col.key}`)
}

// 处理表头区域的右键菜单事件
const handleContextMenu = (event: MouseEvent) => {
  emit('header-contextmenu', event)
}

const handleIndexActionClick = () => {
  if (!props.showIndexAction || props.indexActionDisabled) return
  emit('index-action-click')
}
</script>

<template>
  <div
    ref="headerRoot"
    :key="draggableInstanceKey"
    v-draggable="vDraggableData"
    class="songListHeader songItem lightBackground"
    data-user-guide-target="songs-header"
    :style="{
      position: 'sticky',
      top: '0',
      'z-index': '10',
      'background-color': 'var(--bg-elev)',
      'border-bottom': '1px solid var(--border)',
      'min-width': `var(--songs-total-width, ${totalWidth}px)`
    }"
    @contextmenu.stop="handleContextMenu"
  >
    <div
      v-for="col of draggableVisibleColumns"
      :key="col.key"
      class="unselectable header-column"
      :class="['lightBackground', 'titleDiv']"
      :data-user-guide-target="col.key === 'index' ? 'songs-index-col' : undefined"
      :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
      style="
        padding-left: 10px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        position: relative;
      "
    >
      <div style="flex-grow: 1; overflow: hidden; display: flex; align-items: center">
        <!-- 收窄排序触发区域：仅文字与其右侧少量空白响应点击 -->
        <div
          style="white-space: nowrap; display: inline-flex; align-items: center; padding-right: 8px"
          :style="{ color: col.order ? 'var(--accent)' : 'var(--text)' }"
          @click.stop="handleColumnClick(col)"
        >
          {{ t(col.columnName) }}
          <img
            v-if="col.order === 'asc'"
            :src="ascendingOrder"
            style="width: 20px; height: 20px; margin-left: 4px"
          />
          <img
            v-if="col.order === 'desc'"
            :src="descendingOrder"
            style="width: 20px; height: 20px; margin-left: 4px"
          />
        </div>
      </div>
      <!-- 筛选图标：靠右对齐、垂直居中，固定 20×20，不触发排序 -->
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: 8px">
        <button
          v-if="col.key === 'index' && props.showIndexAction"
          :ref="setIndexActionButtonRef"
          class="headerActionButton"
          type="button"
          :aria-label="props.indexActionTitle"
          :disabled="props.indexActionDisabled"
          @click.stop="handleIndexActionClick"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
          >
            <path
              d="M4 3.5H10M4 7H10M4 10.5H10"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
            <path
              d="M2.2 2.5L1.2 3.5L2.2 4.5"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M11.8 9.5L12.8 10.5L11.8 11.5"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <bubbleBox
          v-if="col.key === 'index' && props.showIndexAction"
          :dom="indexActionButtonRef || undefined"
          :title="props.indexActionTitle"
          :max-width="220"
        />
        <bubbleBoxTrigger
          v-if="col.key !== 'index' && col.filterType"
          tag="span"
          class="mask-icon filter-icon"
          :class="{ 'is-active': col.filterActive }"
          :style="filterIconMaskStyle"
          :title="getFilterTooltip(col)"
          @click.stop="(e: MouseEvent) => handleFilterIconClick(e, col)"
        />
      </div>
      <Teleport to="body">
        <filterDialog
          v-if="filterActiveKey === col.key && col.filterType"
          :type="resolveFilterDialogType(col)"
          :init-text="tempText"
          :init-exclude-text="tempExcludeText"
          :init-op="tempOp"
          :init-duration="tempDuration"
          :init-duration-to="tempDurationTo"
          :init-number="tempNumber"
          :init-number-to="tempNumberTo"
          :init-date="tempDate"
          :init-date-to="tempDateTo"
          :number-title="resolveNumberFilterTitle(col)"
          :number-placeholder="resolveNumberFilterPlaceholder(col)"
          :show-curated-only="col.key === 'artist'"
          :init-curated-only="tempCuratedOnly"
          @confirm="
            (payload: FilterDialogPayload) => {
              if (payload.type === 'text') {
                tempText = payload.text
                tempExcludeText = payload.excludeText
                tempCuratedOnly = payload.curatedOnly
              } else if (payload.type === 'duration') {
                tempOp = payload.op
                tempDuration = payload.duration
                tempDurationTo = payload.durationTo || ''
              } else if (payload.type === 'bpm' || payload.type === 'number') {
                tempOp = payload.op
                tempNumber = payload.value
                tempNumberTo = payload.valueTo || ''
              } else if (payload.type === 'date') {
                tempOp = payload.op
                tempDate = payload.date
                tempDateTo = payload.dateTo || ''
              }
              applyFilterConfirm(col)
            }
          "
          @clear="() => clearFilter(col)"
          @cancel="closeFilterDialog"
        />
      </Teleport>
      <div
        v-if="col.key !== 'cover'"
        class="resize-handle"
        style="width: 5px; cursor: e-resize; flex-shrink: 0; height: 100%"
        @mousedown.stop="startResize($event, col)"
      ></div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 从 songsArea.vue 迁移并调整的相关样式 */
.songListHeader {
  // 主容器特定类名
  height: 30px;
  display: flex;
  font-size: 14px;
}

.header-column {
  // 表头中的每一列
  flex-shrink: 0;
  /* 确保列不会收缩 */
  /* 其他通过 :class 和 :style 动态应用 */
}

.lightBackground {
  background-color: var(--bg-elev);
}

/* coverDiv 和 titleDiv 的基础样式 */
.coverDiv,
.titleDiv {
  height: 100%;
  /* 占满父容器高度 */
  box-sizing: border-box;
  border-right: 1px solid var(--border);
  /* padding-left 和其他在 template 中通过 style 属性设置 */
}

.titleDiv {
  /* 表头标题单元格：占位以便后续扩展；保持非空以通过 linter */
  line-height: 30px;
}

.unselectable {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}

.resize-handle {
  /* 右侧拖拽手柄样式补充，避免空规则 */
  background: transparent;
}

.headerActionButton {
  width: 24px;
  height: 22px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg) 78%, var(--accent) 22%);
  color: color-mix(in srgb, var(--accent) 72%, var(--text));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bg-elev) 78%, transparent);

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--bg) 60%, var(--accent) 40%);
    border-color: color-mix(in srgb, var(--accent) 52%, var(--border));
    color: var(--accent);
  }

  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
}

/* 如果需要，可以从 songsArea.vue 复制其他相关样式，例如 .unselectable */

.filter-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-dialog);
}
.filter-modal {
  min-width: 360px;
  max-width: 520px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 16px 12px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.55);
}
.filter-title {
  color: var(--text);
  font-size: 12px;
  margin-bottom: 8px;
}
.filter-input {
  width: 100%;
  height: 28px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  padding: 0 8px;
  outline: none;
}
.op-group {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
  color: var(--text);
}
.op-item input {
  margin-right: 4px;
}
.quick-set {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
.tag {
  height: 24px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 4px;
  padding: 0 8px;
}
.btns {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
.btns .primary {
  background: var(--accent);
  color: #ffffff;
  border: none;
  border-radius: 4px;
  height: 28px;
  padding: 0 10px;
}
.btns .danger {
  background: var(--bg-elev);
  color: #ff7b7b;
  border: 1px solid var(--border);
  border-radius: 4px;
  height: 28px;
  padding: 0 10px;
}
.mask-icon {
  display: inline-block;
  background-color: currentColor;
  mask-image: var(--icon-mask);
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-image: var(--icon-mask);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;
}
.filter-icon {
  width: 20px;
  height: 20px;
  margin-right: 12px;
  cursor: pointer;
  color: var(--text-weak);
}
.filter-icon.is-active {
  color: var(--accent);
}
</style>
