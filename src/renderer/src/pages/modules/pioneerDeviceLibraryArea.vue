<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import pioneerDeviceLibraryItem from '@renderer/components/pioneerDeviceLibraryItem.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import confirm from '@renderer/components/confirmDialog'
import openRekordboxDesktopCreateNodeDialog from '@renderer/components/rekordboxDesktopCreateNodeDialog'
import RekordboxDesktopWritingOverlay from '@renderer/components/RekordboxDesktopWritingOverlay.vue'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import {
  buildRekordboxSourceCacheKey,
  clearRekordboxSourceCachesByKind,
  setCachedRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import { copyPioneerNodeToLibrary } from '@renderer/composables/rekordboxDesktop/usePioneerCopyToLibrary'
import { copyPioneerPlaylistToMixtape } from '@renderer/composables/rekordboxDesktop/usePioneerCopyToMixtape'
import { importCuratedArtistsFromPioneerSource } from '@renderer/composables/rekordboxDesktop/useImportCuratedArtists'
import { usePioneerDeviceTreeDrag } from '@renderer/composables/rekordboxDesktop/usePioneerDeviceTreeDrag'
import { openSetDurationForRekordboxPlaylist } from '@renderer/utils/rekordboxPlaylistSetDuration'
import {
  collectRekordboxSimilarTracksSeeds,
  openBatchSimilarTracksDialogForSeeds
} from '@renderer/utils/similarTracksActions'
import {
  countNodeDescendants,
  findNodeById,
  isPlayablePlaylistNode,
  normalizeKeyword,
  sanitizeNodeName
} from '@renderer/composables/rekordboxDesktop/useRekordboxTreeUtils'
import type { IPioneerPlaylistTreeNode, IPioneerPlaylistTrack } from '../../../../types/globals'
import type { RekordboxSourceKind, RekordboxSourceLibraryType } from '@shared/rekordboxSources'
import type {
  RekordboxDesktopCreateEmptyPlaylistResponse,
  RekordboxDesktopCreateFolderResponse,
  RekordboxDesktopDeletePlaylistResponse,
  RekordboxDesktopRemovePlaylistTracksResponse,
  RekordboxDesktopRenamePlaylistResponse
} from '@shared/rekordboxDesktopPlaylist'

const runtime = useRuntimeStore()
const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')
const playlistSearch = ref('')
const expandedFolderIds = ref<Set<number>>(new Set())
const dialogWriting = ref(false)
const localLibraryCopying = ref(false)
const isDesktopSource = computed(
  () => runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop'
)
const isCopyableSource = computed(
  () =>
    runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop' ||
    runtime.pioneerDeviceLibrary.selectedSourceKind === 'usb'
)
const renameMenuKey = 'common.rename'
const deleteFolderMenuKey = 'rekordboxDesktop.deleteFolderAction'
const deletePlaylistMenuKey = 'playlist.deletePlaylist'

const title = computed(() => {
  if (runtime.pioneerDeviceLibrary.selectedSourceName) {
    return runtime.pioneerDeviceLibrary.selectedSourceName
  }
  return isDesktopSource.value ? t('pioneer.desktopLibraryName') : 'Pioneer USB'
})
const originalTreeNodes = computed(() => runtime.pioneerDeviceLibrary.treeNodes || [])

const runWithDialogWriting = async <T,>(task: () => Promise<T>): Promise<T> => {
  dialogWriting.value = true
  try {
    return await task()
  } finally {
    dialogWriting.value = false
  }
}

const runWithLocalLibraryCopying = async <T,>(task: () => Promise<T>): Promise<T> => {
  localLibraryCopying.value = true
  try {
    return await task()
  } finally {
    localLibraryCopying.value = false
  }
}

const syncRuntimeDesktopTree = (nodes: IPioneerPlaylistTreeNode[], preferredPlaylistId = 0) => {
  const sourceKey = String(runtime.pioneerDeviceLibrary.selectedSourceKey || '').trim()
  const rootPath = String(runtime.pioneerDeviceLibrary.selectedSourceRootPath || '').trim()
  if (!sourceKey || !rootPath) return

  const sourceCacheKey = buildRekordboxSourceCacheKey({
    sourceKind: 'desktop',
    sourceKey,
    rootPath,
    libraryType: runtime.pioneerDeviceLibrary.selectedLibraryType || 'masterDb'
  })
  setCachedRekordboxSourceTree(sourceCacheKey, nodes, {
    selectedPlaylistId: preferredPlaylistId
  })
  if (runtime.pioneerDeviceLibrary.selectedSourceKind !== 'desktop') return
  runtime.pioneerDeviceLibrary.treeNodes = nodes
  runtime.pioneerDeviceLibrary.selectedPlaylistId = preferredPlaylistId
}

const refreshDesktopTree = async (preferredPlaylistId = 0) => {
  const result = (await window.electron.ipcRenderer.invoke(
    buildRekordboxSourceChannel('desktop', 'load-tree')
  )) as {
    treeNodes?: IPioneerPlaylistTreeNode[]
  }
  const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
  const preferredNode =
    preferredPlaylistId > 0 ? findNodeById(treeNodes, preferredPlaylistId) : null
  const currentSelectedNode =
    Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) > 0
      ? findNodeById(treeNodes, Number(runtime.pioneerDeviceLibrary.selectedPlaylistId))
      : null
  const nextSelectedId =
    preferredPlaylistId > 0 && isPlayablePlaylistNode(preferredNode)
      ? preferredPlaylistId
      : isPlayablePlaylistNode(currentSelectedNode)
        ? Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        : 0
  syncRuntimeDesktopTree(treeNodes, nextSelectedId)
}

