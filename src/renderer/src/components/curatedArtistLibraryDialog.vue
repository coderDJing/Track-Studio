<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, type ComponentPublicInstance } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import confirm from '@renderer/components/confirmDialog'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type { ICuratedArtistFavorite } from 'src/types/globals'

type ArtistDraftEntry = {
  id: string
  name: string
  count: number
}

type SortColumn = 'name' | 'count'
type SortOrder = 'asc' | 'desc'

const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const defaultSortOrder: Record<SortColumn, SortOrder> = {
  name: 'asc',
  count: 'desc'
}

const props = defineProps<{
  artists: ICuratedArtistFavorite[]
  confirmCallback: (artists: ICuratedArtistFavorite[]) => void
  cancelCallback: () => void
}>()

const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const entries = ref<ArtistDraftEntry[]>(
  (props.artists || []).map((artist) => ({
    id: uuidV4(),
    name: String(artist?.name || ''),
    count: Math.max(1, Math.round(Number(artist?.count) || 1))
  }))
)
const errorText = ref('')
const invalidEntryIds = ref<string[]>([])
const inputRefMap = new Map<string, HTMLInputElement | null>()
const sortColumn = ref<SortColumn>('name')
const sortOrder = ref<SortOrder>('asc')
const isRemoving = ref(false)
const searchKeyword = ref('')
const focusedEntryId = ref('')

const sanitizeArtistName = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
const normalizeArtistName = (value: unknown) => sanitizeArtistName(value).toLocaleLowerCase()

const searchKeywordNormalized = computed(() => searchKeyword.value.trim().toLocaleLowerCase())
const displayedEntries = computed(() => {
  const keyword = searchKeywordNormalized.value
  if (!keyword) return entries.value
  return entries.value.filter((entry) => {
    if (entry.id === focusedEntryId.value) return true
    return entry.name.toLocaleLowerCase().includes(keyword)
  })
})
const totalCountText = computed(() => {
  if (!searchKeywordNormalized.value) {
    return t('settings.curatedArtistTracking.managerCount', { count: entries.value.length })
  }
  return t('settings.curatedArtistTracking.managerFilteredCount', {
    count: entries.value.length,
    shown: displayedEntries.value.length
  })
})
const searchEmptyText = computed(() =>
  t('settings.curatedArtistTracking.managerSearchEmpty', {
    keyword: searchKeyword.value.trim()
  })
)

const resolveInputElement = (el: Element | ComponentPublicInstance | null) => {
  if (el && typeof (el as ComponentPublicInstance).$el !== 'undefined') {
    return ((el as ComponentPublicInstance).$el || null) as HTMLInputElement | null
  }
  return el as HTMLInputElement | null
}

const setInputRef = (id: string, el: Element | ComponentPublicInstance | null) => {
  inputRefMap.set(id, resolveInputElement(el))
}

const focusEntryInput = (id: string) => {
  nextTick(() => {
    const input = inputRefMap.get(id)
    if (!input) return
    input.focus()
    input.select()
  })
}

const clearValidationState = () => {
  errorText.value = ''
  invalidEntryIds.value = []
}

const addEntry = (name = '', count = 1) => {
  const entry = {
    id: uuidV4(),
    name,
    count: Math.max(1, Math.round(Number(count) || 1))
  }
  searchKeyword.value = ''
  entries.value.push(entry)
  clearValidationState()
  focusEntryInput(entry.id)
}

const clearSearch = () => {
  searchKeyword.value = ''
}

const compareArtistNames = (left: ArtistDraftEntry, right: ArtistDraftEntry) =>
  nameCollator.compare(sanitizeArtistName(left.name), sanitizeArtistName(right.name))

