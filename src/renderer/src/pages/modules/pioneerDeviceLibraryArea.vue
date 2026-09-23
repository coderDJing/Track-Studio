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
import { filterPlaylistTreeByName } from '@renderer/composables/rekordboxDesktop/filterPlaylistTree'
import { useExternalPlaylistActions } from '@renderer/composables/externalLibrary/useExternalPlaylistActions'
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
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'
import type { RekordboxSourceKind, RekordboxSourceLibraryType } from '@shared/rekordboxSources'
import type {
  RekordboxDesktopCreateEmptyPlaylistResponse,
  RekordboxDesktopCreateFolderResponse,
  RekordboxDesktopDeletePlaylistResponse,
  RekordboxDesktopRenamePlaylistResponse
} from '@shared/rekordboxDesktopPlaylist'
import { useCleanMissingFiles } from '@renderer/composables/rekordboxDesktop/useCleanMissingFiles'

const runtime = useRuntimeStore()
const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')
const playlistSearch = ref('')
const expandedFolderIds = ref<Set<number>>(new Set())
const dialogWriting = ref(false)
const localLibraryCopying = ref(false)
const isDesktopSource = computed(
  () => runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop'
)
const isExternalSource = computed(
  () =>
    Boolean(runtime.externalDjLibrary.selectedKind) &&
    runtime.externalDjLibrary.selectedSourceKey === runtime.pioneerDeviceLibrary.selectedSourceKey
)
const isEditableSource = computed(
  () =>
    isDesktopSource.value ||
    (isExternalSource.value && runtime.externalDjLibrary.selectedKind === 'serato')
)
const sourceText = (rekordboxKey: string, seratoKey: string, values?: Record<string, unknown>) =>
  t(isExternalSource.value ? seratoKey : rekordboxKey, values)
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
  if (isExternalSource.value) {
    runtime.pioneerDeviceLibrary.treeNodes = nodes
    runtime.pioneerDeviceLibrary.selectedPlaylistId = preferredPlaylistId
    return
  }

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
  if (isExternalSource.value) {
    const kind = runtime.externalDjLibrary.selectedKind
    const sourcePath = runtime.externalDjLibrary.selectedSourcePath
    if (!kind || !sourcePath) return
    const result = (await window.electron.ipcRenderer.invoke('external-library:load-tree', {
      kind,
      path: sourcePath
    })) as { treeNodes?: IPioneerPlaylistTreeNode[] }
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
    return
  }
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
  const content = [
    sourceText('rekordboxDesktop.failedReason', 'library.externalLibraryFailedReason', { message })
  ]
  if (logPath) {
    content.push(
      sourceText('rekordboxDesktop.failureLogHint', 'library.externalLibraryFailureLogHint', {
        path: logPath
      })
    )
  }
  await confirm({
    title: sourceText('rekordboxDesktop.failureTitle', 'library.externalLibraryFailureTitle'),
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

const externalPlaylistActions = useExternalPlaylistActions({
  runtime,
  originalTreeNodes,
  playlistSearch,
  isExternalSource,
  isEditableSource,
  dialogWriting,
  runWithDialogWriting,
  refreshTree: refreshDesktopTree,
  showFailureDialog
})

const visibleTreeNodes = computed(() =>
  filterPlaylistTreeByName(originalTreeNodes.value, String(playlistSearch.value || ''))
)

const showHint = computed(
  () =>
    !runtime.pioneerDeviceLibrary.loading &&
    !visibleTreeNodes.value.length &&
    !String(playlistSearch.value || '').trim()
)

const statusText = computed(() => {
  if (runtime.pioneerDeviceLibrary.loading) {
    if (isExternalSource.value) return t('library.externalLibraryLoadingTree')
    return isDesktopSource.value
      ? t('rekordboxDesktop.loadingPlaylistTree')
      : t('pioneer.loadingPlaylistTree')
  }
  if (String(playlistSearch.value || '').trim() && !visibleTreeNodes.value.length) {
    return t('pioneer.noMatchingPlaylists')
  }
  if (isExternalSource.value) return t('library.externalLibraryEmptyTree')
  return isDesktopSource.value
    ? t('rekordboxDesktop.emptyPlaylistTree')
    : t('pioneer.emptyPlaylistTree')
})

const createEmptyPlaylist = async (playlistName: string, parentId = 0) => {
  if (!isEditableSource.value || dialogWriting.value) return false
  if (isExternalSource.value)
    return await externalPlaylistActions.create('create-playlist', playlistName, parentId)
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
  if (!isEditableSource.value || dialogWriting.value) return false
  if (isExternalSource.value)
    return await externalPlaylistActions.create('create-folder', folderName, parentId)
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
  if (!isEditableSource.value || dialogWriting.value) return false
  const playlistId = Number(node.id) || 0
  const name = sanitizeNodeName(nextName)
  if (playlistId <= 0 || !name) return false
  if (name === sanitizeNodeName(node.name)) return true

  if (isExternalSource.value) return await externalPlaylistActions.rename(node, name)
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
  if (!isEditableSource.value || dialogWriting.value) return false
  const playlistId = Number(node.id) || 0
  if (playlistId <= 0) return false

  if (isExternalSource.value) return await externalPlaylistActions.remove(node)
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
  if (!isEditableSource.value || dialogWriting.value) return
  await openRekordboxDesktopCreateNodeDialog({
    dialogTitle: sourceText(
      'rekordboxDesktop.createPlaylistDialogTitle',
      'library.createSeratoPlaylistDialogTitle'
    ),
    placeholder: sourceText(
      'rekordboxDesktop.playlistNamePlaceholder',
      'library.seratoPlaylistNamePlaceholder'
    ),
    defaultValue,
    confirmText: t('common.confirm'),
    confirmCallback: async (value) => {
      if (!value) return false
      return await createEmptyPlaylist(value, parentId)
    }
  })
}

const openCreateFolderDialog = async (parentId = 0) => {
  if (!isEditableSource.value || dialogWriting.value) return
  await openRekordboxDesktopCreateNodeDialog({
    dialogTitle: sourceText(
      'rekordboxDesktop.createFolderTitle',
      'library.createSeratoFolderTitle'
    ),
    placeholder: sourceText(
      'rekordboxDesktop.folderNamePlaceholder',
      'library.seratoFolderNamePlaceholder'
    ),
    confirmText: t('common.confirm'),
    confirmCallback: async (value) => {
      if (!value) return false
      return await createFolder(value, parentId)
    }
  })
}

const openRenameNodeDialog = async (node: IPioneerPlaylistTreeNode) => {
  if (!isEditableSource.value || dialogWriting.value || node.isSmartPlaylist) return
  await openRekordboxDesktopCreateNodeDialog({
    dialogTitle: node.isFolder
      ? sourceText('rekordboxDesktop.renameFolderTitle', 'library.renameSeratoFolderTitle')
      : sourceText('rekordboxDesktop.renamePlaylistTitle', 'library.renameSeratoPlaylistTitle'),
    placeholder: node.isFolder
      ? sourceText('rekordboxDesktop.folderNamePlaceholder', 'library.seratoFolderNamePlaceholder')
      : sourceText(
          'rekordboxDesktop.playlistNamePlaceholder',
          'library.seratoPlaylistNamePlaceholder'
        ),
    defaultValue: String(node.name || '').trim(),
    confirmText: t('common.confirm'),
    confirmCallback: async (value) => {
      if (!value) return false
      return await renameNode(node, value)
    }
  })
}

const confirmDeleteNode = async (node: IPioneerPlaylistTreeNode) => {
  if (!isEditableSource.value || dialogWriting.value || node.isSmartPlaylist) return

  const lines = node.isFolder
    ? (() => {
        const descendants = countNodeDescendants(node)
        const content = [
          sourceText(
            'rekordboxDesktop.deleteFolderConfirmLine1',
            'library.deleteSeratoFolderConfirmLine1',
            { name: node.name }
          ),
          sourceText(
            'rekordboxDesktop.deleteFolderConfirmLine2',
            'library.deleteSeratoFolderConfirmLine2'
          )
        ]
        if (descendants.folderCount > 0 || descendants.playlistCount > 0) {
          content.push(
            sourceText(
              'rekordboxDesktop.deleteFolderDescendants',
              'library.deleteSeratoFolderDescendants',
              {
                folderCount: descendants.folderCount,
                playlistCount: descendants.playlistCount
              }
            )
          )
        }
        return content
      })()
    : [
        sourceText(
          'rekordboxDesktop.deletePlaylistConfirmLine1',
          'library.deleteSeratoPlaylistConfirmLine1',
          { name: node.name }
        ),
        sourceText(
          'rekordboxDesktop.deletePlaylistConfirmLine2',
          'library.deleteSeratoPlaylistConfirmLine2'
        )
      ]

  const result = await confirm({
    title: node.isFolder
      ? sourceText('rekordboxDesktop.deleteFolderTitle', 'library.deleteSeratoFolderTitle')
      : sourceText('rekordboxDesktop.deletePlaylistTitle', 'library.deleteSeratoPlaylistTitle'),
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
  () => Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0,
  {
    enabled: computed(
      () => isExternalSource.value && runtime.externalDjLibrary.selectedKind === 'serato'
    ),
    sourcePath: computed(() => runtime.externalDjLibrary.selectedSourcePath || '')
  }
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
  if (!isEditableSource.value) return

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
  if (isExternalSource.value && !node.externalId) return
  if (!isDesktopSource.value && !isExternalSource.value) {
    if (!isCopyableSource.value) return
    await handleCopyOnlyContextMenu(event, node)
    return
  }

  if (node.isFolder) {
    const menuArr = [
      [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
      ...(isCopyableSource.value
        ? [
            [{ menuName: 'pioneer.copyToFilter' }, { menuName: 'pioneer.copyToCurated' }],
            [{ menuName: 'pioneer.importArtistsToCurated' }],
            [{ menuName: 'similarTracks.menu' }]
          ]
        : []),
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
    ...(isCopyableSource.value
      ? [
          [{ menuName: 'pioneer.copyToFilter' }, { menuName: 'pioneer.copyToCurated' }],
          [{ menuName: 'pioneer.importArtistsToCurated' }],
          [{ menuName: 'similarTracks.menu' }],
          [{ menuName: 'playlist.calculateSetDuration' }],
          [{ menuName: 'library.addToMixtapeByCopy' }]
        ]
      : []),
    [{ menuName: renameMenuKey }, { menuName: deletePlaylistMenuKey }],
    ...(isDesktopSource.value ? [[{ menuName: 'pioneer.cleanMissingFiles' }]] : [])
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

const { cleanMissingFilesFromPlaylist } = useCleanMissingFiles({
  isDesktopSource,
  dialogWriting,
  runWithDialogWriting,
  refreshTree: refreshDesktopTree,
  showFailureDialog
})

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
              :draggable-nodes="isEditableSource && !normalizeKeyword(playlistSearch)"
              :contextmenu-enabled="
                isEditableSource && !localLibraryCopying && !normalizeKeyword(playlistSearch)
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
              <span
                v-if="runtime.pioneerDeviceLibrary.loading"
                class="libraryStatusSpinner"
                aria-hidden="true"
              ></span>
              <span>{{ statusText }}</span>
            </span>
          </div>
        </div>
      </OverlayScrollbarsComponent>
    </div>

    <RekordboxDesktopWritingOverlay v-if="dialogWriting" />
  </div>
</template>

<style lang="scss" scoped src="./pioneerDeviceLibraryArea.scss"></style>
