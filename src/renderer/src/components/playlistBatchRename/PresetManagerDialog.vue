<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import type { BatchRenameSongListTarget } from './index'
import { usePlaylistBatchRenameDialog } from './usePlaylistBatchRenameDialog'
import { createTextSegment, createTokenSegment, normalizeTemplateSegments } from './storage'
import { v4 as uuidV4 } from 'uuid'
import type {
  IBatchRenameTemplateSegment,
  IBatchRenameTemplateToken,
  IBatchRenameTrackInput
} from 'src/types/globals'

const props = defineProps<{
  title: string
  songLists: BatchRenameSongListTarget[]
  tracks?: IBatchRenameTrackInput[]
  selectedPresetId?: string
}>()

const emits = defineEmits<{
  (event: 'close', presetId?: string | null): void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const {
  TOKEN_ORDER,
  beginRenamePreset,
  deletePreset,
  draftChanged,
  handleCreatePreset,
  handleSavePreset,
  isTemplateBlank,
  presets,
  replaceTemplateSegments,
  sampleItems,
  sampleLoading,
  scanning,
  scrollbarOptions,
  selectedPreset,
  selectedPresetId,
  switchPreset,
  templateSegments,
  templateLiteralInvalidCharsMessage,
  tokenLabelMap
} = usePlaylistBatchRenameDialog({
  songLists: props.songLists,
  tracks: props.tracks || [],
  selectedPresetId: props.selectedPresetId
})

const presetOptions = computed(() =>
  presets.value.map((preset) => ({
    label: preset.name,
    value: preset.id
  }))
)

const editorRef = ref<HTMLDivElement | null>(null)
let lastSelectionRange: Range | null = null
let suppressEditorSync = false

const buildTokenElement = (segment: Extract<IBatchRenameTemplateSegment, { type: 'token' }>) => {
  const span = document.createElement('span')
  span.className = 'segment-token'
  span.contentEditable = 'false'
  span.dataset.segmentId = segment.id
  span.dataset.token = segment.token
  const label = document.createElement('span')
  label.textContent = tokenLabelMap[segment.token]
  const close = document.createElement('span')
  close.className = 'token-close'
  close.textContent = '×'
  span.append(label, close)
  return span
}

const renderEditorFromSegments = () => {
  const editor = editorRef.value
  if (!editor || suppressEditorSync) return
  const fragment = document.createDocumentFragment()
  for (const segment of templateSegments.value) {
    if (segment.type === 'text') {
      fragment.append(document.createTextNode(segment.value))
    } else {
      fragment.append(buildTokenElement(segment))
    }
  }
  editor.innerHTML = ''
  editor.append(fragment)
}

const parseSegmentsFromEditor = (): IBatchRenameTemplateSegment[] => {
  const editor = editorRef.value
  if (!editor) return normalizeTemplateSegments([createTextSegment('')])
  const rawSegments: IBatchRenameTemplateSegment[] = []
  const pushText = (value: string) => {
    if (!value) return
    const last = rawSegments[rawSegments.length - 1]
    if (last?.type === 'text') {
      last.value += value
    } else {
      rawSegments.push({
        id: uuidV4(),
        type: 'text',
        value
      })
    }
  }
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent || '')
      return
    }
    if (node instanceof HTMLElement && node.dataset.token) {
      rawSegments.push({
        id: node.dataset.segmentId || uuidV4(),
        type: 'token',
        token: node.dataset.token as never
      })
      return
    }
    node.childNodes.forEach((child) => walk(child))
  }
  editor.childNodes.forEach((node) => walk(node))
  return normalizeTemplateSegments(rawSegments)
}

const syncSegmentsFromEditor = () => {
  suppressEditorSync = true
  replaceTemplateSegments(parseSegmentsFromEditor())
  nextTick(() => {
    suppressEditorSync = false
  })
}

const saveSelection = () => {
  const editor = editorRef.value
  const selection = window.getSelection()
  if (!editor || !selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer)) return
  lastSelectionRange = range.cloneRange()
}

const setCursorAfterNode = (node: Node) => {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  lastSelectionRange = range.cloneRange()
}

const handleEditorInput = () => {
  syncSegmentsFromEditor()
  saveSelection()
}

const handleEditorKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Backspace' && event.key !== 'Delete') return
  const editor = editorRef.value
  const selection = window.getSelection()
  if (!editor || !selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  if (!range.collapsed || !editor.contains(range.startContainer)) return

  const getAdjacentToken = (direction: 'backward' | 'forward'): HTMLElement | null => {
    const container = range.startContainer
    const offset = range.startOffset
    if (container.nodeType === Node.TEXT_NODE) {
      const text = container.textContent || ''
      if (direction === 'backward' && offset > 0) return null
      if (direction === 'forward' && offset < text.length) return null
      const sibling = direction === 'backward' ? container.previousSibling : container.nextSibling
      return sibling instanceof HTMLElement && sibling.dataset.token ? sibling : null
    }
    if (container instanceof HTMLElement) {
      const siblingIndex = direction === 'backward' ? offset - 1 : offset
      const sibling = container.childNodes[siblingIndex] || null
      return sibling instanceof HTMLElement && sibling.dataset.token ? sibling : null
    }
    return null
  }

  const tokenNode = getAdjacentToken(event.key === 'Backspace' ? 'backward' : 'forward')
  if (!tokenNode) return
  event.preventDefault()
  const anchor = event.key === 'Backspace' ? tokenNode.previousSibling : tokenNode.nextSibling
  tokenNode.remove()
  syncSegmentsFromEditor()
  if (anchor) {
    if (anchor.nodeType === Node.TEXT_NODE) {
      const text = anchor.textContent || ''
      const selectionAfter = window.getSelection()
      if (selectionAfter) {
        const nextRange = document.createRange()
        const offset = event.key === 'Backspace' ? text.length : 0
        nextRange.setStart(anchor, offset)
        nextRange.collapse(true)
        selectionAfter.removeAllRanges()
        selectionAfter.addRange(nextRange)
        lastSelectionRange = nextRange.cloneRange()
      }
      return
    }
    setCursorAfterNode(anchor)
  } else if (editor) {
    const selectionAfter = window.getSelection()
    if (selectionAfter) {
      const nextRange = document.createRange()
      nextRange.selectNodeContents(editor)
      nextRange.collapse(event.key === 'Delete')
      selectionAfter.removeAllRanges()
      selectionAfter.addRange(nextRange)
      lastSelectionRange = nextRange.cloneRange()
    }
  }
}

const handleTokenInsert = (token: IBatchRenameTemplateToken) => {
  const editor = editorRef.value
  if (!editor) return
  editor.focus()
  const selection = window.getSelection()
  if (!selection) return
  if (!lastSelectionRange || !editor.contains(lastSelectionRange.startContainer)) {
    const fallbackRange = document.createRange()
    fallbackRange.selectNodeContents(editor)
    fallbackRange.collapse(false)
    selection.removeAllRanges()
    selection.addRange(fallbackRange)
    lastSelectionRange = fallbackRange.cloneRange()
  } else {
    selection.removeAllRanges()
    selection.addRange(lastSelectionRange)
  }
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const tokenNode = buildTokenElement(
    createTokenSegment(token) as Extract<IBatchRenameTemplateSegment, { type: 'token' }>
  )
  range.insertNode(tokenNode)
  const trailingText = document.createTextNode('')
  tokenNode.after(trailingText)
  setCursorAfterNode(tokenNode)
  syncSegmentsFromEditor()
}

const handleCancel = () => closeWithAnimation(() => emits('close', null))

const handleConfirm = async () => {
  if (templateLiteralInvalidCharsMessage.value) {
    await confirm({
      title: t('dialog.hint'),
      content: [templateLiteralInvalidCharsMessage.value],
      confirmShow: false
    })
    return
  }
  if (draftChanged.value) {
    const saved = await handleSavePreset()
    if (!saved) return
  }
  closeWithAnimation(() => emits('close', selectedPresetId.value))
}

watch(
  () =>
    templateSegments.value.map((segment) =>
      segment.type === 'text'
        ? `${segment.id}:text:${segment.value}`
        : `${segment.id}:token:${segment.token}`
    ),
  () => {
    renderEditorFromSegments()
  },
  { immediate: true, flush: 'sync' }
)

watch(
  () => [scanning.value, !!editorRef.value],
  ([isScanning, hasEditor]) => {
    if (!isScanning && hasEditor) {
      nextTick(() => {
        renderEditorFromSegments()
      })
    }
  },
  { immediate: true, flush: 'post' }
)

onMounted(() => {
  document.addEventListener('selectionchange', saveSelection)
})

