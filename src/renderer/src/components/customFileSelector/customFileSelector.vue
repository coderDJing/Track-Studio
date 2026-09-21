<script setup lang="ts">
import { nextTick, onUnmounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useCustomFileSelector } from './useCustomFileSelector'
import { useFixedVirtualList } from './useFixedVirtualList'
import type {
  CustomFileSelectorEmits,
  CustomFileSelectorProps,
  FileSystemItem,
  SelectedItem
} from './types'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

const FILE_ROW_HEIGHT = 28
const SELECTED_ROW_HEIGHT = 40

const props = withDefaults(defineProps<CustomFileSelectorProps>(), {
  visible: false,
  multiSelect: true,
  allowMixedSelection: true,
  initialSelectedPaths: () => []
})
const emit = defineEmits<CustomFileSelectorEmits>()

const {
  visible,
  currentPath,
  selectedItems,
  searchQuery,
  isLoading,
  filteredTree,
  selectedCount,
  selectedFilesCount,
  selectedFoldersCount,
  scrollbarOptions,
  handleItemClick,
  handleItemDoubleClick,
  handleKeyDown,
  removeSelectionByPath,
  clearSelection,
  confirm,
  cancel,
  modalRef,
  formatFileSize,
  getItemIcon,
  getItemSize,
  requestFileSizes,
  navigateUp,
  isDrive,
  isItemSelected,
  setScrollToIndexHandler
} = useCustomFileSelector(props, emit)

const fileScrollRef = useTemplateRef<OverlayScrollbarsComponentRef>('fileScrollRef')
const selectedScrollRef = useTemplateRef<OverlayScrollbarsComponentRef>('selectedScrollRef')
const fileVirtual = useFixedVirtualList(filteredTree, {
  rowHeight: FILE_ROW_HEIGHT,
  overscan: 12,
  fallbackVisibleRows: 18
})
const selectedVirtual = useFixedVirtualList(selectedItems, {
  rowHeight: SELECTED_ROW_HEIGHT,
  overscan: 8,
  fallbackVisibleRows: 12
})
const tooltipAnchor = shallowRef<HTMLElement | null>(null)
const tooltipTitle = ref('')

const attachFileViewport = async () => {
  await nextTick()
  fileVirtual.attachViewport(
    fileScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined
  )
}

const attachSelectedViewport = async () => {
  await nextTick()
  selectedVirtual.attachViewport(
    selectedScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined
  )
}

const setTooltip = (event: MouseEvent, title: string) => {
  tooltipAnchor.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  tooltipTitle.value = title
}

const clearTooltip = () => {
  tooltipAnchor.value = null
  tooltipTitle.value = ''
}

const handleRemoveSelectedItem = (path: string) => {
  clearTooltip()
  removeSelectionByPath(path)
}

const formatItemSize = (item: FileSystemItem) => {
  const size = getItemSize(item)
  return typeof size === 'number' ? formatFileSize(size) : '-'
}

const isSpecialItem = (item: FileSystemItem) => Boolean(item.isSpecial)
const getSelectedItemIcon = (item: SelectedItem) => getItemIcon(item)

setScrollToIndexHandler(fileVirtual.scrollToIndex)

watch(
  fileVirtual.visibleEntries,
  (entries) => {
    void requestFileSizes(entries.map((entry) => entry.item))
  },
  { immediate: true }
)

watch(searchQuery, () => {
  fileVirtual.resetScroll()
  clearTooltip()
})

watch(visible, (isVisible) => {
  if (!isVisible) {
    fileVirtual.attachViewport(null)
    selectedVirtual.attachViewport(null)
    clearTooltip()
  }
})

onUnmounted(() => {
  setScrollToIndexHandler(null)
})
</script>