const showFailureDialog = async (message: string, logPath?: string) => {
  const content = [t('rekordboxDesktop.failedReason', { message })]
  if (logPath) {
    content.push(t('rekordboxDesktop.failureLogHint', { path: logPath }))
  }
  await confirm({
    title: t('rekordboxDesktop.failureTitle'),
    content,
    confirmShow: false,
    innerWidth: 620,
    innerHeight: 0,
    textAlign: 'left',
    canCopyText: Boolean(logPath)
  })
}

const getDialogErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) {
    const message = String(error.message || '').trim()
    return message || fallback
  }
  return String(error || fallback)
}

const filterTreeByPlaylistName = (
  nodes: IPioneerPlaylistTreeNode[],
  keyword: string
): IPioneerPlaylistTreeNode[] => {
  const normalizedKeyword = keyword.trim().toLowerCase()
  if (!normalizedKeyword) return nodes

  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode[] => {
    const result: IPioneerPlaylistTreeNode[] = []
    for (const item of items) {
      const children = Array.isArray(item.children) ? walk(item.children) : []
      if (item.isFolder) {
        if (children.length > 0) {
          result.push({
            ...item,
            children
          })
        }
        continue
      }
      if (item.name.toLowerCase().includes(normalizedKeyword)) {
        result.push({
          ...item,
          children: []
        })
      }
    }
    return result
  }

  return walk(nodes)
}

const visibleTreeNodes = computed(() =>
  filterTreeByPlaylistName(originalTreeNodes.value, String(playlistSearch.value || ''))
)

const showHint = computed(
  () =>
    !runtime.pioneerDeviceLibrary.loading &&
    !visibleTreeNodes.value.length &&
    !String(playlistSearch.value || '').trim()
)

const statusText = computed(() => {
  if (runtime.pioneerDeviceLibrary.loading) {
    return isDesktopSource.value
      ? t('rekordboxDesktop.loadingPlaylistTree')
      : t('pioneer.loadingPlaylistTree')
  }
  if (String(playlistSearch.value || '').trim() && !visibleTreeNodes.value.length) {
    return t('pioneer.noMatchingPlaylists')
  }
  return isDesktopSource.value
    ? t('rekordboxDesktop.emptyPlaylistTree')
    : t('pioneer.emptyPlaylistTree')
})

const createEmptyPlaylist = async (playlistName: string, parentId = 0) => {
  if (!isDesktopSource.value || dialogWriting.value) return false
  return await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('create'))) return false
    const response = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'create-empty-playlist'),
      {
        playlistName,
        parentId
      }
    )) as RekordboxDesktopCreateEmptyPlaylistResponse

    if (!response.ok) {
      await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
      return false
    }

    clearRekordboxSourceCachesByKind('desktop')
    playlistSearch.value = ''
    await refreshDesktopTree(response.summary.playlistId)
    return true
  })
}

