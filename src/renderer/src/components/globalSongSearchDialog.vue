<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { formatBpmDisplay } from '@renderer/utils/bpm'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { SEARCH_FOCUS_PRIORITY, useSearchFocusTarget } from '@renderer/composables/useSearchFocus'

type CoreLibraryName = 'FilterLibrary' | 'CuratedLibrary' | 'MixtapeLibrary' | 'RecycleBin'

export type GlobalSongSearchDialogItem = {
  id: string
  filePath: string
  fileName: string
  title: string
  artist: string
  album: string
  genre: string
  label: string
  duration: string
  keyText: string
  bpm?: number
  container: string
  songListUUID: string
  songListName: string
  songListPath: string
  libraryName: CoreLibraryName
  score: number
}

const emits = defineEmits<{
  (e: 'cancel'): void
  (e: 'locate', payload: GlobalSongSearchDialogItem): void
  (e: 'play', payload: GlobalSongSearchDialogItem): void
}>()

const scope = uuidV4()
const keyword = ref('')
const loading = ref(false)
const results = ref<GlobalSongSearchDialogItem[]>([])
const selectedIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
useSearchFocusTarget({
  getInput: () => inputRef.value,
  scope,
  priority: SEARCH_FOCUS_PRIORITY.dialog
})
const resultListRef = ref<HTMLDivElement | null>(null)
const requestSeq = ref(0)
const actionFeedback = ref('')
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let feedbackTimer: ReturnType<typeof setTimeout> | null = null

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const selectedItem = computed(() => {
  const index = selectedIndex.value
  if (index < 0 || index >= results.value.length) return null
  return results.value[index] || null
})

const getLibraryLabel = (libraryName: CoreLibraryName) => {
  if (libraryName === 'CuratedLibrary') return t('library.curated')
  if (libraryName === 'MixtapeLibrary') return t('library.mixtapeLibrary')
  if (libraryName === 'RecycleBin') return t('recycleBin.recycleBin')
  return t('library.filter')
}

const getSongListPathText = (item: GlobalSongSearchDialogItem) =>
  item.songListPath || item.songListName || '-'

const getMetaLineText = (item: GlobalSongSearchDialogItem) => {
  const parts: string[] = []
  if (item.genre) parts.push(item.genre)
  if (item.label) parts.push(item.label)
  if (item.container) parts.push(item.container)
  if (item.duration) parts.push(item.duration)
  if (item.keyText) parts.push(item.keyText)
  if (typeof item.bpm === 'number' && Number.isFinite(item.bpm)) {
    parts.push(`BPM ${formatBpmDisplay(item.bpm)}`)
  }
  return parts.join(' · ')
}

const queryTokens = computed(() => {
  const raw = String(keyword.value || '').trim()
  if (!raw) return [] as string[]
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const part of raw.split(/\s+/)) {
    const token = part.trim()
    if (!token) continue
    const key = token.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tokens.push(token)
  }
  tokens.sort((a, b) => b.length - a.length)
  return tokens
})

const escapeHtml = (input: string) =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const highlightField = (value: unknown) => {
  const source = String(value || '')
  if (!source) return ''
  const tokens = queryTokens.value
  if (!tokens.length) return escapeHtml(source)

  const lowerSource = source.toLocaleLowerCase()
  const ranges: Array<{ start: number; end: number }> = []

  for (const rawToken of tokens) {
    const token = rawToken.toLocaleLowerCase()
    if (!token) continue
    let from = 0
    while (from < lowerSource.length) {
      const hit = lowerSource.indexOf(token, from)
      if (hit < 0) break
      ranges.push({ start: hit, end: hit + token.length })
      from = hit + Math.max(1, token.length)
    }
  }

  if (!ranges.length) return escapeHtml(source)
  ranges.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return b.end - a.end
  })

  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (!last || range.start > last.end) {
      merged.push({ ...range })
      continue
    }
    if (range.end > last.end) {
      last.end = range.end
    }
  }

  let cursor = 0
  let html = ''
  for (const range of merged) {
    if (cursor < range.start) {
      html += escapeHtml(source.slice(cursor, range.start))
    }
    html += `<mark class="search-hit">${escapeHtml(source.slice(range.start, range.end))}</mark>`
    cursor = range.end
  }
  if (cursor < source.length) {
    html += escapeHtml(source.slice(cursor))
  }
  return html
}

const closeDialog = () => {
  closeWithAnimation(() => emits('cancel'))
}

const focusInput = () => {
  nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}

