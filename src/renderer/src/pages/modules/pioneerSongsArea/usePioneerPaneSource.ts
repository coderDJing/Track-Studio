import { computed } from 'vue'
import type { ISongsAreaPaneRuntimeState } from '@renderer/stores/runtime'
import { buildRekordboxSourceCacheKey } from '@renderer/utils/rekordboxLibraryCache'
import { t } from '@renderer/utils/translate'
import type { IPioneerPlaylistTreeNode } from 'src/types/globals'

export function usePioneerPaneSource(state: ISongsAreaPaneRuntimeState) {
  const initialSource = state.djPlaylist!
  const source = computed(() => state.djPlaylist || initialSource)
  const browser = computed(() => source.value.browser)
  const selectedSourceKey = computed(() => browser.value.selectedSourceKey)
  const selectedSourceKind = computed(() => browser.value.selectedSourceKind)
  const selectedExternalKind = computed(() => source.value.externalKind)
  const isExternalSource = computed(() => Boolean(selectedExternalKind.value))
  const isSeratoSource = computed(() => selectedExternalKind.value === 'serato')
  const isTraktorSource = computed(() => selectedExternalKind.value === 'traktor')
  const isDesktopSource = computed(() => selectedSourceKind.value === 'desktop')
  const selectedSourceName = computed(
    () =>
      browser.value.selectedSourceName ||
      (isTraktorSource.value
        ? t('library.traktorLibrary')
        : isSeratoSource.value
          ? t('library.seratoLibrary')
          : isDesktopSource.value
            ? t('pioneer.desktopLibraryName')
            : 'Pioneer USB')
  )
  const selectedPlaylistId = computed(() => browser.value.selectedPlaylistId)
  const selectedSourceRootPath = computed(() => browser.value.selectedSourceRootPath)
  const selectedLibraryType = computed(() => browser.value.selectedLibraryType || 'deviceLibrary')
  const treeNodes = computed(() => browser.value.treeNodes)
  const selectedPlaylistNode = computed(() => {
    const walk = (nodes: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode | null => {
      for (const node of nodes) {
        if (node.id === selectedPlaylistId.value) return node
        const found = node.children?.length ? walk(node.children) : null
        if (found) return found
      }
      return null
    }
    return walk(treeNodes.value)
  })
  const canEditUsbPlaylist = computed(
    () =>
      selectedSourceKind.value === 'usb' &&
      !isExternalSource.value &&
      Boolean(selectedPlaylistNode.value) &&
      !selectedPlaylistNode.value?.isFolder &&
      !selectedPlaylistNode.value?.isSmartPlaylist &&
      (selectedLibraryType.value === 'deviceLibrary' || selectedLibraryType.value === 'oneLibrary')
  )
  const currentPlaybackListKey = computed(() => state.songListUUID)
  const selectedSourceCacheKey = computed(() =>
    selectedExternalKind.value && selectedSourceKey.value
      ? `external-library::${selectedExternalKind.value}::${selectedSourceKey.value}`
      : buildRekordboxSourceCacheKey({
          sourceKind: selectedSourceKind.value,
          sourceKey: selectedSourceKey.value,
          rootPath: selectedSourceRootPath.value,
          libraryType: selectedLibraryType.value
        })
  )
  return {
    browser,
    selectedSourceKey,
    selectedSourceKind,
    selectedExternalKind,
    isExternalSource,
    isSeratoSource,
    isTraktorSource,
    isDesktopSource,
    selectedSourceName,
    selectedPlaylistId,
    selectedSourceRootPath,
    selectedLibraryType,
    selectedPlaylistNode,
    canEditUsbPlaylist,
    currentPlaybackListKey,
    selectedSourceCacheKey,
    treeNodes
  }
}
