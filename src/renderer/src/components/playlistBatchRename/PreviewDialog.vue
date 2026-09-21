<script setup lang="ts">
import { computed, ref } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import choiceDialog from '@renderer/components/choiceDialog'
import confirm from '@renderer/components/confirmDialog'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import emitter from '@renderer/utils/mitt'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import openResultDialog from './resultDialog'
import type {
  IBatchRenameExecutionRequestItem,
  IBatchRenameExecutionResult,
  IBatchRenamePreviewItem,
  IBatchRenamePreviewStatus
} from 'src/types/globals'

const props = defineProps<{
  title: string
  items: IBatchRenamePreviewItem[]
}>()

const emits = defineEmits(['close'])
const runtime = useRuntimeStore()
const { dialogVisible, closeWithAnimation } = useDialogTransition()

type PreviewFilter = 'all' | 'issues' | 'checked' | 'unchecked'

const previewFilter = ref<PreviewFilter>('all')
const previewSearch = ref('')
const selectionMap = ref<Record<string, boolean>>(
  Object.fromEntries(props.items.map((item) => [item.id, item.status === 'executable']))
)
const executing = ref(false)
const executionTaskId = ref('')
const closeRequestedDuringExecution = ref(false)

const scrollbarOptions = {
  scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
  overflow: { x: 'hidden', y: 'scroll' } as const
}

const selectedCount = computed(
  () => props.items.filter((item) => selectionMap.value[item.id]).length
)
const issueCount = computed(() => props.items.filter((item) => item.status !== 'executable').length)
const blockingCount = computed(
  () =>
    props.items.filter(
      (item) =>
        selectionMap.value[item.id] &&
        ['invalid_chars', 'too_long', 'source_missing', 'invalid_name'].includes(item.status)
    ).length
)

const hasPreview = computed(() => props.items.length > 0)

const sortedPreviewItems = computed(() => {
  const keyword = previewSearch.value.trim().toLocaleLowerCase()
  const filtered = props.items.filter((item) => {
    if (previewFilter.value === 'issues' && item.status === 'executable') return false
    if (previewFilter.value === 'checked' && !selectionMap.value[item.id]) return false
    if (previewFilter.value === 'unchecked' && selectionMap.value[item.id]) return false
    if (!keyword) return true
    return (
      item.originalFileName.toLocaleLowerCase().includes(keyword) ||
      item.targetFileName.toLocaleLowerCase().includes(keyword)
    )
  })
  return [...filtered].sort((left, right) => {
    const leftIssue = left.status === 'executable' ? 1 : 0
    const rightIssue = right.status === 'executable' ? 1 : 0
    if (leftIssue !== rightIssue) return leftIssue - rightIssue
    return left.order - right.order
  })
})

const canExecute = computed(
  () => !executing.value && selectedCount.value > 0 && blockingCount.value === 0
)

const filterTabs = computed(
  (): Array<{
    key: PreviewFilter
    label: string
    count: number
  }> => [
    { key: 'all', label: t('batchRename.filterAll'), count: props.items.length },
    { key: 'issues', label: t('batchRename.filterIssues'), count: issueCount.value },
    { key: 'checked', label: t('batchRename.filterChecked'), count: selectedCount.value },
    {
      key: 'unchecked',
      label: t('batchRename.filterUnchecked'),
      count: Math.max(0, props.items.length - selectedCount.value)
    }
  ]
)

const buildExecutionItemsPayload = (): IBatchRenameExecutionRequestItem[] =>
  props.items.map((item) => ({
    id: String(item.id || ''),
    order: Number(item.order || 0),
    songListUUID: item.songListUUID ? String(item.songListUUID) : undefined,
    filePath: String(item.filePath || ''),
    originalFileName: String(item.originalFileName || ''),
    targetBaseName: String(item.targetBaseName || ''),
    targetFileName: String(item.targetFileName || ''),
    status: item.status,
    selected: !!selectionMap.value[item.id],
    track: {
      order: Number(item.track?.order || 0),
      songListUUID: item.track?.songListUUID ? String(item.track.songListUUID) : undefined,
      songListPath: item.track?.songListPath ? String(item.track.songListPath) : undefined,
      filePath: String(item.track?.filePath || ''),
      fileName: String(item.track?.fileName || ''),
      title: item.track?.title ? String(item.track.title) : undefined,
      artist: item.track?.artist ? String(item.track.artist) : undefined,
      album: item.track?.album ? String(item.track.album) : undefined,
      genre: item.track?.genre ? String(item.track.genre) : undefined,
      label: item.track?.label ? String(item.track.label) : undefined,
      duration: item.track?.duration ? String(item.track.duration) : undefined,
      key: item.track?.key ? String(item.track.key) : undefined,
      bpm: typeof item.track?.bpm === 'number' ? item.track.bpm : undefined
    }
  }))