const createFolder = async (folderName: string, parentId = 0) => {
  if (!isDesktopSource.value || dialogWriting.value) return false
  return await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('create'))) return false
    const response = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'create-folder'),
      {
        folderName,
        parentId
      }
    )) as RekordboxDesktopCreateFolderResponse

    if (!response.ok) {
      await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
      return false
    }

    clearRekordboxSourceCachesByKind('desktop')
    playlistSearch.value = ''
    await refreshDesktopTree(Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0)
    const nextExpanded = new Set(expandedFolderIds.value)
    if (parentId > 0) nextExpanded.add(parentId)
    nextExpanded.add(response.summary.folderId)
    expandedFolderIds.value = nextExpanded
    return true
  })
}

const renameNode = async (node: IPioneerPlaylistTreeNode, nextName: string) => {
  if (!isDesktopSource.value || dialogWriting.value) return false
  const playlistId = Number(node.id) || 0
  const name = sanitizeNodeName(nextName)
  if (playlistId <= 0 || !name) return false
  if (name === sanitizeNodeName(node.name)) return true

  return await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return false
    const response = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'rename-playlist'),
      {
        playlistId,
        name
      }
    )) as RekordboxDesktopRenamePlaylistResponse

    if (!response.ok) {
      await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
      return false
    }

    clearRekordboxSourceCachesByKind('desktop')
    await refreshDesktopTree(Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || playlistId)
    return true
  })
}

const deleteNode = async (node: IPioneerPlaylistTreeNode) => {
  if (!isDesktopSource.value || dialogWriting.value) return false
  const playlistId = Number(node.id) || 0
  if (playlistId <= 0) return false

  return await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return false
    const response = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'delete-playlist'),
      {
        playlistId
      }
    )) as RekordboxDesktopDeletePlaylistResponse

    if (!response.ok) {
      await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
      return false
    }

    clearRekordboxSourceCachesByKind('desktop')
    const deletedSelected =
      Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) === playlistId ? 0 : undefined
    await refreshDesktopTree(deletedSelected ?? (response.summary.parentId || 0))
    return true
  })
}

const openCreatePlaylistDialog = async (parentId = 0, defaultValue = '') => {
  if (!isDesktopSource.value || dialogWriting.value) return
  await openRekordboxDesktopCreateNodeDialog({
    dialogTitle: t('rekordboxDesktop.createPlaylistDialogTitle'),
    placeholder: t('rekordboxDesktop.playlistNamePlaceholder'),
    defaultValue,
    confirmText: t('common.confirm'),
    confirmCallback: async (value) => {
      if (!value) return false
      return await createEmptyPlaylist(value, parentId)
    }
  })
}

const openCreateFolderDialog = async (parentId = 0) => {
  if (!isDesktopSource.value || dialogWriting.value) return
  await openRekordboxDesktopCreateNodeDialog({
    dialogTitle: t('rekordboxDesktop.createFolderTitle'),
    placeholder: t('rekordboxDesktop.folderNamePlaceholder'),
    confirmText: t('common.confirm'),
    confirmCallback: async (value) => {
      if (!value) return false
      return await createFolder(value, parentId)
    }
  })
}

const openRenameNodeDialog = async (node: IPioneerPlaylistTreeNode) => {
  if (!isDesktopSource.value || dialogWriting.value || node.isSmartPlaylist) return
  await openRekordboxDesktopCreateNodeDialog({
    dialogTitle: node.isFolder
      ? t('rekordboxDesktop.renameFolderTitle')
      : t('rekordboxDesktop.renamePlaylistTitle'),
    placeholder: node.isFolder
      ? t('rekordboxDesktop.folderNamePlaceholder')
      : t('rekordboxDesktop.playlistNamePlaceholder'),
    defaultValue: String(node.name || '').trim(),
    confirmText: t('common.confirm'),
    confirmCallback: async (value) => {
      if (!value) return false
      return await renameNode(node, value)
    }
  })
}