<template>
  <div v-if="visible" class="dialog unselectable file-selector-dialog dialog-visible">
    <div
      ref="modalRef"
      v-dialog-drag="'.dialog-title'"
      class="inner file-selector-modal"
      tabindex="0"
      @keydown="handleKeyDown"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t('fileSelector.title') }}</span>
      </div>
      <div class="file-selector-content">
        <div class="path-navigation">
          <div class="path-breadcrumb">
            <button class="back-button" type="button" :disabled="!currentPath" @click="navigateUp">
              {{ t('fileSelector.navigateUp') }}
            </button>
            <bubbleBoxTrigger
              v-if="currentPath"
              tag="span"
              class="path-current"
              :title="currentPath"
            >
              {{ currentPath }}
            </bubbleBoxTrigger>
            <span v-else class="path-current">{{ t('fileSelector.rootLabel') }}</span>
          </div>
          <div class="path-search">
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="t('fileSelector.searchPlaceholder')"
              class="search-input"
            />
          </div>
        </div>

        <div class="main-content">
          <div class="file-list-container">
            <div class="file-list-header">
              <span class="header-name">{{ t('fileSelector.name') }}</span>
              <span class="header-size">{{ t('fileSelector.size') }}</span>
              <span class="header-type">{{ t('fileSelector.type') }}</span>
            </div>

            <div v-if="isLoading" class="loading-state">
              <div class="loading-spinner"></div>
              <span>{{ t('fileSelector.loading') }}</span>
            </div>

            <OverlayScrollbarsComponent
              v-else
              ref="fileScrollRef"
              :options="scrollbarOptions"
              element="div"
              class="file-list"
              defer
              @os-initialized="attachFileViewport"
              @os-destroyed="fileVirtual.attachViewport(null)"
              @os-scroll="clearTooltip"
            >
              <div
                class="virtual-list-space"
                :style="{ height: `${fileVirtual.totalHeight.value}px` }"
              >
                <div
                  class="virtual-list-window"
                  :style="{ transform: `translateY(${fileVirtual.offsetTop.value}px)` }"
                >
                  <div
                    v-for="entry in fileVirtual.visibleEntries.value"
                    :key="entry.item.path"
                    class="file-item-wrapper"
                  >
                    <div
                      class="file-item"
                      :class="{
                        'is-directory': entry.item.type === 'directory',
                        'is-file': entry.item.type === 'file',
                        'is-selected': isItemSelected(entry.item)
                      }"
                      :data-index="entry.index"
                      :data-path="entry.item.path"
                      @click="handleItemClick(entry.item, entry.index, $event)"
                      @dblclick="
                        entry.item.type === 'directory'
                          ? handleItemDoubleClick(entry.item, $event)
                          : null
                      "
                    >
                      <div class="item-icon">
                        <img :src="getItemIcon(entry.item)" alt="" />
                      </div>
                      <div class="item-name-wrapper">
                        <div class="item-name" @mouseenter="setTooltip($event, entry.item.name)">
                          {{ entry.item.name }}
                        </div>
                      </div>
                      <div class="item-size">{{ formatItemSize(entry.item) }}</div>
                      <div v-if="entry.item.type === 'file'" class="item-type">
                        {{ entry.item.name.split('.').pop()?.toUpperCase() }}
                      </div>
                      <div v-else class="item-type">
                        {{
                          isSpecialItem(entry.item)
                            ? t('fileSelector.commonFolder')
                            : isDrive(entry.item)
                              ? t('fileSelector.drive')
                              : t('fileSelector.folder')
                        }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </OverlayScrollbarsComponent>
          </div>

          <div class="selected-panel">
            <div class="selected-header">
              <h4 class="selected-title">
                {{ t('fileSelector.selectedItems') }}
                <span class="selected-count">({{ selectedCount }})</span>
              </h4>
              <button class="clear-btn" :disabled="selectedCount === 0" @click="clearSelection">
                {{ t('fileSelector.clearAll') }}
              </button>
            </div>

            <div class="selected-stats">
              <span v-if="selectedFilesCount > 0" class="stat-item">
                {{ t('fileSelector.filesSelected', { count: selectedFilesCount }) }}
              </span>
              <span v-if="selectedFoldersCount > 0" class="stat-item">
                {{ t('fileSelector.foldersSelected', { count: selectedFoldersCount }) }}
              </span>
            </div>

            <OverlayScrollbarsComponent
              v-if="selectedCount > 0"
              ref="selectedScrollRef"
              :options="scrollbarOptions"
              element="div"
              class="selected-list"
              defer
              @os-initialized="attachSelectedViewport"
              @os-destroyed="selectedVirtual.attachViewport(null)"
              @os-scroll="clearTooltip"
            >
              <div
                class="virtual-list-space"
                :style="{ height: `${selectedVirtual.totalHeight.value}px` }"
              >
                <div
                  class="virtual-list-window"
                  :style="{ transform: `translateY(${selectedVirtual.offsetTop.value}px)` }"
                >
                  <div
                    v-for="entry in selectedVirtual.visibleEntries.value"
                    :key="entry.item.path"
                    class="selected-item-wrapper"
                  >
                    <div class="selected-item">
                      <div class="selected-icon">
                        <img :src="getSelectedItemIcon(entry.item)" alt="" />
                      </div>
                      <div class="selected-info">
                        <div
                          class="selected-name"
                          @mouseenter="setTooltip($event, entry.item.name)"
                        >
                          {{ entry.item.name }}
                        </div>
                        <div
                          class="selected-path"
                          @mouseenter="setTooltip($event, entry.item.path)"
                        >
                          {{ entry.item.path }}
                        </div>
                      </div>
                      <button class="remove-btn" @click="handleRemoveSelectedItem(entry.item.path)">
                        ×
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </OverlayScrollbarsComponent>

            <div v-else class="empty-selection">
              {{ t('fileSelector.noSelection') }}
            </div>
          </div>
        </div>

        <div class="action-bar">
          <div class="action-buttons import-dialog-style">
            <div
              class="button"
              style="margin-right: 10px; width: 90px; text-align: center"
              @click="confirm"
            >
              {{ t('common.confirm') }} (E)
            </div>
            <div class="button" style="width: 90px; text-align: center" @click="cancel">
              {{ t('common.cancel') }} (Esc)
            </div>
          </div>
        </div>
      </div>
      <bubbleBox :dom="tooltipAnchor || undefined" :title="tooltipTitle" :max-width="320" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.file-selector-dialog {
  z-index: var(--z-dialog-raised);
}

.file-selector-modal {
  width: 700px;
  height: 450px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  user-select: none;
  -webkit-user-select: none;
  color: var(--text);
}

.file-selector-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 路径导航 */
.path-navigation {
  padding: 10px 12px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;

  .path-breadcrumb {
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0; // 允许内容收缩，避免把右侧搜索框挤出
    font-size: 12px;
    color: var(--text);
    gap: 8px;

    .back-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-elev);
      color: var(--text);
      font-size: 12px;
      cursor: pointer;
      transition:
        background-color 0.2s,
        border-color 0.2s;
      min-width: 80px;

      &:hover:not(:disabled) {
        background: var(--hover);
        border-color: var(--accent);
        color: var(--text);
      }

      &:disabled {
        cursor: not-allowed;
        background: var(--bg);
        color: var(--text-weak);
        border-color: var(--border);
      }
    }

    .path-current {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .path-search {
    flex: 0 0 auto; // 固定宽度区域，不随父容器收缩
    flex-shrink: 0;
    .search-input {
      width: 160px;
      height: 25px;
      padding: 0 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      background: var(--bg-elev);
      color: var(--text);

      &:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
      }

      &::placeholder {
        color: var(--text-weak);
      }
    }
  }
}