onUnmounted(() => {
  document.removeEventListener('selectionchange', saveSelection)
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">{{ t('batchRename.managePresets') }}</div>
      <div class="content">
        <div v-if="scanning" class="scan-panel">
          <div class="scan-title">{{ t('batchRename.scanningTitle') }}</div>
        </div>

        <OverlayScrollbarsComponent
          v-else
          class="body-scroll"
          :options="scrollbarOptions"
          element="div"
          defer
        >
          <div class="body">
            <div class="toolbar">
              <BaseSelect
                :model-value="selectedPresetId"
                :options="presetOptions"
                :width="'240px'"
                @change="(value) => (typeof value === 'string' ? switchPreset(value) : null)"
              />
              <div class="toolbar-actions">
                <div class="button" @click="handleCreatePreset">
                  {{ t('batchRename.createPreset') }}
                </div>
                <div class="button" @click="beginRenamePreset">
                  {{ t('batchRename.renamePreset') }}
                </div>
                <div class="button danger" @click="deletePreset">
                  {{ t('batchRename.deletePreset') }}
                </div>
              </div>
            </div>

            <div class="status-line">
              <span>{{ selectedPreset?.name || '' }}</span>
              <span v-if="draftChanged">{{ t('batchRename.unsaved') }}</span>
            </div>

            <div class="editor-layout">
              <div class="editor-card">
                <div class="card-title">{{ t('batchRename.templateSectionTitle') }}</div>
                <div
                  ref="editorRef"
                  class="template-editor"
                  contenteditable="true"
                  spellcheck="false"
                  @input="handleEditorInput"
                  @keydown="handleEditorKeydown"
                  @click="saveSelection"
                  @keyup="saveSelection"
                ></div>
                <div v-if="templateLiteralInvalidCharsMessage" class="template-warning">
                  {{ templateLiteralInvalidCharsMessage }}
                </div>
              </div>

              <div class="token-card">
                <div class="card-title">{{ t('batchRename.availableTokensTitle') }}</div>
                <div class="token-list">
                  <button
                    v-for="token in TOKEN_ORDER"
                    :key="token"
                    class="token-button"
                    @click="handleTokenInsert(token)"
                  >
                    {{ tokenLabelMap[token] }}
                  </button>
                </div>
              </div>
            </div>

            <div class="sample-box">
              <div class="sample-title">{{ t('batchRename.sampleTitle') }}</div>
              <div v-if="sampleLoading" class="sample-empty">
                {{ t('batchRename.sampleLoading') }}
              </div>
              <div v-else-if="sampleItems.length === 0" class="sample-empty">
                {{
                  isTemplateBlank
                    ? t('batchRename.sampleEmptyTemplate')
                    : t('batchRename.sampleEmpty')
                }}
              </div>
              <div v-else class="sample-list">
                <div v-for="item in sampleItems" :key="item.id" class="sample-row">
                  <div class="sample-line sample-line-source">
                    <span class="sample-label">{{ t('batchRename.sampleOriginalLabel') }}</span>
                    <bubbleBoxTrigger
                      tag="span"
                      class="sample-source"
                      :title="item.originalFileName"
                    >
                      {{ item.originalFileName }}
                    </bubbleBoxTrigger>
                  </div>
                  <div class="sample-line sample-line-target">
                    <span class="sample-label">{{ t('batchRename.sampleTargetLabel') }}</span>
                    <bubbleBoxTrigger tag="span" class="sample-target" :title="item.targetFileName">
                      {{ item.targetFileName }}
                    </bubbleBoxTrigger>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </OverlayScrollbarsComponent>
      </div>

      <div class="dialog-footer">
        <div
          class="button"
          :class="{ disabled: !!templateLiteralInvalidCharsMessage }"
          @click="handleConfirm"
        >
          {{ t('common.confirm') }}
        </div>
        <div class="button" @click="handleCancel">{{ t('common.cancel') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: min(920px, calc(100vw - 40px));
  max-width: calc(100vw - 20px);
  height: min(640px, calc(100vh - 40px));
  max-height: calc(100vh - 20px);
  min-height: min(560px, calc(100vh - 20px));
  padding: 0;
  display: flex;
  flex-direction: column;
}

.content {
  flex: 1;
  min-height: 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.body-scroll {
  flex: 1;
  min-height: 0;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-right: 2px;
}

.toolbar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  min-width: 0;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.status-line,
.sample-empty {
  font-size: 12px;
  color: var(--text-weak);
}

.status-line {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  min-height: 16px;
}

.editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 16px;
  align-items: start;
}

.editor-card,
.token-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  padding: 12px;
  min-width: 0;
}

.card-title {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-weak);
}

.template-warning {
  margin-top: 8px;
  font-size: 12px;
  color: #ff8f8f;
  line-height: 1.5;
}

.token-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-content: flex-start;
}

.token-button,
.segment-token {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-weak);
  padding: 0 10px;
  font-size: 12px;
  line-height: 28px;
  min-height: 28px;
  letter-spacing: 0.1px;
  box-sizing: border-box;
}

.token-button:hover {
  background: var(--hover);
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border) 60%);
}

.token-card {
  position: sticky;
  top: 0;
}

.template-editor {
  min-height: 120px;
  min-width: 0;
  display: block;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  padding: 10px 12px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  cursor: text;
}

.template-editor:focus {
  border-color: var(--accent);
  outline: none;
}

:deep(.segment-token) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  max-width: 100%;
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border-color: color-mix(in srgb, var(--accent) 18%, transparent);
  padding: 0 8px;
  margin: 0 2px;
  vertical-align: baseline;
  user-select: none;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
  border-radius: 999px;
  box-sizing: border-box;
}

:deep(.segment-token:hover) {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 24%, transparent);
  color: var(--text);
}

:deep(.segment-token > span:first-child) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.token-close) {
  color: var(--text-weak);
  font-size: 11px;
  opacity: 0.85;
  font-weight: 400;
}

.sample-title {
  font-size: 12px;
  color: var(--text-weak);
  margin-bottom: 8px;
}

.sample-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sample-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.sample-line {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}

.sample-label,
.sample-source,
.sample-target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.sample-label {
  color: var(--text-weak);
}

.sample-source {
  color: var(--text);
}

.sample-target {
  color: var(--text-weak);
}

@media (max-width: 900px) {
  .toolbar {
    align-items: stretch;
  }

  .editor-layout {
    grid-template-columns: 1fr;
  }

  .token-card {
    position: static;
  }
}
</style>