const confirmDeleteNode = async (node: IPioneerPlaylistTreeNode) => {
  if (!isDesktopSource.value || dialogWriting.value || node.isSmartPlaylist) return

  const lines = node.isFolder
    ? (() => {
        const descendants = countNodeDescendants(node)
        const content = [
          t('rekordboxDesktop.deleteFolderConfirmLine1', { name: node.name }),
          t('rekordboxDesktop.deleteFolderConfirmLine2')
        ]
        if (descendants.folderCount > 0 || descendants.playlistCount > 0) {
          content.push(
            t('rekordboxDesktop.deleteFolderDescendants', {
              folderCount: descendants.folderCount,
              playlistCount: descendants.playlistCount
            })
          )
        }
        return content
      })()
    : [
        t('rekordboxDesktop.deletePlaylistConfirmLine1', { name: node.name }),
        t('rekordboxDesktop.deletePlaylistConfirmLine2')
      ]

  const result = await confirm({
    title: node.isFolder
      ? t('rekordboxDesktop.deleteFolderTitle')
      : t('rekordboxDesktop.deletePlaylistTitle'),
    content: lines,
    innerWidth: 620,
    innerHeight: 0,
    textAlign: 'left'
  })
  if (result !== 'confirm') return
  await deleteNode(node)
}

const {
  dragSourceId,
  dragTarget,
  shouldSuppressClick,
  handleDragStartNode,
  handleDragOverNode,
  handleDragEnterNode,
  handleDragLeaveNode,
  handleDragEndNode,
  handleDragOverRootEnd,
  handleDragEnterRootEnd,
  handleDragLeaveRootEnd,
  handleDropNode,
  handleDropRootEnd
} = usePioneerDeviceTreeDrag(
  originalTreeNodes,
  isDesktopSource,
  dialogWriting,
  playlistSearch,
  syncRuntimeDesktopTree,
  refreshDesktopTree,
  showFailureDialog,
  runWithDialogWriting,
  () => Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
)

const toggleFolder = (node: IPioneerPlaylistTreeNode) => {
  if (shouldSuppressClick()) return
  if (dialogWriting.value) return
  if (!node.isFolder) return
  const next = new Set(expandedFolderIds.value)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  expandedFolderIds.value = next
}

const selectPlaylist = (node: IPioneerPlaylistTreeNode) => {
  if (shouldSuppressClick()) return
  if (dialogWriting.value || node.isFolder || node.isSmartPlaylist) return
  runtime.pioneerDeviceLibrary.selectedPlaylistId =
    runtime.pioneerDeviceLibrary.selectedPlaylistId === node.id ? 0 : node.id
}

const collapseAllHandleClick = async () => {
  if (dialogWriting.value) return
  expandedFolderIds.value = new Set()
  await nextTick()
}