/* 主要内容区域 */
.main-content {
  flex: 1;
  display: flex;
  min-height: 0;
  height: 100%;
}

.virtual-list-space {
  position: relative;
  width: 100%;
}

.virtual-list-window {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  will-change: transform;
}

/* 文件列表 */
.file-list-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  min-width: 0; /* 防止flex项目溢出 */
  width: 0; /* 确保flex项目占用剩余空间 */

  .file-list-header {
    display: flex;
    padding: 6px 12px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 500;
    color: var(--text-weak);
    text-transform: uppercase;

    span {
      flex: 1;
      min-width: 0;

      &:first-child {
        flex: 1;
        min-width: 200px; // 文件名列最小宽度
      }

      &:nth-child(2) {
        flex: 0 0 80px;
        text-align: right;
        min-width: 80px;
      }

      &:nth-child(3) {
        flex: 0 0 80px;
        text-align: right;
        min-width: 80px;
      }
    }
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-weak);
    font-size: 14px;

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--hover);
      border-top: 3px solid var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 12px;
    }
  }

  .file-list {
    flex: 1;
    height: 100%;
    padding: 2px 0;
    overflow: hidden;

    .file-item-wrapper {
      width: 100%;
      height: 28px;
    }

    .file-item {
      display: flex;
      align-items: center;
      height: 28px;
      padding: 4px 12px;
      box-sizing: border-box;
      cursor: default;
      border-bottom: 1px solid var(--border);
      transition: background-color 0.2s;

      &:hover {
        background-color: var(--hover);
      }

      &.is-selected {
        background-color: var(--hover);
        border-color: var(--accent);
      }

      .item-icon {
        flex: 0 0 18px;
        text-align: center;
        margin-right: 8px;
        font-size: 14px;

        img {
          width: 18px;
          height: 18px;
          object-fit: contain;
          display: block;
          filter: brightness(0.85);
        }
      }

      .item-name-wrapper {
        flex: 1;
        min-width: 200px;
        max-width: 300px;
        margin-right: 8px;
      }

      .item-name {
        font-size: 12px;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .item-size {
        flex: 0 0 80px;
        text-align: right;
        font-size: 11px;
        color: var(--text-weak);
        min-width: 80px;
      }

      .item-type {
        flex: 0 0 80px;
        text-align: right;
        font-size: 10px;
        color: var(--text-weak);
        text-transform: uppercase;
        min-width: 80px;
      }
    }
  }
}