const resolvePreviewStatusLabel = (status: IBatchRenamePreviewStatus) => {
  switch (status) {
    case 'unchanged':
      return t('batchRename.status.unchanged')
    case 'invalid_chars':
      return t('batchRename.status.invalidChars')
    case 'too_long':
      return t('batchRename.status.tooLong')
    case 'source_missing':
      return t('batchRename.status.sourceMissing')
    case 'invalid_name':
      return t('batchRename.status.invalidName')
    default:
      return t('batchRename.status.executable')
  }
}

const handlePreviewSelection = (itemId: string, checked: boolean) => {
  selectionMap.value = {
    ...selectionMap.value,
    [itemId]: checked
  }
}

const applyBulkSelection = (mode: 'all' | 'none' | 'valid' | 'invert') => {
  const next = { ...selectionMap.value }
  for (const item of sortedPreviewItems.value) {
    if (mode === 'all') next[item.id] = true
    else if (mode === 'none') next[item.id] = false
    else if (mode === 'valid') next[item.id] = item.status === 'executable'
    else next[item.id] = !next[item.id]
  }
  selectionMap.value = next
}

const finalizeExecution = async (result: IBatchRenameExecutionResult) => {
  if (result.updates.length > 0) {
    try {
      emitter.emit('metadataBatchUpdated', { updates: result.updates })
    } catch {}
  }
  runtime.isProgressing = false
  if (closeRequestedDuringExecution.value) {
    window.setTimeout(() => {
      void openResultDialog(result).finally(() => emits('close'))
    }, 280)
    return
  }
  closeWithAnimation(() => {
    emits('close')
    void openResultDialog(result)
  })
}

const executeRename = async () => {
  if (!canExecute.value) {
    if (blockingCount.value > 0) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('batchRename.needUncheckInvalidSelection')],
        confirmShow: false
      })
    }
    return
  }
  executing.value = true
  closeRequestedDuringExecution.value = false
  runtime.isProgressing = true
  executionTaskId.value = `playlist_batch_rename_${Date.now()}`
  try {
    const result = (await window.electron.ipcRenderer.invoke('playlist:batchRename:execute', {
      taskId: executionTaskId.value,
      items: buildExecutionItemsPayload()
    })) as IBatchRenameExecutionResult
    await finalizeExecution(result)
  } catch (error) {
    runtime.isProgressing = false
    await confirm({
      title: t('common.error'),
      content: [error instanceof Error ? error.message : t('common.unknownError')],
      confirmShow: false
    })
  } finally {
    executing.value = false
  }
}