const compareEntries = (left: ArtistDraftEntry, right: ArtistDraftEntry) => {
  if (sortColumn.value === 'count') {
    const countDiff = left.count - right.count
    if (countDiff !== 0) return sortOrder.value === 'asc' ? countDiff : -countDiff
    const nameDiff = compareArtistNames(left, right)
    if (nameDiff !== 0) return nameDiff
    return left.id.localeCompare(right.id)
  }
  const nameDiff = compareArtistNames(left, right)
  if (nameDiff !== 0) return sortOrder.value === 'asc' ? nameDiff : -nameDiff
  const countDiff = left.count - right.count
  if (countDiff !== 0) return countDiff
  return left.id.localeCompare(right.id)
}

const applySort = () => {
  entries.value = [...entries.value].sort(compareEntries)
}

const handleSortClick = (column: SortColumn) => {
  if (sortColumn.value === column) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortColumn.value = column
    sortOrder.value = defaultSortOrder[column]
  }
  applySort()
}

const removeEntry = async (id: string) => {
  if (isRemoving.value) return
  const entry = entries.value.find((item) => item.id === id)
  if (!entry) return
  const artistName =
    sanitizeArtistName(entry.name) || t('settings.curatedArtistTracking.managerUnnamedArtist')
  isRemoving.value = true
  try {
    const result = await confirm({
      title: t('common.warning'),
      content: [
        t('settings.curatedArtistTracking.managerDeleteConfirm', { artist: artistName }),
        t('settings.curatedArtistTracking.managerDeleteConfirmHint')
      ]
    })
    if (result !== 'confirm') return
    entries.value = entries.value.filter((item) => item.id !== id)
    clearValidationState()
  } finally {
    isRemoving.value = false
  }
}

const validateEntries = (): ICuratedArtistFavorite[] | null => {
  const invalidIds: string[] = []
  const normalizedMap = new Map<string, string>()
  const nextArtists: ICuratedArtistFavorite[] = []

  for (const entry of entries.value) {
    const name = sanitizeArtistName(entry.name)
    const normalized = normalizeArtistName(name)
    if (!normalized) {
      invalidIds.push(entry.id)
      continue
    }
    const duplicated = normalizedMap.get(normalized)
    if (duplicated) {
      invalidIds.push(entry.id)
      errorText.value = t('settings.curatedArtistTracking.managerDuplicate', { artist: name })
      continue
    }
    normalizedMap.set(normalized, entry.id)
    nextArtists.push({
      name,
      count: Math.max(1, Math.round(Number(entry.count) || 1))
    })
  }

  if (invalidIds.length > 0) {
    searchKeyword.value = ''
    invalidEntryIds.value = invalidIds
    if (!errorText.value) {
      errorText.value = t('settings.curatedArtistTracking.managerNameRequired')
    }
    focusEntryInput(invalidIds[0])
    return null
  }

  clearValidationState()
  return nextArtists
}

const clickSave = () => {
  const nextArtists = validateEntries()
  if (!nextArtists) return
  closeWithAnimation(() => props.confirmCallback(nextArtists))
}

const clickCancel = () => {
  closeWithAnimation(() => props.cancelCallback())
}