const contextmenuEvent = async (event: MouseEvent) => {
  if (dialogWriting.value || localLibraryCopying.value) return
  if (!isDesktopSource.value) return

  const result = await rightClickMenu({
    menuArr: [[{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]],
    clickEvent: event
  })
  if (result === 'cancel') return
  if (result.menuName === 'library.createPlaylist') {
    await openCreatePlaylistDialog(0)
    return
  }
  if (result.menuName === 'library.createFolder') {
    await openCreateFolderDialog(0)
    return
  }
}

const normalizeSourceKind = (value: unknown): RekordboxSourceKind | '' =>
  value === 'desktop' || value === 'usb' ? value : ''

const normalizeSourceLibraryType = (value: unknown): RekordboxSourceLibraryType | '' =>
  value === 'deviceLibrary' || value === 'oneLibrary' || value === 'masterDb' ? value : ''

const openSimilarTracksForRekordboxNodes = async (nodes: IPioneerPlaylistTreeNode[]) => {
  const sourceKind = normalizeSourceKind(runtime.pioneerDeviceLibrary.selectedSourceKind)
  if (!sourceKind) return
  const sourceLibraryType = normalizeSourceLibraryType(
    runtime.pioneerDeviceLibrary.selectedLibraryType
  )
  try {
    const seeds = await collectRekordboxSimilarTracksSeeds({
      nodes,
      sourceKind,
      sourceRootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
      sourceLibraryType
    })
    await openBatchSimilarTracksDialogForSeeds(seeds)
  } catch (error) {
    await confirm({
      title: t('common.error'),
      content: [
        getDialogErrorMessage(
          error,
          isDesktopSource.value ? t('rekordboxDesktop.loadTreeFailed') : t('pioneer.loadTreeFailed')
        )
      ],
      confirmShow: false
    })
  }
}

const copyPlaylistToLibrary = async (
  node: IPioneerPlaylistTreeNode,
  targetLibrary: 'FilterLibrary' | 'CuratedLibrary'
) => {
  const sourceKind = runtime.pioneerDeviceLibrary.selectedSourceKind
  if (sourceKind !== 'desktop' && sourceKind !== 'usb') return
  await copyPioneerNodeToLibrary({
    node,
    sourceKind,
    sourceRootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
    sourceLibraryType: runtime.pioneerDeviceLibrary.selectedLibraryType || '',
    targetLibrary,
    runtime,
    runWithCopyBusy: runWithLocalLibraryCopying,
    isBusy: () => dialogWriting.value || localLibraryCopying.value
  })
}

const addPlaylistToMixtape = async (node: IPioneerPlaylistTreeNode) => {
  const sourceKind = runtime.pioneerDeviceLibrary.selectedSourceKind
  if ((sourceKind !== 'desktop' && sourceKind !== 'usb') || node.isFolder) return
  await copyPioneerPlaylistToMixtape({
    node,
    sourceKind,
    sourceRootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
    sourceLibraryType: runtime.pioneerDeviceLibrary.selectedLibraryType || '',
    sourceName: title.value,
    runWithCopyBusy: runWithLocalLibraryCopying,
    isBusy: () => dialogWriting.value || localLibraryCopying.value
  })
}

const importArtistsForNode = async (node: IPioneerPlaylistTreeNode) => {
  const sourceKind = runtime.pioneerDeviceLibrary.selectedSourceKind
  if (sourceKind !== 'desktop' && sourceKind !== 'usb') return
  await importCuratedArtistsFromPioneerSource({
    scope: 'node',
    node,
    sourceKind,
    sourceRootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
    sourceLibraryType: runtime.pioneerDeviceLibrary.selectedLibraryType || '',
    runWithBusy: runWithLocalLibraryCopying,
    isBusy: () => dialogWriting.value || localLibraryCopying.value
  })
}

const calculateSetDuration = async (node: IPioneerPlaylistTreeNode) => {
  const sourceKind = runtime.pioneerDeviceLibrary.selectedSourceKind
  if ((sourceKind !== 'desktop' && sourceKind !== 'usb') || node.isFolder) return
  await openSetDurationForRekordboxPlaylist({
    sourceKind,
    playlistId: Number(node.id) || 0,
    sourceRootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
    sourceLibraryType: runtime.pioneerDeviceLibrary.selectedLibraryType || ''
  })
}

const handleCopyOnlyContextMenu = async (event: MouseEvent, node: IPioneerPlaylistTreeNode) => {
  const result = await rightClickMenu({
    menuArr: [
      [{ menuName: 'pioneer.copyToFilter' }, { menuName: 'pioneer.copyToCurated' }],
      [{ menuName: 'pioneer.importArtistsToCurated' }],
      [{ menuName: 'similarTracks.menu' }],
      ...(node.isFolder ? [] : [[{ menuName: 'playlist.calculateSetDuration' }]]),
      ...(node.isFolder ? [] : [[{ menuName: 'library.addToMixtapeByCopy' }]])
    ],
    clickEvent: event
  })
  if (result === 'cancel') return
  if (result.menuName === 'pioneer.copyToFilter') {
    await copyPlaylistToLibrary(node, 'FilterLibrary')
    return
  }
  if (result.menuName === 'pioneer.copyToCurated') {
    await copyPlaylistToLibrary(node, 'CuratedLibrary')
    return
  }
  if (result.menuName === 'library.addToMixtapeByCopy') {
    await addPlaylistToMixtape(node)
    return
  }
  if (result.menuName === 'pioneer.importArtistsToCurated') {
    await importArtistsForNode(node)
    return
  }
  if (result.menuName === 'similarTracks.menu') {
    await openSimilarTracksForRekordboxNodes([node])
    return
  }
  if (result.menuName === 'playlist.calculateSetDuration') {
    await calculateSetDuration(node)
    return
  }
}

const handleNodeContextmenu = async (event: MouseEvent, node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value || localLibraryCopying.value || node.isSmartPlaylist) return
  if (!isDesktopSource.value) {
    if (!isCopyableSource.value) return
    await handleCopyOnlyContextMenu(event, node)
    return
  }

  if (node.isFolder) {
    const menuArr = [
      [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
      [{ menuName: 'pioneer.copyToFilter' }, { menuName: 'pioneer.copyToCurated' }],
      [{ menuName: 'pioneer.importArtistsToCurated' }],
      [{ menuName: 'similarTracks.menu' }],
      [{ menuName: renameMenuKey }, { menuName: deleteFolderMenuKey }]
    ]
    const result = await rightClickMenu({ menuArr, clickEvent: event })
    if (result === 'cancel') return
    if (result.menuName === 'library.createPlaylist') {
      await openCreatePlaylistDialog(Number(node.id) || 0)
      return
    }
    if (result.menuName === 'library.createFolder') {
      await openCreateFolderDialog(Number(node.id) || 0)
      return
    }
    if (result.menuName === 'pioneer.copyToFilter') {
      await copyPlaylistToLibrary(node, 'FilterLibrary')
      return
    }
    if (result.menuName === 'pioneer.copyToCurated') {
      await copyPlaylistToLibrary(node, 'CuratedLibrary')
      return
    }
    if (result.menuName === 'pioneer.importArtistsToCurated') {
      await importArtistsForNode(node)
      return
    }
    if (result.menuName === 'similarTracks.menu') {
      await openSimilarTracksForRekordboxNodes([node])
      return
    }
    if (result.menuName === renameMenuKey) {
      await openRenameNodeDialog(node)
      return
    }
    if (result.menuName === deleteFolderMenuKey) {
      await confirmDeleteNode(node)
    }
    return
  }

  const menuArr = [
    [{ menuName: 'pioneer.copyToFilter' }, { menuName: 'pioneer.copyToCurated' }],
    [{ menuName: 'pioneer.importArtistsToCurated' }],
    [{ menuName: 'similarTracks.menu' }],
    [{ menuName: 'playlist.calculateSetDuration' }],
    [{ menuName: 'library.addToMixtapeByCopy' }],
    [{ menuName: renameMenuKey }, { menuName: deletePlaylistMenuKey }],
    [{ menuName: 'pioneer.cleanMissingFiles' }]
  ]
  const result = await rightClickMenu({ menuArr, clickEvent: event })
  if (result === 'cancel') return
  if (result.menuName === 'pioneer.copyToFilter') {
    await copyPlaylistToLibrary(node, 'FilterLibrary')
    return
  }
  if (result.menuName === 'pioneer.copyToCurated') {
    await copyPlaylistToLibrary(node, 'CuratedLibrary')
    return
  }
  if (result.menuName === 'library.addToMixtapeByCopy') {
    await addPlaylistToMixtape(node)
    return
  }
  if (result.menuName === 'pioneer.importArtistsToCurated') {
    await importArtistsForNode(node)
    return
  }
  if (result.menuName === 'similarTracks.menu') {
    await openSimilarTracksForRekordboxNodes([node])
    return
  }
  if (result.menuName === 'playlist.calculateSetDuration') {
    await calculateSetDuration(node)
    return
  }
  if (result.menuName === renameMenuKey) {
    await openRenameNodeDialog(node)
    return
  }
  if (result.menuName === deletePlaylistMenuKey) {
    await confirmDeleteNode(node)
    return
  }
  if (result.menuName === 'pioneer.cleanMissingFiles') {
    await cleanMissingFilesFromPlaylist(node)
  }
}

const cleanMissingFilesFromPlaylist = async (node: IPioneerPlaylistTreeNode) => {
  if (!isDesktopSource.value || dialogWriting.value) return
  const playlistId = Number(node.id) || 0
  if (playlistId <= 0) return

  await runWithDialogWriting(async () => {
    try {
      const loadResult = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'load-playlist-tracks'),
        playlistId
      )) as { tracks?: IPioneerPlaylistTrack[] }

      const tracks = Array.isArray(loadResult?.tracks) ? loadResult.tracks : []
      const missingTracks = tracks.filter((t) => t.fileMissing)

      if (!missingTracks.length) {
        await confirm({
          title: t('pioneer.cleanMissingFilesFinished'),
          content: [t('pioneer.cleanMissingFilesNone')],
          confirmShow: false
        })
        return
      }

      const confirmResult = await confirm({
        title: t('pioneer.cleanMissingFilesConfirmTitle'),
        content: [t('pioneer.cleanMissingFilesConfirm', { count: missingTracks.length })]
      })
      if (confirmResult !== 'confirm') return
      if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return

      const rowKeys = missingTracks.map((t) => String(t.rowKey || '').trim()).filter(Boolean)

      const response = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'remove-playlist-tracks'),
        { playlistId, rowKeys }
      )) as RekordboxDesktopRemovePlaylistTracksResponse

      if (!response.ok) {
        await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
        return
      }

      clearRekordboxSourceCachesByKind('desktop')
      await refreshDesktopTree(playlistId)

      await confirm({
        title: t('pioneer.cleanMissingFilesFinished'),
        content: [t('pioneer.cleanMissingFilesRemovedCount', { count: rowKeys.length })],
        confirmShow: false
      })
    } catch (error: unknown) {
      await confirm({
        title: t('common.error'),
        content: [error instanceof Error ? error.message : String(error)],
        confirmShow: false
      })
    }
  })
}