const handleClose = async () => {
  if (executing.value) {
    const action = await choiceDialog({
      title: t('batchRename.executingCloseTitle'),
      content: [t('batchRename.executingCloseDescription')],
      options: [
        { key: 'enter', label: t('batchRename.continueInBackground') },
        { key: 'reset', label: t('batchRename.cancelExecution') },
        { key: 'cancel', label: t('batchRename.backToDialog') }
      ],
      innerHeight: 220,
      innerWidth: 520
    })
    if (action === 'cancel') return
    if (action === 'reset') {
      void window.electron.ipcRenderer.invoke('playlist:batchRename:cancel', {
        taskId: executionTaskId.value
      })
    }
    closeRequestedDuringExecution.value = true
    dialogVisible.value = false
    return
  }
  closeWithAnimation(() => emits('close'))
}
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">{{ title }}</div>
      <div class="content">
        <div class="control-panel">
          <div class="control-row control-row-search">
            <div class="control-label">{{ t('batchRename.searchSectionTitle') }}</div>
            <input
              v-model="previewSearch"
              class="search-input"
              :placeholder="t('batchRename.searchPlaceholder')"
            />
          </div>

          <div class="control-row">
            <div class="control-label">{{ t('batchRename.filterSectionTitle') }}</div>
            <div class="filter-segment">
              <button
                v-for="tab in filterTabs"
                :key="tab.key"
                class="filter-tab"
                :class="{ active: previewFilter === tab.key }"
                @click="previewFilter = tab.key"
              >
                <span class="filter-label">{{ tab.label }}</span>
                <span class="filter-count">{{ tab.count }}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="preview-table">
          <div class="table-toolbar">
            <div class="action-list">
              <button class="action-button" @click="applyBulkSelection('all')">
                {{ t('batchRename.selectAll') }}
              </button>
              <button class="action-button" @click="applyBulkSelection('none')">
                {{ t('batchRename.selectNone') }}
              </button>
              <button class="action-button" @click="applyBulkSelection('valid')">
                {{ t('batchRename.selectValidOnly') }}
              </button>
              <button class="action-button" @click="applyBulkSelection('invert')">
                {{ t('batchRename.selectInvert') }}
              </button>
            </div>
          </div>
          <div class="preview-header">
            <div></div>
            <div>{{ t('batchRename.columnOriginal') }}</div>
            <div>{{ t('batchRename.columnTarget') }}</div>
            <div>{{ t('batchRename.columnStatus') }}</div>
          </div>
          <div v-if="!hasPreview || sortedPreviewItems.length === 0" class="preview-empty">
            {{ t('batchRename.previewNoMatches') }}
          </div>
          <OverlayScrollbarsComponent
            v-else
            class="preview-scroll"
            :options="scrollbarOptions"
            element="div"
            defer
          >
            <div class="preview-rows">
              <div v-for="item in sortedPreviewItems" :key="item.id" class="preview-row">
                <div class="cell checkbox-cell">
                  <input
                    type="checkbox"
                    :checked="!!selectionMap[item.id]"
                    @change="
                      handlePreviewSelection(item.id, ($event.target as HTMLInputElement).checked)
                    "
                  />
                </div>
                <bubbleBoxTrigger tag="div" class="cell ellipsis" :title="item.originalFileName">
                  {{ item.originalFileName }}
                </bubbleBoxTrigger>
                <bubbleBoxTrigger tag="div" class="cell ellipsis" :title="item.targetFileName">
                  {{ item.targetFileName }}
                </bubbleBoxTrigger>
                <div class="cell status-cell">{{ resolvePreviewStatusLabel(item.status) }}</div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>

        <div v-if="blockingCount > 0" class="inline-hint danger-text">
          {{ t('batchRename.needUncheckInvalidSelection') }}
        </div>
      </div>

      <div class="dialog-footer">
        <div class="button primary" :class="{ disabled: !canExecute }" @click="executeRename">
          {{ t('batchRename.startRename') }}
        </div>
        <div class="button" @click="handleClose">{{ t('common.close') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: min(980px, calc(100vw - 40px));
  max-width: calc(100vw - 20px);
  height: min(700px, calc(100vh - 40px));
  max-height: calc(100vh - 20px);
  min-height: min(620px, calc(100vh - 20px));
  padding: 0;
  display: flex;
  flex-direction: column;
}

.content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  overflow: hidden;
}

.control-panel {
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.inline-hint {
  font-size: 12px;
  color: var(--text-weak);
}

.danger-text {
  color: #ff8f8f;
}

.control-row {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.control-row-search {
  align-items: center;
}

.control-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-weak);
  line-height: 30px;
}

.search-input {
  height: 30px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 0 10px;
  outline: none;
}

.search-input:focus {
  border-color: var(--accent);
}

.filter-segment {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.filter-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-weak);
  font-size: 12px;
}

.filter-tab.active {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--text);
}

.filter-label {
  white-space: nowrap;
}

.filter-count {
  min-width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 11px;
  line-height: 1;
  color: var(--text-weak);
}

.filter-tab.active .filter-count {
  color: var(--accent);
}

.action-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.action-button {
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
}

.action-button:hover {
  border-color: var(--accent);
  color: #ffffff;
  background: var(--accent);
}

.preview-table {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg);
}

.table-toolbar {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}

.preview-header,
.preview-row {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) minmax(0, 1fr) 112px;
  gap: 10px;
  align-items: center;
}

.preview-header {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  background: var(--bg);
}

.preview-scroll {
  flex: 1;
  min-height: 0;
}

.preview-row {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.cell {
  font-size: 12px;
  color: var(--text);
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.checkbox-cell {
  display: flex;
  justify-content: center;
}

.status-cell {
  color: var(--text-weak);
}

.preview-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-weak);
}

.button.primary {
  min-width: 132px;
  text-align: center;
}

.button.disabled {
  opacity: 0.45;
  pointer-events: none;
}

@media (max-width: 900px) {
  .control-row {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .control-label {
    line-height: 1.4;
  }

  .table-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .preview-header,
  .preview-row {
    grid-template-columns: 44px minmax(0, 1fr) minmax(0, 1fr) 92px;
    gap: 8px;
  }
}
</style>