onMounted(() => {
  applySort()
  hotkeys('Esc', uuid, () => {
    clickCancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  inputRefMap.clear()
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">
        {{ t('settings.curatedArtistTracking.managerTitle') }}
      </div>
      <div class="body">
        <div class="toolbar">
          <div>
            <div class="toolbar-title">
              {{ t('settings.curatedArtistTracking.managerDesc') }}
            </div>
            <div class="toolbar-subtitle">{{ totalCountText }}</div>
          </div>
          <div class="button toolbar-button" @click="addEntry()">
            {{ t('settings.curatedArtistTracking.managerAddButton') }}
          </div>
        </div>
        <div class="error-slot">
          <div class="error-text" :class="{ 'error-text--hidden': !errorText }">
            {{ errorText || t('settings.curatedArtistTracking.managerValidationPlaceholder') }}
          </div>
        </div>
        <div class="list-shell">
          <div v-if="entries.length > 0" class="search-bar">
            <div class="search-input-wrapper">
              <input
                v-model="searchKeyword"
                class="search-input"
                :placeholder="t('settings.curatedArtistTracking.managerSearchPlaceholder')"
              />
              <div v-show="searchKeyword.length > 0" class="search-clear" @click="clearSearch()">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  shape-rendering="geometricPrecision"
                >
                  <path
                    d="M3 3 L9 9 M9 3 L3 9"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    vector-effect="non-scaling-stroke"
                  />
                </svg>
              </div>
            </div>
          </div>
          <div v-if="entries.length > 0" class="artist-header artist-grid">
            <div class="artist-header-cell artist-header-cell--index">
              {{ t('settings.curatedArtistTracking.managerColumnIndex') }}
            </div>
            <bubbleBoxTrigger
              tag="div"
              class="artist-header-cell artist-header-cell--sortable"
              :class="{ 'artist-header-cell--active': sortColumn === 'name' }"
              :title="t('settings.curatedArtistTracking.managerSortNameHint')"
              @click="handleSortClick('name')"
            >
              <span>{{ t('settings.curatedArtistTracking.managerColumnName') }}</span>
              <span
                v-if="sortColumn === 'name'"
                class="sort-caret"
                :class="sortOrder"
                aria-hidden="true"
              ></span>
            </bubbleBoxTrigger>
            <bubbleBoxTrigger
              tag="div"
              class="artist-header-cell artist-header-cell--sortable artist-header-cell--count"
              :class="{ 'artist-header-cell--active': sortColumn === 'count' }"
              :title="t('settings.curatedArtistTracking.managerSortCountHint')"
              @click="handleSortClick('count')"
            >
              <span>{{ t('settings.curatedArtistTracking.managerColumnCount') }}</span>
              <span
                v-if="sortColumn === 'count'"
                class="sort-caret"
                :class="sortOrder"
                aria-hidden="true"
              ></span>
            </bubbleBoxTrigger>
            <div class="artist-header-cell artist-header-cell--action"></div>
          </div>
          <div class="list-scroll">
            <OverlayScrollbarsComponent
              :options="{
                scrollbars: {
                  autoHide: 'leave' as const,
                  autoHideDelay: 50,
                  clickScroll: true
                } as const,
                overflow: {
                  x: 'hidden',
                  y: 'scroll'
                } as const
              }"
              element="div"
              style="height: 100%; width: 100%"
              defer
            >
              <div v-if="entries.length === 0" class="empty-state">
                {{ t('settings.curatedArtistTracking.managerEmpty') }}
              </div>
              <div v-else-if="displayedEntries.length === 0" class="empty-state">
                {{ searchEmptyText }}
              </div>
              <div v-else class="artist-list">
                <div
                  v-for="(entry, index) in displayedEntries"
                  :key="entry.id"
                  class="artist-row artist-grid"
                >
                  <div class="artist-index">{{ index + 1 }}</div>
                  <input
                    :ref="(el) => setInputRef(entry.id, el)"
                    v-model="entry.name"
                    class="artist-input"
                    :class="{ 'artist-input--invalid': invalidEntryIds.includes(entry.id) }"
                    :placeholder="t('settings.curatedArtistTracking.managerInputPlaceholder')"
                    @focus="focusedEntryId = entry.id"
                    @blur="focusedEntryId = ''"
                    @input="clearValidationState()"
                  />
                  <bubbleBoxTrigger
                    tag="div"
                    class="artist-count"
                    :title="
                      t('settings.curatedArtistTracking.managerAddedCountTitle', {
                        artist:
                          entry.name || t('settings.curatedArtistTracking.managerUnnamedArtist'),
                        count: entry.count
                      })
                    "
                  >
                    {{
                      t('settings.curatedArtistTracking.managerAddedCount', { count: entry.count })
                    }}
                  </bubbleBoxTrigger>
                  <div class="dangerButton artist-delete" @click="removeEntry(entry.id)">
                    {{ t('common.delete') }}
                  </div>
                </div>
              </div>
            </OverlayScrollbarsComponent>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" style="width: 110px; text-align: center" @click="clickSave()">
          {{ t('common.save') }}
        </div>
        <div class="button" style="width: 110px; text-align: center" @click="clickCancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 700px;
  height: 540px;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 18px 18px;
  gap: 12px;
}

.toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.toolbar-title {
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
}

.toolbar-subtitle {
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 12px;
}

.toolbar-button {
  flex: 0 0 auto;
  width: 116px;
  text-align: center;
}

.error-slot {
  min-height: 18px;
}

.error-text {
  color: #e81123;
  font-size: 12px;
  line-height: 18px;
}

.error-text--hidden {
  visibility: hidden;
}

.list-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  overflow: hidden;
}

.list-scroll {
  flex: 1;
  min-height: 0;
}

.search-bar {
  flex: 0 0 auto;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}

.search-input-wrapper {
  position: relative;
}

.search-input {
  width: 100%;
  height: 30px;
  line-height: 30px;
  background: var(--bg);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 6px;
  padding: 0 28px 0 10px;
  box-sizing: border-box;
  font-size: 13px;

  &:hover {
    background: var(--hover);
    border-color: var(--accent);
  }

  &:focus {
    background: var(--bg);
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
}

.search-input-wrapper:hover .search-input:not(:focus) {
  background: var(--hover);
  border-color: var(--accent);
}

.search-clear {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  cursor: pointer;

  &:hover {
    color: var(--text);
  }
}

.artist-grid {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 104px 88px;
  align-items: center;
  gap: 10px;
}

.artist-header {
  flex: 0 0 auto;
  padding: 0 10px;
  height: 32px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}

.artist-header-cell {
  min-width: 0;
  display: flex;
  align-items: center;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 32px;
  user-select: none;
  white-space: nowrap;
}

.artist-header-cell--index {
  justify-content: center;
}

.artist-header-cell--count {
  justify-content: center;
}

.artist-header-cell--sortable {
  cursor: pointer;
  border-radius: 6px;
  padding: 0 6px;
  margin: 0 -6px;
  height: 24px;
  line-height: 24px;

  &:hover {
    color: var(--text);
    background: var(--hover);
  }
}

.artist-header-cell--active {
  color: var(--accent);
  font-weight: 600;

  &:hover {
    color: var(--accent);
  }
}

.sort-caret {
  flex: 0 0 auto;
  width: 0;
  height: 0;
  margin-left: 6px;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
}

.sort-caret.asc {
  border-bottom: 5px solid currentColor;
}

.sort-caret.desc {
  border-top: 5px solid currentColor;
}

.artist-list {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.artist-row > * {
  min-width: 0;
}

.artist-index {
  height: 30px;
  line-height: 30px;
  text-align: center;
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text-secondary);
  font-size: 12px;
  border: 1px solid var(--border);
}

.artist-input {
  width: 100%;
  min-width: 0;
  height: 30px;
  line-height: 30px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 6px;
  padding: 0 10px;
  box-sizing: border-box;

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
}

.artist-input--invalid {
  border-color: #e81123;
  box-shadow: 0 0 0 2px rgba(232, 17, 35, 0.16);
}

.artist-count {
  height: 30px;
  line-height: 30px;
  border-radius: 6px;
  background: rgba(200, 162, 60, 0.12);
  border: 1px solid rgba(200, 162, 60, 0.3);
  color: #c4a14a;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  padding: 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artist-delete {
  width: 100%;
  height: 30px;
  line-height: 30px;
  text-align: center;
  box-sizing: border-box;
  white-space: nowrap;
  border-radius: 6px;
  background: var(--hover);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;

  &:hover {
    color: #ffffff;
    background-color: #e81123;
    border-color: #e81123;
  }
}

.empty-state {
  height: 100%;
  min-height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 24px;
}

:global(.theme-light) .artist-count {
  color: #8a6408;
  background: rgba(200, 162, 60, 0.16);
  border-color: rgba(200, 162, 60, 0.42);
}

@media (max-width: 720px) {
  .inner {
    width: min(700px, 94vw);
    height: min(540px, 82vh);
  }

  .artist-grid {
    grid-template-columns: 32px minmax(0, 1fr) 92px 80px;
  }
}
</style>