const lastTreeSignature = ref('')
const buildTreeSignature = (nodes: IPioneerPlaylistTreeNode[]) =>
  nodes.map((node) => `${node.id}:${node.order}:${node.children?.length || 0}`).join('|')

const hasPlaylistInTree = (nodes: IPioneerPlaylistTreeNode[], playlistId: number): boolean => {
  if (!playlistId) return false
  const walk = (items: IPioneerPlaylistTreeNode[]): boolean => {
    for (const item of items) {
      if (!item.isFolder && item.id === playlistId) return true
      if (Array.isArray(item.children) && item.children.length > 0 && walk(item.children)) {
        return true
      }
    }
    return false
  }
  return walk(nodes)
}

const syncExpandedWhenTreeChanges = () => {
  const signature = buildTreeSignature(originalTreeNodes.value)
  if (signature === lastTreeSignature.value) return
  lastTreeSignature.value = signature
  expandedFolderIds.value = new Set()
  const currentSelectedPlaylistId = Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
  if (
    currentSelectedPlaylistId > 0 &&
    hasPlaylistInTree(originalTreeNodes.value, currentSelectedPlaylistId)
  ) {
    return
  }
  runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
}

watch(
  originalTreeNodes,
  () => {
    syncExpandedWhenTreeChanges()
  },
  { immediate: true, deep: false }
)
</script>