const keepSelectionVisible = () => {
  nextTick(() => {
    const host = resultListRef.value
    if (!host) return
    const active = host.querySelector<HTMLElement>('.result-item.active')
    active?.scrollIntoView({ block: 'nearest' })
  })
}

const showActionFeedback = (message: string) => {
  actionFeedback.value = message
  if (feedbackTimer) {
    clearTimeout(feedbackTimer)
    feedbackTimer = null
  }
  feedbackTimer = setTimeout(() => {
    actionFeedback.value = ''
    feedbackTimer = null
  }, 1200)
}

const doQuery = async (rawKeyword: string) => {
  const query = String(rawKeyword || '').trim()
  const currentSeq = requestSeq.value + 1
  requestSeq.value = currentSeq
  if (!query) {
    results.value = []
    selectedIndex.value = 0
    return
  }
  loading.value = true
  try {
    const response = await window.electron.ipcRenderer.invoke('song-search:query', {
      keyword: query,
      limit: 80
    })
    if (currentSeq !== requestSeq.value) return
    const items = Array.isArray(response?.items) ? response.items : []
    results.value = items
    if (!items.length) {
      selectedIndex.value = 0
    } else if (selectedIndex.value >= items.length) {
      selectedIndex.value = items.length - 1
    }
  } catch {
    if (currentSeq !== requestSeq.value) return
    results.value = []
    selectedIndex.value = 0
  } finally {
    if (currentSeq === requestSeq.value) {
      loading.value = false
    }
  }
}

watch(
  () => keyword.value,
  (nextKeyword) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    debounceTimer = setTimeout(() => {
      void doQuery(nextKeyword)
    }, 60)
  }
)

watch(
  () => selectedIndex.value,
  () => {
    keepSelectionVisible()
  }
)

watch(
  () => results.value.length,
  (size) => {
    if (!size) return
    keepSelectionVisible()
  }
)

const moveSelection = (delta: number) => {
  if (!results.value.length) return
  const max = results.value.length - 1
  if (selectedIndex.value < 0 || selectedIndex.value > max) {
    selectedIndex.value = 0
    return
  }
  let next = selectedIndex.value + delta
  if (next < 0) next = max
  if (next > max) next = 0
  selectedIndex.value = next
}

const locateSelected = () => {
  const item = selectedItem.value
  if (!item) {
    const message = loading.value
      ? t('common.loading')
      : keyword.value.trim()
        ? t('filters.noResults')
        : t('search.globalSongEmptyHint')
    showActionFeedback(message)
    return
  }
  closeWithAnimation(() => emits('locate', item))
}

const playSelected = () => {
  const item = selectedItem.value
  if (!item) {
    const message = loading.value
      ? t('common.loading')
      : keyword.value.trim()
        ? t('filters.noResults')
        : t('search.globalSongEmptyHint')
    showActionFeedback(message)
    return
  }
  closeWithAnimation(() => emits('play', item))
}

const locateByMouse = (item: GlobalSongSearchDialogItem) => {
  closeWithAnimation(() => emits('locate', item))
}

const playByMouse = (item: GlobalSongSearchDialogItem, event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  closeWithAnimation(() => emits('play', item))
}

const setSelectedIndex = (index: number) => {
  selectedIndex.value = index
}

const handleInputKeydown = (event: KeyboardEvent) => {
  if (event.isComposing) return
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveSelection(-1)
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveSelection(1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      playSelected()
      return
    }
    locateSelected()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDialog()
  }
}

onMounted(() => {
  utils.setHotkeysScpoe(scope)
  hotkeys('esc', scope, () => {
    closeDialog()
    return false
  })
  hotkeys('enter', scope, () => {
    locateSelected()
    return false
  })
  hotkeys('ctrl+enter,command+enter', scope, () => {
    playSelected()
    return false
  })
  hotkeys('up', scope, () => {
    moveSelection(-1)
    return false
  })
  hotkeys('down', scope, () => {
    moveSelection(1)
    return false
  })
  focusInput()
  void window.electron.ipcRenderer.invoke('song-search:warmup').catch(() => {})
})

