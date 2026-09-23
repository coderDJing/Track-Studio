import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import {
  getCachedRekordboxSourceTree,
  getRememberedRekordboxSourceSelectedPlaylist,
  setCachedRekordboxSourceTree,
  shouldRefreshRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import type { ExternalLibraryKind, ExternalLibrarySourceProbe } from '@shared/externalLibrary'
import { t } from '@renderer/utils/translate'
import type { IPioneerPlaylistTreeNode } from '../../../../../types/globals'

type HoverableIcon = {
  name: string
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}

export type ExternalDjSourceIcon = HoverableIcon & {
  key: string
  kind: ExternalLibraryKind
  sourcePath: string
  tooltip: string
}

type Options = {
  runtime: ReturnType<typeof useRuntimeStore>
  seratoIconAsset: string
  updateSelectedIcon: (item: HoverableIcon | undefined) => void
  emitLibrarySelectedChange: (payload: { name: string }) => void
}

type ExternalLibraryTreeResult = {
  treeNodes?: IPioneerPlaylistTreeNode[]
  sourceName?: string
}

const SOURCE_REFRESH_INTERVAL_MS = 60_000

const buildExternalSourceCacheKey = (item: ExternalDjSourceIcon) =>
  `external-library::${item.kind}::${item.key || item.sourcePath}`

const containsPlaylist = (nodes: IPioneerPlaylistTreeNode[], playlistId: number): boolean => {
  if (!playlistId) return false
  for (const node of nodes) {
    if (!node.isFolder && node.id === playlistId) return true
    if (containsPlaylist(node.children || [], playlistId)) return true
  }
  return false
}

export function useExternalDjSourceIcons(options: Options) {
  const sourceIcons = ref<ExternalDjSourceIcon[]>([])
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let refreshInFlight: Promise<void> | null = null
  let treeRequestToken = 0

  const clearExternalSelection = () => {
    options.runtime.externalDjLibrary.selectedKind = null
    options.runtime.externalDjLibrary.selectedSourceKey = ''
    options.runtime.externalDjLibrary.selectedSourcePath = ''
    options.runtime.pioneerDeviceLibrary.selectedSourceKey = ''
    options.runtime.pioneerDeviceLibrary.selectedSourceName = ''
    options.runtime.pioneerDeviceLibrary.selectedSourceRootPath = ''
    options.runtime.pioneerDeviceLibrary.selectedSourceKind = ''
    options.runtime.pioneerDeviceLibrary.selectedLibraryType = ''
    options.runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
    options.runtime.pioneerDeviceLibrary.loading = false
    options.runtime.pioneerDeviceLibrary.treeNodes = []
  }

  const refreshSourceIcons = async () => {
    if (refreshInFlight) return await refreshInFlight
    const task = (async () => {
      const probes = (await window.electron.ipcRenderer.invoke(
        'external-library:probe'
      )) as ExternalLibrarySourceProbe[]
      sourceIcons.value = (Array.isArray(probes) ? probes : [])
        .filter((probe) => probe?.kind === 'serato' && probe.available && probe.sourcePath)
        .map((probe) => {
          const iconSrc = options.seratoIconAsset
          const tooltip = t('library.seratoLibrary')
          return {
            key: probe.sourceKey,
            kind: 'serato',
            sourcePath: probe.sourcePath,
            name: tooltip,
            tooltip,
            grey: iconSrc,
            white: iconSrc,
            src: iconSrc,
            showAlt: false
          }
        })

      const selectedKey = options.runtime.externalDjLibrary.selectedSourceKey
      if (
        options.runtime.externalDjLibrary.selectedKind === 'traktor' ||
        (selectedKey && !sourceIcons.value.some((item) => item.key === selectedKey))
      ) {
        clearExternalSelection()
        if (options.runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
          options.runtime.libraryAreaSelected = 'FilterLibrary'
          options.emitLibrarySelectedChange({ name: 'FilterLibrary' })
        }
      }
    })()
    refreshInFlight = task
    try {
      await task
    } finally {
      if (refreshInFlight === task) refreshInFlight = null
    }
  }

  const isCurrentSource = (item: ExternalDjSourceIcon) =>
    options.runtime.libraryAreaSelected === 'PioneerDeviceLibrary' &&
    options.runtime.externalDjLibrary.selectedKind === item.kind &&
    options.runtime.externalDjLibrary.selectedSourceKey === item.key &&
    options.runtime.pioneerDeviceLibrary.selectedSourceKey === item.key

  const applyTreeResult = (
    item: ExternalDjSourceIcon,
    result: ExternalLibraryTreeResult,
    preferredPlaylistId: number,
    cacheKey: string
  ) => {
    const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
    const currentPlaylistId = Number(options.runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
    const nextPlaylistId = containsPlaylist(treeNodes, currentPlaylistId)
      ? currentPlaylistId
      : containsPlaylist(treeNodes, preferredPlaylistId)
        ? preferredPlaylistId
        : 0
    setCachedRekordboxSourceTree(cacheKey, treeNodes, { selectedPlaylistId: nextPlaylistId })
    if (!isCurrentSource(item)) return
    options.runtime.pioneerDeviceLibrary.treeNodes = treeNodes
    options.runtime.pioneerDeviceLibrary.selectedPlaylistId = nextPlaylistId
    options.runtime.pioneerDeviceLibrary.selectedSourceName = result.sourceName || item.tooltip
  }

  const clickSourceIcon = async (item: ExternalDjSourceIcon) => {
    const requestToken = ++treeRequestToken
    const cacheKey = buildExternalSourceCacheKey(item)
    const cachedTree = getCachedRekordboxSourceTree(cacheKey)
    const preferredPlaylistId =
      options.runtime.externalDjLibrary.selectedSourceKey === item.key
        ? Number(options.runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        : getRememberedRekordboxSourceSelectedPlaylist(cacheKey)
    const restoredPlaylistId =
      cachedTree && containsPlaylist(cachedTree.treeNodes, preferredPlaylistId)
        ? preferredPlaylistId
        : 0

    options.runtime.externalDjLibrary.selectedKind = item.kind
    options.runtime.externalDjLibrary.selectedSourceKey = item.key
    options.runtime.externalDjLibrary.selectedSourcePath = item.sourcePath
    options.runtime.pioneerDeviceLibrary.selectedSourceKey = item.key
    options.runtime.pioneerDeviceLibrary.selectedSourceName = item.tooltip
    options.runtime.pioneerDeviceLibrary.selectedSourceRootPath = item.sourcePath
    options.runtime.pioneerDeviceLibrary.selectedSourceKind = ''
    options.runtime.pioneerDeviceLibrary.selectedLibraryType = ''
    options.runtime.pioneerDeviceLibrary.selectedPlaylistId = restoredPlaylistId
    options.runtime.pioneerDeviceLibrary.loading = !cachedTree
    options.runtime.pioneerDeviceLibrary.treeNodes = cachedTree?.treeNodes || []
    options.runtime.songsArea.songListUUID = ''
    options.runtime.libraryAreaSelected = 'PioneerDeviceLibrary'
    options.updateSelectedIcon(item)
    options.emitLibrarySelectedChange({ name: 'PioneerDeviceLibrary' })

    if (cachedTree && !shouldRefreshRekordboxSourceTree(cacheKey)) return

    try {
      const result = (await window.electron.ipcRenderer.invoke('external-library:load-tree', {
        kind: item.kind,
        path: item.sourcePath
      })) as ExternalLibraryTreeResult
      if (requestToken !== treeRequestToken) return
      applyTreeResult(item, result, preferredPlaylistId, cacheKey)
    } catch (error) {
      if (requestToken !== treeRequestToken || !isCurrentSource(item)) return
      if (!cachedTree) {
        options.runtime.pioneerDeviceLibrary.treeNodes = []
        options.runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
        await confirm({
          title: t('common.error'),
          content: [error instanceof Error ? error.message : String(error)],
          confirmShow: false
        })
      }
    } finally {
      if (requestToken === treeRequestToken && isCurrentSource(item)) {
        options.runtime.pioneerDeviceLibrary.loading = false
      }
    }
  }

  const isSelectedSourceIcon = (item: ExternalDjSourceIcon) => isCurrentSource(item)

  const selectedExternalSourceKey = computed(() => {
    if (options.runtime.libraryAreaSelected !== 'PioneerDeviceLibrary') return ''
    return options.runtime.externalDjLibrary.selectedSourceKey
  })

  const handleWindowFocus = () => void refreshSourceIcons()

  onMounted(() => {
    void refreshSourceIcons()
    refreshTimer = setInterval(() => void refreshSourceIcons(), SOURCE_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', handleWindowFocus)
  })

  onUnmounted(() => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
    window.removeEventListener('focus', handleWindowFocus)
  })

  watch(selectedExternalSourceKey, (sourceKey) => {
    if (!sourceKey) return
    options.updateSelectedIcon(sourceIcons.value.find((item) => item.key === sourceKey))
  })

  return {
    sourceIcons,
    refreshSourceIcons,
    clickSourceIcon,
    isSelectedSourceIcon
  }
}