<template>
  <div class="content" @contextmenu.stop.prevent="contextmenuEvent($event)">
    <div class="unselectable libraryTitle">
      <span class="libraryTitleText">{{ title }}</span>
      <div style="display: flex; justify-content: center; align-items: center">
        <div
          ref="collapseButtonRef"
          class="collapseButton"
          :class="{ disabledAction: dialogWriting }"
          @click="collapseAllHandleClick()"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
          >
            <path d="M9 9H4v1h5V9z" />
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"
            />
          </svg>
        </div>
        <bubbleBox :dom="collapseButtonRef || undefined" :title="t('playlist.collapsibleFolder')" />
      </div>
    </div>

    <div class="librarySearchWrapper">
      <div class="searchRow">
        <div class="searchInputWrapper">
          <input
            v-model="playlistSearch"
            class="searchInput"
            :placeholder="t('playlist.searchPlaylists')"
            :disabled="dialogWriting"
          />
          <div
            v-show="String(playlistSearch || '').length"
            class="clearBtn"
            :class="{ clearBtnDisabled: dialogWriting }"
            @click="!dialogWriting && (playlistSearch = '')"
          >
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
    </div>

    <div class="unselectable libraryArea">
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
        <div
          class="libraryTreeDropSurface"
          @dragover.prevent="handleDragOverRootEnd"
          @dragenter.prevent="handleDragEnterRootEnd"
          @dragleave="handleDragLeaveRootEnd"
          @drop.prevent="handleDropRootEnd"
        >
          <template v-for="item of visibleTreeNodes" :key="`${item.id}:${item.order}`">
            <pioneerDeviceLibraryItem
              :node="item"
              :depth="0"
              :expanded-ids="expandedFolderIds"
              :filter-text="playlistSearch"
              :interaction-disabled="dialogWriting"
              :draggable-nodes="isDesktopSource && !normalizeKeyword(playlistSearch)"
              :contextmenu-enabled="
                isCopyableSource && !localLibraryCopying && !normalizeKeyword(playlistSearch)
              "
              :drag-target-node-id="dragTarget?.nodeId || undefined"
              :drag-target-approach="dragTarget?.approach || ''"
              :drag-source-id="dragSourceId || undefined"
              @toggle-folder="toggleFolder"
              @select-playlist="selectPlaylist"
              @contextmenu-node="handleNodeContextmenu"
              @dragstart-node="handleDragStartNode"
              @dragover-node="handleDragOverNode"
              @dragenter-node="handleDragEnterNode"
              @dragleave-node="handleDragLeaveNode"
              @drop-node="handleDropNode"
              @dragend-node="handleDragEndNode"
            />
          </template>

          <div
            class="libraryDropSpace"
            :class="{ 'libraryDropSpace--active': dragTarget?.placement === 'root-end' }"
          >
            <span
              v-show="
                (showHint ||
                  (playlistSearch && !visibleTreeNodes.length) ||
                  runtime.pioneerDeviceLibrary.loading) &&
                runtime.layoutConfig.libraryAreaWidth !== 0
              "
              class="libraryStatusText"
            >
              {{ statusText }}
            </span>
          </div>
        </div>
      </OverlayScrollbarsComponent>
    </div>

    <RekordboxDesktopWritingOverlay v-if="dialogWriting" />
  </div>