/* 选中项目面板 */
.selected-panel {
  width: 200px;
  background: var(--bg-elev);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;

  .selected-header {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;

    .selected-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      margin: 0;

      .selected-count {
        color: var(--accent);
        font-weight: normal;
      }
    }

    .clear-btn {
      height: 20px;
      line-height: 20px;
      padding: 0 8px;
      border-radius: 4px;
      background-color: #dc3545;
      color: #ffffff;
      border: none;
      font-size: 11px;
      cursor: pointer;
      transition: background-color 0.2s;

      &:hover:not(:disabled) {
        background: #c82333;
      }

      &:disabled {
        background: var(--hover);
        color: var(--text-secondary);
        cursor: not-allowed;
      }
    }
  }

  .selected-stats {
    padding: 6px 10px;
    background: var(--bg-elev);
    font-size: 11px;
    color: var(--text-weak);

    .stat-item {
      display: inline-block;
      margin-right: 8px;

      &:last-child {
        margin-right: 0;
      }
    }
  }

  .selected-list {
    flex: 1;
    height: 100%;
    padding: 6px;
    overflow: hidden;

    .selected-item-wrapper {
      height: 40px;
    }

    .selected-item {
      display: flex;
      align-items: center;
      height: 37px;
      padding: 4px 6px;
      margin-bottom: 3px;
      box-sizing: border-box;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 3px;
      cursor: default;
      gap: 4px;

      .selected-icon {
        flex: 0 0 16px;
        text-align: center;
        margin-right: 6px;
        font-size: 12px;

        img {
          width: 16px;
          height: 16px;
          object-fit: contain;
          display: block;
          filter: brightness(0.85);
        }
      }

      .selected-info {
        flex: 1;
        min-width: 0;

        .selected-name {
          font-size: 11px;
          font-weight: 500;
          color: var(--text);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .selected-path {
          font-size: 9px;
          color: var(--text-weak);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }

      .remove-btn {
        flex: 0 0 auto;
        background: none;
        border: none;
        color: #dc3545;
        cursor: pointer;
        font-size: 12px;
        padding: 0;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          color: #ff6b81;
        }
      }
    }
  }

  .empty-selection {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-weak);
    font-size: 12px;
    font-style: italic;
  }
}

/* 操作栏 */
.action-bar {
  padding: 8px 12px;
  background: var(--bg-elev);
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: center;
  align-items: center;

  .action-buttons {
    display: flex;
    gap: 8px;

    .cancel-btn {
      height: 25px;
      line-height: 25px;
      padding: 0 10px;
      border-radius: 5px;
      background-color: var(--hover);
      color: var(--text);
      border: 1px solid var(--border);
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        color: #ffffff;
        background-color: var(--accent);
        border-color: var(--accent);
      }
    }

    .confirm-btn {
      height: 25px;
      line-height: 25px;
      padding: 0 10px;
      border-radius: 5px;
      background-color: var(--hover);
      color: var(--text);
      border: 1px solid var(--border);
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;

      &:hover:not(:disabled) {
        color: #ffffff;
        background-color: var(--accent);
        border-color: var(--accent);
      }

      &:disabled {
        background: var(--bg);
        cursor: not-allowed;
        color: var(--text-secondary);
        border-color: var(--border);
      }
    }
  }
}

/* 动画 */
@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>
