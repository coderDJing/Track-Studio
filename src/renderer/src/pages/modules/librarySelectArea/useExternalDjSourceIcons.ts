import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import {
  getCachedRekordboxSourceTree,
  getRememberedRekordboxSourceSelectedPlaylist,
  setCachedRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import type { ExternalLibraryKind, ExternalLibrarySourceProbe } from '@shared/externalLibrary'
import { t } from '@renderer/utils/translate'
import emitter from '@renderer/utils/mitt'
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
  traktorIconAsset: string
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

const findPlaylistExternalId = (nodes: IPioneerPlaylistTreeNode[], playlistId: number): string => {
  for (const node of nodes) {
    if (!node.isFolder && node.id === playlistId) return node.externalId || ''
    const nested = findPlaylistExternalId(node.children || [], playlistId)
    if (nested) return nested
  }
  return ''
}

const findPlaylistIdByExternalId = (
  nodes: IPioneerPlaylistTreeNode[],
  externalId: string
): number => {
  for (const node of nodes) {
    if (!node.isFolder && node.externalId === externalId) return node.id
    const nested = findPlaylistIdByExternalId(node.children || [], externalId)
    if (nested) return nested
  }
  return 0
}

export function useExternalDjSourceIcons(options: Options) {
  const sourceIcons = ref<ExternalDjSourceIcon[]>([])
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let refreshInFlight: Promise<void> | null = null
  let selectedSourceCheckInFlight: Promise<void> | null = null
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
      const nextIcons = (Array.isArray(probes) ? probes : [])
        .filter(
          (probe) =>
            (probe?.kind === 'serato' || probe?.kind === 'traktor') &&
            probe.available &&
            probe.sourcePath
        )
        .map((probe) => {
          const iconSrc =
            probe.kind === 'serato' ? options.seratoIconAsset : options.traktorIconAsset
          const tooltip = t(
            probe.kind === 'serato' ? 'library.seratoLibrary' : 'library.traktorLibrary'
          )
          return {
            key: probe.sourceKey,
            kind: probe.kind,
            sourcePath: probe.sourcePath,
            name: tooltip,
            tooltip,
            grey: iconSrc,
            white: iconSrc,
            src: iconSrc,
            showAlt: false
          }
        })
      if (JSON.stringify(sourceIcons.value) !== JSON.stringify(nextIcons)) {
        sourceIcons.value = nextIcons
      }

      const selectedKey = options.runtime.externalDjLibrary.selectedSourceKey
      if (selectedKey && !sourceIcons.value.some((item) => item.key === selectedKey)) {
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
    preferredExternalId: string,
    cacheKey: string,
    revision: string
  ) => {
    const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
    const currentPlaylistId = Number(options.runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
    const selectedExternalId =
      findPlaylistExternalId(options.runtime.pioneerDeviceLibrary.treeNodes, currentPlaylistId) ||
      preferredExternalId
    const nextPlaylistId = selectedExternalId
      ? findPlaylistIdByExternalId(treeNodes, selectedExternalId)
      : containsPlaylist(treeNodes, currentPlaylistId)
        ? currentPlaylistId
        : containsPlaylist(treeNodes, preferredPlaylistId)
          ? preferredPlaylistId
          : 0
    setCachedRekordboxSourceTree(cacheKey, treeNodes, {
      selectedPlaylistId: nextPlaylistId,
      revision
    })
    if (!isCurrentSource(item)) return
    if (
      JSON.stringify(options.runtime.pioneerDeviceLibrary.treeNodes) !== JSON.stringify(treeNodes)
    ) {
      options.runtime.pioneerDeviceLibrary.treeNodes = treeNodes
    }
    if (options.runtime.pioneerDeviceLibrary.selectedPlaylistId !== nextPlaylistId) {
      options.runtime.pioneerDeviceLibrary.selectedPlaylistId = nextPlaylistId
    }
    const nextSourceName = result.sourceName || item.tooltip
    if (options.runtime.pioneerDeviceLibrary.selectedSourceName !== nextSourceName) {
      options.runtime.pioneerDeviceLibrary.selectedSourceName = nextSourceName
    }
  }

  const clickSourceIcon = async (item: ExternalDjSourceIcon) => {
    const requestToken = ++treeRequestToken
    const alreadyCurrent = isCurrentSource(item)
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
    const preferredExternalId = findPlaylistExternalId(
      cachedTree?.treeNodes ||
        (isCurrentSource(item) ? options.runtime.pioneerDeviceLibrary.treeNodes : []),
      preferredPlaylistId
    )

    if (!alreadyCurrent) {
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
    }

    try {
      const revisionResult = (await window.electron.ipcRenderer.invoke(
        'external-library:source-revision',
        { kind: item.kind, path: item.sourcePath }
      )) as { revision?: string }
      const revision = String(revisionResult?.revision || '')
      if (cachedTree?.revision && cachedTree.revision === revision) return
      const result = (await window.electron.ipcRenderer.invoke('external-library:load-tree', {
        kind: item.kind,
        path: item.sourcePath
      })) as ExternalLibraryTreeResult
      if (requestToken !== treeRequestToken) return
      const selectedPlaylistIdBefore = options.runtime.pioneerDeviceLibrary.selectedPlaylistId
      applyTreeResult(item, result, preferredPlaylistId, preferredExternalId, cacheKey, revision)
      if (
        alreadyCurrent &&
        selectedPlaylistIdBefore > 0 &&
        options.runtime.pioneerDeviceLibrary.selectedPlaylistId === selectedPlaylistIdBefore
      ) {
        emitter.emit('dj-library:refresh-selected-playlist', {
          sourceKey: item.key,
          playlistId: options.runtime.pioneerDeviceLibrary.selectedPlaylistId
        })
      }
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
      if (
        requestToken === treeRequestToken &&
        isCurrentSource(item) &&
        options.runtime.pioneerDeviceLibrary.loading
      ) {
        options.runtime.pioneerDeviceLibrary.loading = false
      }
    }
  }

  const isSelectedSourceIcon = (item: ExternalDjSourceIcon) => isCurrentSource(item)

  const selectedExternalSourceKey = computed(() => {
    if (options.runtime.libraryAreaSelected !== 'PioneerDeviceLibrary') return ''
    return options.runtime.externalDjLibrary.selectedSourceKey
  })

  const handleWindowFocus = () => {
    if (selectedSourceCheckInFlight) return
    const task = refreshSourceIcons().then(async () => {
      const selected = sourceIcons.value.find((item) => isCurrentSource(item))
      if (selected) await clickSourceIcon(selected)
    })
    selectedSourceCheckInFlight = task
    void task
      .finally(() => {
        if (selectedSourceCheckInFlight === task) selectedSourceCheckInFlight = null
      })
      .catch((error) => console.error('[externalDjSourceIcons] refresh failed', error))
  }

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