</template>

<style lang="scss" scoped>
.content {
  position: relative;
}

.libraryArea {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
}

.libraryTreeDropSurface {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.libraryDropSpace {
  flex: 1 1 auto;
  min-height: 30px;
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  align-items: center;
}

.libraryDropSpace--active {
  box-shadow: inset 0 1px 0 0 var(--accent);
}

.libraryStatusText {
  font-size: 12px;
  color: var(--text-weak);
  position: absolute;
  bottom: 50vh;
}

.content {
  height: 100%;
  width: 100%;
  display: flex;
  flex-grow: 1;
  min-height: 0;
  background-color: var(--bg);
  overflow: hidden;
  flex-direction: column;

  .libraryTitle {
    height: 35px;
    line-height: 35px;
    padding: 0 18px 0 20px;
    font-size: 12px;
    font-weight: bold;
    display: flex;
    justify-content: space-between;
  }

  .libraryTitleText {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collapseButton {
    color: var(--text);
    width: 20px;
    height: 20px;
    display: flex;
    justify-content: center;
    align-items: center;
    border-radius: 5px;

    &:hover {
      background-color: var(--hover);
    }
  }
}

.disabledAction {
  pointer-events: none;
  opacity: 0.6;
}

.librarySearchWrapper {
  flex-shrink: 0;
  padding: 6px 5px 6px 5px;
  background-color: var(--bg);
}

.searchInput {
  width: 100%;
  height: 22px;
  line-height: 22px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 2px;
  padding: 0 8px;
  box-sizing: border-box;
  font-size: 12px;
  font-weight: normal;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
}

.searchInputWrapper:hover .searchInput {
  background-color: var(--hover);
  border-color: var(--accent);
}

.searchRow {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
}

.searchRow .searchInput {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}

.searchInputWrapper {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}

.searchInputWrapper .searchInput {
  width: 100%;
  padding-right: 24px;
}

.clearBtn {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 50%;
  color: var(--text-weak);
  cursor: pointer;

  &:hover {
    color: var(--text);
    background-color: var(--hover);
  }
}

.clearBtnDisabled {
  pointer-events: none;
  opacity: 0.45;
}
</style>