onUnmounted(() => {
  utils.delHotkeysScope(scope)
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (feedbackTimer) {
    clearTimeout(feedbackTimer)
    feedbackTimer = null
  }
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner"
      style="width: 820px; height: 560px; display: flex; flex-direction: column"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t('menu.globalSongSearch') }}</span>
      </div>
      <div class="search-bar">
        <input
          ref="inputRef"
          v-model="keyword"
          class="search-input"
          type="text"
          :placeholder="t('search.globalSongPlaceholder')"
          @keydown="handleInputKeydown"
        />
        <div class="search-hint">
          <span>{{ t('search.globalSongLocateHint') }}</span>
          <span>{{ t('search.globalSongPlayHint') }}</span>
        </div>
      </div>
      <div class="result-panel">
        <div v-if="loading" class="result-placeholder">{{ t('common.loading') }}</div>
        <div v-else-if="!results.length && keyword.trim().length > 0" class="result-placeholder">
          {{ t('filters.noResults') }}
        </div>
        <div v-else-if="!results.length" class="result-placeholder">
          {{ t('search.globalSongEmptyHint') }}
        </div>
        <div v-else ref="resultListRef" class="result-list">
          <div
            v-for="(item, index) in results"
            :key="item.id"
            class="result-item"
            :class="{ active: index === selectedIndex }"
            @mouseenter="setSelectedIndex(index)"
            @click="locateByMouse(item)"
          >
            <div class="main-line">
              <span class="title" v-html="highlightField(item.title || item.fileName)"></span>
              <span class="meta" v-html="highlightField(item.artist || '-')"></span>
              <span class="meta" v-html="highlightField(item.album || '-')"></span>
            </div>
            <div class="sub-line">
              <div class="playlist-location">
                <span
                  class="library-chip"
                  v-html="highlightField(getLibraryLabel(item.libraryName))"
                ></span>
                <span class="path" v-html="highlightField(getSongListPathText(item))"></span>
              </div>
              <button class="play-btn" @click="playByMouse(item, $event)">
                {{ t('search.globalSongPlayNow') }}
              </button>
            </div>
            <div class="extra-line">
              <span
                v-if="getMetaLineText(item)"
                class="meta-pack"
                v-html="highlightField(getMetaLineText(item))"
              ></span>
              <span class="file-path" v-html="highlightField(item.filePath)"></span>
            </div>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div v-if="actionFeedback" class="action-feedback">{{ actionFeedback }}</div>
        <div class="button" @click="locateSelected()">
          {{ t('search.globalSongLocateNow') }} (Enter)
        </div>
        <div class="button" @click="playSelected()">
          {{ t('search.globalSongPlayNow') }} (Ctrl+Enter)
        </div>
        <div class="button" @click="closeDialog()">{{ t('common.cancel') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.search-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.search-input {
  width: 100%;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background-color: var(--bg-elev);
  color: var(--text);
  box-sizing: border-box;
  padding: 0 10px;
  outline: none;

  &:focus {
    border-color: var(--accent);
  }
}

.search-hint {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--text-weak);
}

.result-panel {
  flex: 1;
  min-height: 0;
  padding: 10px 16px;
  overflow: hidden;
}

.result-placeholder {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 13px;
}

.result-list {
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(132, 139, 149, 0.88) transparent;
}

.result-list::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.result-list::-webkit-scrollbar-track {
  background: transparent;
}

.result-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
  background-color: rgba(132, 139, 149, 0.72);
}

.result-list:hover::-webkit-scrollbar-thumb {
  background-color: rgba(132, 139, 149, 0.95);
}

.result-item {
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background-color: var(--bg-elev);
  cursor: pointer;

  &:hover,
  &.active {
    border-color: var(--accent);
    background-color: var(--hover);
  }
}

.main-line {
  display: grid;
  grid-template-columns: minmax(220px, 2fr) minmax(120px, 1fr) minmax(120px, 1fr);
  gap: 10px;
  min-width: 0;
}

.title,
.meta,
.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title {
  font-size: 13px;
  color: var(--text);
}

.meta {
  font-size: 12px;
  color: var(--text-weak);
}

.sub-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.playlist-location {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.library-chip {
  height: 20px;
  line-height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background-color: var(--bg);
  color: var(--text-weak);
  font-size: 11px;
  flex: 0 0 auto;
}

.extra-line {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meta-pack {
  font-size: 11px;
  color: var(--text-weak);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-path {
  font-size: 11px;
  color: var(--text-weak);
  opacity: 0.9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(mark.search-hit) {
  background-color: rgba(255, 214, 102, 0.5);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

.path {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-weak);
}

.play-btn {
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background-color: var(--bg);
  color: var(--text);
  padding: 0 10px;
  cursor: pointer;

  &:hover {
    background-color: var(--accent);
    color: #ffffff;
  }
}

.action-feedback {
  margin-right: auto;
  font-size: 12px;
  color: var(--text-weak);
}
</style>
