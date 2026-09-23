import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '@renderer/components/rightClickMenu'
import {
  buildRekordboxSourceCacheKey,
  clearRekordboxSourceCache,
  clearRekordboxSourceCachesByKind,
  getCachedRekordboxSourceTree,
  getRememberedRekordboxSourceSelectedPlaylist,
  setCachedRekordboxSourceTree,
  shouldRefreshRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { t } from '@renderer/utils/translate'
import emitter from '@renderer/utils/mitt'
import {
  collectRekordboxSimilarTracksSeeds,
  openBatchSimilarTracksDialogForSeeds
} from '@renderer/utils/similarTracksActions'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import { importCuratedArtistsFromPioneerSource } from '@renderer/composables/rekordboxDesktop/useImportCuratedArtists'
import { groupPioneerDriveIcons } from './groupPioneerDriveIcons'
import type {
  IMenu,
  IPioneerDeviceLibraryKind,
  IPioneerPlaylistTreeNode,
  IRekordboxLibraryBrowserState,
  IRekordboxSourceKind,
  IRekordboxSourceLibraryType,
  ISongInfo
} from '../../../../../types/globals'

type HoverableIcon = {
  name: string
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}

type PioneerDriveEntry = {
  id: string
  name: string
  path: string
  volumeName: string
  fileSystem: string
  isUsb: boolean
  isPioneerDeviceLibrary: boolean
  supportedLibraryTypes?: IPioneerDeviceLibraryKind[]
}

type PioneerDriveEjectResult = {
  success: boolean
  path: string
  code?: 'INVALID_PATH' | 'EJECT_COMMAND_FAILED' | 'EJECT_TIMEOUT' | 'UNSUPPORTED_PLATFORM'
  detail?: string
}

type RekordboxSourceTreeLoadResult = {
  treeNodes?: IPioneerPlaylistTreeNode[]
  driveName?: string
  sourceRootPath?: string
}

export type PioneerDriveIcon = HoverableIcon & {
  key: string
  tooltip: string
  path: string
  libraryType: IPioneerDeviceLibraryKind
}

export type PioneerDriveGroup = {
  key: string
  path: string
  icons: PioneerDriveIcon[]
}

export type RekordboxDesktopIcon = HoverableIcon & {
  key: string
  tooltip: string
  rootPath: string
}

type WholeLibraryArtistImportBusySource = {
  sourceKind: 'desktop' | 'usb'
  physicalSourceKey: string
  sourceName: string
}

type UseRekordboxSourceIconsOptions = {
  runtime: ReturnType<typeof useRuntimeStore>
  usbDriveIconAsset: string
  rekordboxDesktopIconAsset: string
  updateSelectedIcon: (item: HoverableIcon | undefined) => void
  waitForUiIdle: (ms: number) => Promise<unknown>
  emitLibrarySelectedChange: (payload: { name: string }) => void
}

const SOURCE_ICON_AUTO_REFRESH_INTERVAL_MS = 60_000

export function useRekordboxSourceIcons(options: UseRekordboxSourceIconsOptions) {
  const {
    runtime,
    usbDriveIconAsset,
    rekordboxDesktopIconAsset,
    updateSelectedIcon,
    waitForUiIdle,
    emitLibrarySelectedChange
  } = options

  const pioneerDriveIcons = ref<PioneerDriveIcon[]>([])
  const desktopLibraryIcon = ref<RekordboxDesktopIcon | null>(null)
  const ejectingDriveKeys = ref<string[]>([])
  const wholeLibraryArtistImportBusy = ref<WholeLibraryArtistImportBusySource | null>(null)
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let sourceTreeRequestToken = 0
  let refreshInFlight: Promise<void> | null = null

  const pioneerDriveGroups = computed<PioneerDriveGroup[]>(() =>
    groupPioneerDriveIcons(pioneerDriveIcons.value)
  )

  const getPioneerLibraryTypeLabel = (libraryType: IPioneerDeviceLibraryKind) =>
    libraryType === 'oneLibrary' ? t('pioneer.oneLibraryLabel') : t('pioneer.deviceLibraryLabel')

  const normalizePhysicalPathKey = (value: string) =>
    String(value || '')
      .trim()
      .replace(/[\\/]+$/, '')
      .toLocaleLowerCase()

  const resolvePhysicalSourceKey = (sourceKind: 'desktop' | 'usb', rootPath?: string) => {
    if (sourceKind === 'desktop') return 'desktop'
    return `usb:${normalizePhysicalPathKey(rootPath || '')}`
  }

  const isWholeLibraryArtistImporting = () => Boolean(wholeLibraryArtistImportBusy.value)

  const isSamePhysicalImportSource = (sourceKind: 'desktop' | 'usb', rootPath?: string) =>
    wholeLibraryArtistImportBusy.value?.physicalSourceKey ===
    resolvePhysicalSourceKey(sourceKind, rootPath)

  const isImportingPioneerDriveIcon = (item: PioneerDriveIcon) =>
    isSamePhysicalImportSource('usb', item.path)

  const isImportingDesktopLibraryIcon = computed(() =>
    isSamePhysicalImportSource('desktop', desktopLibraryIcon.value?.rootPath)
  )

  const buildWholeLibraryImportMenuItem = (): IMenu => {
    if (!isWholeLibraryArtistImporting()) {
      return { menuName: 'pioneer.importWholeLibraryArtistsToCurated' }
    }
    return {
      menuName: 'pioneer.importWholeLibraryArtistsToCurated',
      disabled: true,
      disabledReasonKey: 'pioneer.importArtistsBusyReason',
      disabledStatusKey: 'pioneer.menuStatusInProgress'
    }
  }

  const buildSourceBusyMenuItem = (
    menuName: string,
    disabled: boolean,
    disabledReasonKey: string
  ): IMenu => {
    if (!disabled) return { menuName }
    return {
      menuName,
      disabled: true,
      disabledReasonKey,
      disabledStatusKey: 'pioneer.menuStatusReading'
    }
  }

  const snapshotSelection = (): IRekordboxLibraryBrowserState => ({
    selectedSourceKey: runtime.pioneerDeviceLibrary.selectedSourceKey,
    selectedSourceName: runtime.pioneerDeviceLibrary.selectedSourceName,
    selectedSourceRootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
    selectedSourceKind: runtime.pioneerDeviceLibrary.selectedSourceKind,
    selectedLibraryType: runtime.pioneerDeviceLibrary.selectedLibraryType,
    selectedPlaylistId: runtime.pioneerDeviceLibrary.selectedPlaylistId,
    loading: runtime.pioneerDeviceLibrary.loading,
    visibleSongCount: runtime.pioneerDeviceLibrary.visibleSongCount,
    pendingAnalysisCount: runtime.pioneerDeviceLibrary.pendingAnalysisCount,
    firstPendingAnalysisFilePath: runtime.pioneerDeviceLibrary.firstPendingAnalysisFilePath,
    visibleAnalysisProgressCount: runtime.pioneerDeviceLibrary.visibleAnalysisProgressCount,
    treeNodes: Array.isArray(runtime.pioneerDeviceLibrary.treeNodes)
      ? [...runtime.pioneerDeviceLibrary.treeNodes]
      : []
  })

  const restoreSelection = (snapshot: IRekordboxLibraryBrowserState) => {
    runtime.pioneerDeviceLibrary.selectedSourceKey = snapshot.selectedSourceKey
    runtime.pioneerDeviceLibrary.selectedSourceName = snapshot.selectedSourceName
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = snapshot.selectedSourceRootPath
    runtime.pioneerDeviceLibrary.selectedSourceKind = snapshot.selectedSourceKind
    runtime.pioneerDeviceLibrary.selectedLibraryType = snapshot.selectedLibraryType
    runtime.pioneerDeviceLibrary.selectedPlaylistId = snapshot.selectedPlaylistId
    runtime.pioneerDeviceLibrary.loading = snapshot.loading
    runtime.pioneerDeviceLibrary.visibleSongCount = snapshot.visibleSongCount
    runtime.pioneerDeviceLibrary.pendingAnalysisCount = snapshot.pendingAnalysisCount
    runtime.pioneerDeviceLibrary.firstPendingAnalysisFilePath =
      snapshot.firstPendingAnalysisFilePath
    runtime.pioneerDeviceLibrary.visibleAnalysisProgressCount =
      snapshot.visibleAnalysisProgressCount
    runtime.pioneerDeviceLibrary.treeNodes = Array.isArray(snapshot.treeNodes)
      ? [...snapshot.treeNodes]
      : []
  }

  const clearSelection = () => {
    runtime.pioneerDeviceLibrary.selectedSourceKey = ''
    runtime.pioneerDeviceLibrary.selectedSourceName = ''
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = ''
    runtime.pioneerDeviceLibrary.selectedSourceKind = ''
    runtime.pioneerDeviceLibrary.selectedLibraryType = ''
    runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
    runtime.pioneerDeviceLibrary.loading = false
    runtime.pioneerDeviceLibrary.visibleSongCount = 0
    runtime.pioneerDeviceLibrary.pendingAnalysisCount = 0
    runtime.pioneerDeviceLibrary.firstPendingAnalysisFilePath = ''
    runtime.pioneerDeviceLibrary.visibleAnalysisProgressCount = 0
    runtime.pioneerDeviceLibrary.treeNodes = []
  }

  const switchBackToFilterLibraryAfterExit = () => {
    if (runtime.libraryAreaSelected !== 'PioneerDeviceLibrary') return
    runtime.libraryAreaSelected = 'FilterLibrary'
  }

  const buildPioneerDriveTooltip = (
    drive: PioneerDriveEntry,
    libraryType: IPioneerDeviceLibraryKind
  ) => {
    const title = String(drive.volumeName || drive.name || '').trim()
    const base = title || String(drive.path || '').trim() || 'Pioneer USB'
    return `${base} · ${getPioneerLibraryTypeLabel(libraryType)}`
  }

  const resolvePioneerDriveSourceCacheKey = (item: {
    key: string
    path: string
    libraryType: IPioneerDeviceLibraryKind
  }) =>
    buildRekordboxSourceCacheKey({
      sourceKind: 'usb',
      sourceKey: item.key,
      rootPath: item.path,
      libraryType: item.libraryType
    })

  const resolveDesktopLibrarySourceCacheKey = (
    icon: Pick<RekordboxDesktopIcon, 'key' | 'rootPath'> | null | undefined
  ) =>
    buildRekordboxSourceCacheKey({
      sourceKind: 'desktop',
      sourceKey: icon?.key,
      rootPath: icon?.rootPath,
      libraryType: 'masterDb'
    })

  const hasPlaylistInTree = (
    treeNodes: IPioneerPlaylistTreeNode[],
    playlistId: number
  ): boolean => {
    if (!playlistId) return false
    const walk = (nodes: IPioneerPlaylistTreeNode[]): boolean => {
      for (const node of nodes) {
        if (!node.isFolder && node.id === playlistId) return true
        if (Array.isArray(node.children) && node.children.length > 0 && walk(node.children)) {
          return true
        }
      }
      return false
    }
    return walk(Array.isArray(treeNodes) ? treeNodes : [])
  }

  const resolvePlaylistIdForTree = (
    treeNodes: IPioneerPlaylistTreeNode[],
    preferredPlaylistId: number
  ) => {
    const safePlaylistId = Number(preferredPlaylistId) || 0
    if (safePlaylistId <= 0) return 0
    return hasPlaylistInTree(treeNodes, safePlaylistId) ? safePlaylistId : 0
  }

  const isCurrentSelectedSource = (
    sourceKind: IRekordboxSourceKind,
    sourceKey: string,
    libraryType: IRekordboxSourceLibraryType
  ) =>
    runtime.pioneerDeviceLibrary.selectedSourceKind === sourceKind &&
    runtime.pioneerDeviceLibrary.selectedSourceKey === sourceKey &&
    runtime.pioneerDeviceLibrary.selectedLibraryType === libraryType

  const getErrorMessage = (error: unknown, fallbackMessage: string) => {
    if (error instanceof Error) {
      const message = String(error.message || '').trim()
      return message || fallbackMessage
    }
    return String(error || fallbackMessage)
  }

  const loadSourceTree = async (params: {
    sourceKind: IRekordboxSourceKind
    sourceKey: string
    sourceCacheKey: string
    rootPath: string
    libraryType: IRekordboxSourceLibraryType
    preferredPlaylistId: number
    hasCachedTree: boolean
    fallbackSourceName: string
    loadTree: () => Promise<RekordboxSourceTreeLoadResult>
    loadTreeFailedMessage: string
    resolveSourceName?: (result: RekordboxSourceTreeLoadResult) => string
    resolveRootPath?: (result: RekordboxSourceTreeLoadResult) => string
  }) => {
    const requestToken = ++sourceTreeRequestToken
    const {
      sourceKind,
      sourceKey,
      sourceCacheKey,
      rootPath,
      libraryType,
      preferredPlaylistId,
      hasCachedTree,
      fallbackSourceName,
      loadTree,
      loadTreeFailedMessage,
      resolveSourceName,
      resolveRootPath
    } = params

    try {
      const result = await loadTree()
      const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
      const currentSelectedPlaylistId = isCurrentSelectedSource(sourceKind, sourceKey, libraryType)
        ? Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        : 0
      const resolvedPlaylistId = resolvePlaylistIdForTree(
        treeNodes,
        currentSelectedPlaylistId > 0
          ? currentSelectedPlaylistId
          : hasCachedTree
            ? 0
            : preferredPlaylistId
      )

      setCachedRekordboxSourceTree(sourceCacheKey, treeNodes, {
        selectedPlaylistId: resolvedPlaylistId
      })

      if (!isCurrentSelectedSource(sourceKind, sourceKey, libraryType)) return
      if (requestToken !== sourceTreeRequestToken) return

      runtime.pioneerDeviceLibrary.treeNodes = treeNodes
      runtime.pioneerDeviceLibrary.selectedPlaylistId = resolvedPlaylistId
      runtime.pioneerDeviceLibrary.selectedSourceName =
        resolveSourceName?.(result) || fallbackSourceName
      runtime.pioneerDeviceLibrary.selectedSourceRootPath = resolveRootPath?.(result) || rootPath
    } catch (error) {
      if (!isCurrentSelectedSource(sourceKind, sourceKey, libraryType)) return
      if (requestToken !== sourceTreeRequestToken) return

      if (!hasCachedTree) {
        runtime.pioneerDeviceLibrary.treeNodes = []
        runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
        await confirm({
          title: t('common.error'),
          content: [getErrorMessage(error, loadTreeFailedMessage)],
          confirmShow: false
        })
        return
      }
    } finally {
      if (
        isCurrentSelectedSource(sourceKind, sourceKey, libraryType) &&
        requestToken === sourceTreeRequestToken
      ) {
        runtime.pioneerDeviceLibrary.loading = false
      }
    }
  }

  const refreshPioneerDriveIcons = async (options: { force?: boolean } = {}) => {
    try {
      const previousIcons = [...pioneerDriveIcons.value]
      const result = await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('usb', 'list-removable-drives'),
        { forceRefresh: options.force === true }
      )
      const drives = Array.isArray(result) ? (result as PioneerDriveEntry[]) : []
      const nextIcons = drives
        .filter((item) => item && item.isPioneerDeviceLibrary)
        .flatMap((item) => {
          const libraryTypes = Array.isArray(item.supportedLibraryTypes)
            ? item.supportedLibraryTypes
            : []
          return libraryTypes.map((libraryType) => {
            const tooltip = buildPioneerDriveTooltip(item, libraryType)
            return {
              key: `pioneer-drive:${item.id || item.path}:${libraryType}`,
              name: tooltip,
              grey: usbDriveIconAsset,
              white: usbDriveIconAsset,
              src: usbDriveIconAsset,
              showAlt: false,
              tooltip,
              path: item.path,
              libraryType
            } satisfies PioneerDriveIcon
          })
        })
      pioneerDriveIcons.value = nextIcons

      const nextCacheKeys = new Set(
        nextIcons.map((icon) => resolvePioneerDriveSourceCacheKey(icon)).filter(Boolean)
      )
      for (const icon of previousIcons) {
        const cacheKey = resolvePioneerDriveSourceCacheKey(icon)
        if (!cacheKey || nextCacheKeys.has(cacheKey)) continue
        clearRekordboxSourceCache(cacheKey)
      }

      if (runtime.pioneerDeviceLibrary.selectedSourceKind !== 'usb') return
      if (!runtime.pioneerDeviceLibrary.selectedSourceKey) return
      const target = pioneerDriveIcons.value.find(
        (icon) => icon.key === runtime.pioneerDeviceLibrary.selectedSourceKey
      )
      if (!target) {
        clearSelection()
        switchBackToFilterLibraryAfterExit()
        return
      }
      if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
        updateSelectedIcon(target)
      }
    } catch (error) {
      console.error('[librarySelectArea] refresh pioneer drives failed', error)
      pioneerDriveIcons.value = []
    }
  }

  const refreshDesktopLibraryIcon = async (options: { force?: boolean } = {}) => {
    try {
      const previousIcon = desktopLibraryIcon.value
      const probe = await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'probe'),
        { forceRefresh: options.force === true }
      )
      if (!probe?.available || !probe?.sourceRootPath) {
        clearRekordboxSourceCachesByKind('desktop')
        desktopLibraryIcon.value = null
        if (runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop') {
          clearSelection()
          switchBackToFilterLibraryAfterExit()
        }
        return
      }

      const desktopLabel = t('library.rekordboxDesktopLibrary')
      desktopLibraryIcon.value = {
        key: String(probe.sourceKey || 'rekordbox-desktop').trim(),
        name: desktopLabel,
        grey: rekordboxDesktopIconAsset,
        white: rekordboxDesktopIconAsset,
        src: rekordboxDesktopIconAsset,
        showAlt: false,
        tooltip: desktopLabel,
        rootPath: String(probe.sourceRootPath || '').trim(),
        i18nKey: 'library.rekordboxDesktopLibrary'
      }

      const previousCacheKey = resolveDesktopLibrarySourceCacheKey(previousIcon)
      const nextCacheKey = resolveDesktopLibrarySourceCacheKey(desktopLibraryIcon.value)
      if (previousCacheKey && nextCacheKey && previousCacheKey !== nextCacheKey) {
        clearRekordboxSourceCache(previousCacheKey)
      }

      if (
        runtime.libraryAreaSelected === 'PioneerDeviceLibrary' &&
        runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop' &&
        runtime.pioneerDeviceLibrary.selectedSourceKey === desktopLibraryIcon.value.key
      ) {
        updateSelectedIcon(desktopLibraryIcon.value)
      }
    } catch (error) {
      console.error('[librarySelectArea] refresh desktop rekordbox failed', error)
      desktopLibraryIcon.value = null
    }
  }

  const shouldAutoRefreshSources = () => {
    if (runtime.isProgressing) return false
    if (typeof document === 'undefined') return true
    if (document.visibilityState !== 'visible') return false
    try {
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
        return false
      }
    } catch {}
    return true
  }

  const refreshRekordboxSourceIcons = async (options: { force?: boolean } = {}) => {
    if (runtime.isProgressing) return
    if (!options.force && !shouldAutoRefreshSources()) return
    if (refreshInFlight) {
      await refreshInFlight
      return
    }

    const task = (async () => {
      await Promise.all([refreshPioneerDriveIcons(options), refreshDesktopLibraryIcon(options)])
    })()
    refreshInFlight = task
    try {
      await task
    } finally {
      if (refreshInFlight === task) {
        refreshInFlight = null
      }
    }
  }

  const clearExternalDjSelection = () => {
    runtime.externalDjLibrary.selectedKind = null
    runtime.externalDjLibrary.selectedSourceKey = ''
    runtime.externalDjLibrary.selectedSourcePath = ''
  }

  const clickPioneerDriveIcon = async (item: PioneerDriveIcon) => {
    if (!item.path) return
    clearExternalDjSelection()
    const sourceCacheKey = resolvePioneerDriveSourceCacheKey(item)
    const cachedTree = getCachedRekordboxSourceTree(sourceCacheKey)
    const preferredPlaylistId =
      runtime.pioneerDeviceLibrary.selectedSourceKind === 'usb' &&
      runtime.pioneerDeviceLibrary.selectedSourceKey === item.key &&
      runtime.pioneerDeviceLibrary.selectedLibraryType === item.libraryType
        ? Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        : getRememberedRekordboxSourceSelectedPlaylist(sourceCacheKey)
    const restoredPlaylistId = cachedTree
      ? resolvePlaylistIdForTree(cachedTree.treeNodes, preferredPlaylistId)
      : 0

    runtime.pioneerDeviceLibrary.selectedSourceKey = item.key
    runtime.pioneerDeviceLibrary.selectedSourceName = item.tooltip
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = item.path
    runtime.pioneerDeviceLibrary.selectedSourceKind = 'usb'
    runtime.pioneerDeviceLibrary.selectedLibraryType = item.libraryType
    runtime.pioneerDeviceLibrary.selectedPlaylistId = restoredPlaylistId
    runtime.pioneerDeviceLibrary.loading = !cachedTree
    runtime.pioneerDeviceLibrary.treeNodes = cachedTree ? cachedTree.treeNodes : []
    runtime.songsArea.songListUUID = ''
    updateSelectedIcon(item)
    runtime.libraryAreaSelected = 'PioneerDeviceLibrary'
    emitLibrarySelectedChange({ name: 'PioneerDeviceLibrary' })

    if (cachedTree && !shouldRefreshRekordboxSourceTree(sourceCacheKey)) return

    const task = loadSourceTree({
      sourceKind: 'usb',
      sourceKey: item.key,
      sourceCacheKey,
      rootPath: item.path,
      libraryType: item.libraryType,
      preferredPlaylistId,
      hasCachedTree: Boolean(cachedTree),
      fallbackSourceName: item.tooltip,
      loadTree: () =>
        window.electron.ipcRenderer.invoke(
          buildRekordboxSourceChannel('usb', 'load-tree'),
          item.path,
          item.libraryType
        ) as Promise<RekordboxSourceTreeLoadResult>,
      loadTreeFailedMessage: t('pioneer.loadTreeFailed'),
      resolveSourceName: (result) => String(result?.driveName || '').trim() || item.tooltip,
      resolveRootPath: () => item.path
    })
    if (!cachedTree) {
      await task
    } else {
      void task
    }
  }

  const clickDesktopLibraryIcon = async () => {
    const icon = desktopLibraryIcon.value
    if (!icon?.rootPath) return
    clearExternalDjSelection()
    const sourceCacheKey = resolveDesktopLibrarySourceCacheKey(icon)
    const cachedTree = getCachedRekordboxSourceTree(sourceCacheKey)
    const preferredPlaylistId =
      runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop' &&
      runtime.pioneerDeviceLibrary.selectedSourceKey === icon.key
        ? Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        : getRememberedRekordboxSourceSelectedPlaylist(sourceCacheKey)
    const restoredPlaylistId = cachedTree
      ? resolvePlaylistIdForTree(cachedTree.treeNodes, preferredPlaylistId)
      : 0

    runtime.pioneerDeviceLibrary.selectedSourceKey = icon.key
    runtime.pioneerDeviceLibrary.selectedSourceName = t('library.rekordboxDesktopLibrary')
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = icon.rootPath
    runtime.pioneerDeviceLibrary.selectedSourceKind = 'desktop'
    runtime.pioneerDeviceLibrary.selectedLibraryType = 'masterDb'
    runtime.pioneerDeviceLibrary.selectedPlaylistId = restoredPlaylistId
    runtime.pioneerDeviceLibrary.loading = !cachedTree
    runtime.pioneerDeviceLibrary.treeNodes = cachedTree ? cachedTree.treeNodes : []
    runtime.songsArea.songListUUID = ''
    updateSelectedIcon(icon)
    runtime.libraryAreaSelected = 'PioneerDeviceLibrary'
    emitLibrarySelectedChange({ name: 'PioneerDeviceLibrary' })

    if (cachedTree && !shouldRefreshRekordboxSourceTree(sourceCacheKey)) return

    const task = loadSourceTree({
      sourceKind: 'desktop',
      sourceKey: icon.key,
      sourceCacheKey,
      rootPath: icon.rootPath,
      libraryType: 'masterDb',
      preferredPlaylistId,
      hasCachedTree: Boolean(cachedTree),
      fallbackSourceName: t('library.rekordboxDesktopLibrary'),
      loadTree: () =>
        window.electron.ipcRenderer.invoke(
          buildRekordboxSourceChannel('desktop', 'load-tree')
        ) as Promise<RekordboxSourceTreeLoadResult>,
      loadTreeFailedMessage: t('rekordboxDesktop.loadTreeFailed'),
      resolveSourceName: () => t('library.rekordboxDesktopLibrary'),
      resolveRootPath: (result) => String(result?.sourceRootPath || '').trim() || icon.rootPath
    })
    if (!cachedTree) {
      await task
    } else {
      void task
    }
  }

  const runWithWholeLibraryArtistImporting = async <T>(
    source: WholeLibraryArtistImportBusySource,
    task: () => Promise<T>
  ): Promise<T> => {
    wholeLibraryArtistImportBusy.value = source
    try {
      return await task()
    } finally {
      if (wholeLibraryArtistImportBusy.value?.physicalSourceKey === source.physicalSourceKey) {
        wholeLibraryArtistImportBusy.value = null
      }
    }
  }

  const importDesktopWholeLibraryArtists = async () => {
    const icon = desktopLibraryIcon.value
    if (!icon?.rootPath || isWholeLibraryArtistImporting()) return
    const source = {
      sourceKind: 'desktop' as const,
      physicalSourceKey: resolvePhysicalSourceKey('desktop', icon.rootPath),
      sourceName: icon.tooltip || t('library.rekordboxDesktopLibrary')
    }
    await importCuratedArtistsFromPioneerSource({
      scope: 'wholeLibrary',
      sourceKind: 'desktop',
      sourceRootPath: icon.rootPath,
      sourceLibraryType: 'masterDb',
      sourceName: source.sourceName,
      runWithBusy: (task) => runWithWholeLibraryArtistImporting(source, task),
      isBusy: isWholeLibraryArtistImporting
    })
  }

  const importPioneerDriveWholeLibraryArtists = async (item: PioneerDriveIcon) => {
    if (!item.path || isWholeLibraryArtistImporting()) return
    const source = {
      sourceKind: 'usb' as const,
      physicalSourceKey: resolvePhysicalSourceKey('usb', item.path),
      sourceName: item.tooltip
    }
    await importCuratedArtistsFromPioneerSource({
      scope: 'wholeLibrary',
      sourceKind: 'usb',
      sourceRootPath: item.path,
      sourceLibraryType: item.libraryType,
      sourceName: source.sourceName,
      runWithBusy: (task) => runWithWholeLibraryArtistImporting(source, task),
      isBusy: isWholeLibraryArtistImporting
    })
  }

  const isEjectingPioneerDriveIcon = (item: PioneerDriveIcon) =>
    ejectingDriveKeys.value.includes(item.key)

  const suspendSelectedPioneerDriveBeforeEject = async (item: PioneerDriveIcon) => {
    if (runtime.pioneerDeviceLibrary.selectedSourceKey !== item.key) return null

    const snapshot = snapshotSelection()
    clearSelection()
    if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
      runtime.songsArea.songListUUID = ''
    }

    await nextTick()
    await waitForUiIdle(250)
    return snapshot
  }

  const buildPioneerDriveEjectErrorContent = (result?: PioneerDriveEjectResult) => {
    if (result?.code === 'INVALID_PATH') {
      return [t('library.ejectUsbDriveInvalidPath')]
    }

    const content = [t('library.ejectUsbDriveFailed')]
    const detail = String(result?.detail || '').trim()
    if (detail) {
      content.push(detail)
    }
    if (result?.code === 'EJECT_TIMEOUT' || result?.code === 'EJECT_COMMAND_FAILED') {
      content.push(t('library.ejectUsbDriveFailedHint'))
    }
    return content
  }

  const ejectPioneerDriveIcon = async (item: PioneerDriveIcon) => {
    if (isEjectingPioneerDriveIcon(item)) return
    ejectingDriveKeys.value = [...ejectingDriveKeys.value, item.key]
    const suspendedSelection = await suspendSelectedPioneerDriveBeforeEject(item)
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('usb', 'eject-drive'),
        item.path
      )) as PioneerDriveEjectResult

      if (!result?.success) {
        await confirm({
          title: t('common.error'),
          content: buildPioneerDriveEjectErrorContent(result),
          confirmShow: false,
          innerHeight: 0,
          canCopyText: true
        })
        if (suspendedSelection) {
          restoreSelection(suspendedSelection)
        }
        return
      }

      if (suspendedSelection || runtime.pioneerDeviceLibrary.selectedSourceKey === item.key) {
        clearSelection()
        switchBackToFilterLibraryAfterExit()
      }
      clearRekordboxSourceCache(resolvePioneerDriveSourceCacheKey(item))
      pioneerDriveIcons.value = pioneerDriveIcons.value.filter((icon) => icon.key !== item.key)
      await refreshPioneerDriveIcons({ force: true })
    } catch (error) {
      if (suspendedSelection) {
        restoreSelection(suspendedSelection)
      }
      await confirm({
        title: t('common.error'),
        content: buildPioneerDriveEjectErrorContent({
          success: false,
          path: item.path,
          code: 'EJECT_COMMAND_FAILED',
          detail: getErrorMessage(error, '')
        }),
        confirmShow: false,
        innerHeight: 0,
        canCopyText: true
      })
    } finally {
      ejectingDriveKeys.value = ejectingDriveKeys.value.filter((key) => key !== item.key)
    }
  }

  const loadPioneerDriveTreeForMenu = async (item: PioneerDriveIcon) => {
    const sourceCacheKey = resolvePioneerDriveSourceCacheKey(item)
    const cachedTree = getCachedRekordboxSourceTree(sourceCacheKey)
    if (cachedTree && !shouldRefreshRekordboxSourceTree(sourceCacheKey)) {
      return cachedTree.treeNodes
    }
    const result = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('usb', 'load-tree'),
      item.path,
      item.libraryType
    )) as RekordboxSourceTreeLoadResult
    const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
    setCachedRekordboxSourceTree(sourceCacheKey, treeNodes, {
      selectedPlaylistId: getRememberedRekordboxSourceSelectedPlaylist(sourceCacheKey)
    })
    return treeNodes
  }

  const loadDesktopLibraryTreeForMenu = async (icon: RekordboxDesktopIcon) => {
    const sourceCacheKey = resolveDesktopLibrarySourceCacheKey(icon)
    const cachedTree = getCachedRekordboxSourceTree(sourceCacheKey)
    if (cachedTree && !shouldRefreshRekordboxSourceTree(sourceCacheKey)) {
      return {
        treeNodes: cachedTree.treeNodes,
        rootPath: icon.rootPath
      }
    }
    const result = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'load-tree')
    )) as RekordboxSourceTreeLoadResult
    const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
    const rootPath = String(result?.sourceRootPath || icon.rootPath || '').trim()
    setCachedRekordboxSourceTree(sourceCacheKey, treeNodes, {
      selectedPlaylistId: getRememberedRekordboxSourceSelectedPlaylist(sourceCacheKey)
    })
    return { treeNodes, rootPath }
  }

  const openSimilarTracksForPioneerDriveIcon = async (item: PioneerDriveIcon) => {
    try {
      const treeNodes = await loadPioneerDriveTreeForMenu(item)
      const seeds = await collectRekordboxSimilarTracksSeeds({
        nodes: treeNodes,
        sourceKind: 'usb',
        sourceRootPath: item.path,
        sourceLibraryType: item.libraryType
      })
      await openBatchSimilarTracksDialogForSeeds(seeds)
    } catch (error) {
      await confirm({
        title: t('common.error'),
        content: [getErrorMessage(error, t('pioneer.loadTreeFailed'))],
        confirmShow: false
      })
    }
  }

  const openSimilarTracksForDesktopLibraryIcon = async (icon: RekordboxDesktopIcon) => {
    try {
      const { treeNodes, rootPath } = await loadDesktopLibraryTreeForMenu(icon)
      const seeds = await collectRekordboxSimilarTracksSeeds({
        nodes: treeNodes,
        sourceKind: 'desktop',
        sourceRootPath: rootPath,
        sourceLibraryType: 'masterDb'
      })
      await openBatchSimilarTracksDialogForSeeds(seeds)
    } catch (error) {
      await confirm({
        title: t('common.error'),
        content: [getErrorMessage(error, t('rekordboxDesktop.loadTreeFailed'))],
        confirmShow: false
      })
    }
  }

  // 共享：收集库内曲目(带进度) → 计算指纹并入库
  const runLibraryFingerprintScan = async (
    collectSeeds: (onProgress: (now: number, total: number) => void) => Promise<ISongInfo[]>,
    fallbackErrKey: string
  ) => {
    const progressId = `fpScan_${Date.now()}`
    let seeds: ISongInfo[]
    try {
      seeds = await collectSeeds((now, total) =>
        emitter.emit('renderer-progressSet', {
          id: progressId,
          titleKey: 'fingerprints.collectingLibraryTracks',
          now,
          total,
          isInitial: now === 0
        })
      )
    } catch (error) {
      emitter.emit('renderer-progressSet', { id: progressId, dismiss: true })
      await confirm({
        title: t('common.error'),
        content: [getErrorMessage(error, t(fallbackErrKey))],
        confirmShow: false
      })
      return
    }
    // 收集结束，先关掉收集进度条
    emitter.emit('renderer-progressSet', { id: progressId, dismiss: true })

    if (seeds.length === 0) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('fingerprints.noTracksInLibrary')],
        confirmShow: false
      })
      return
    }

    // 指纹计算阶段：后端 addExistingFromPaths 会另开 import 组进度
    await analyzeFingerprintsForPaths(
      seeds.map((s) => s.filePath),
      { origin: 'rekordboxLibrary' }
    )
  }

  const scanFingerprintsForDesktopLibraryIcon = (icon: RekordboxDesktopIcon) =>
    runLibraryFingerprintScan(async (onProgress) => {
      const { treeNodes, rootPath } = await loadDesktopLibraryTreeForMenu(icon)
      return collectRekordboxSimilarTracksSeeds({
        nodes: treeNodes,
        sourceKind: 'desktop',
        sourceRootPath: rootPath,
        sourceLibraryType: 'masterDb',
        onProgress
      })
    }, 'rekordboxDesktop.loadTreeFailed')

  const scanFingerprintsForPioneerDriveIcon = (item: PioneerDriveIcon) =>
    runLibraryFingerprintScan(async (onProgress) => {
      const treeNodes = await loadPioneerDriveTreeForMenu(item)
      return collectRekordboxSimilarTracksSeeds({
        nodes: treeNodes,
        sourceKind: 'usb',
        sourceRootPath: item.path,
        sourceLibraryType: item.libraryType,
        onProgress
      })
    }, 'pioneer.loadTreeFailed')

  const handlePioneerDriveContextmenu = async (event: MouseEvent, item: PioneerDriveIcon) => {
    if (isEjectingPioneerDriveIcon(item)) return
    event.preventDefault()
    const sourceBusy = isImportingPioneerDriveIcon(item)
    const result = await rightClickMenu({
      menuArr: [
        [buildWholeLibraryImportMenuItem()],
        [
          buildSourceBusyMenuItem(
            'similarTracks.menu',
            sourceBusy,
            'pioneer.sourceReadingBusyReason'
          )
        ],
        [
          buildSourceBusyMenuItem(
            'fingerprints.scanLibraryToFingerprint',
            sourceBusy,
            'pioneer.sourceReadingBusyReason'
          )
        ],
        [
          buildSourceBusyMenuItem(
            'library.ejectUsbDrive',
            sourceBusy,
            'pioneer.sourceEjectBusyReason'
          )
        ]
      ],
      clickEvent: event
    })
    if (result === 'cancel') return
    if (result.menuName === 'pioneer.importWholeLibraryArtistsToCurated') {
      await importPioneerDriveWholeLibraryArtists(item)
      return
    }
    if (result.menuName === 'similarTracks.menu') {
      await openSimilarTracksForPioneerDriveIcon(item)
      return
    }
    if (result.menuName === 'fingerprints.scanLibraryToFingerprint') {
      await scanFingerprintsForPioneerDriveIcon(item)
      return
    }
    if (result.menuName === 'library.ejectUsbDrive') {
      await ejectPioneerDriveIcon(item)
    }
  }

  const handleDesktopLibraryContextmenu = async (event: MouseEvent) => {
    const icon = desktopLibraryIcon.value
    if (!icon?.rootPath) return
    event.preventDefault()
    const sourceBusy = isImportingDesktopLibraryIcon.value
    const result = await rightClickMenu({
      menuArr: [
        [buildWholeLibraryImportMenuItem()],
        [
          buildSourceBusyMenuItem(
            'similarTracks.menu',
            sourceBusy,
            'pioneer.sourceReadingBusyReason'
          )
        ],
        [
          buildSourceBusyMenuItem(
            'fingerprints.scanLibraryToFingerprint',
            sourceBusy,
            'pioneer.sourceReadingBusyReason'
          )
        ]
      ],
      clickEvent: event
    })
    if (result === 'cancel') return
    if (result.menuName === 'pioneer.importWholeLibraryArtistsToCurated') {
      await importDesktopWholeLibraryArtists()
      return
    }
    if (result.menuName === 'similarTracks.menu') {
      await openSimilarTracksForDesktopLibraryIcon(icon)
      return
    }
    if (result.menuName === 'fingerprints.scanLibraryToFingerprint') {
      await scanFingerprintsForDesktopLibraryIcon(icon)
    }
  }

  const isSelectedPioneerDriveIcon = (item: PioneerDriveIcon) =>
    runtime.libraryAreaSelected === 'PioneerDeviceLibrary' &&
    runtime.pioneerDeviceLibrary.selectedSourceKind === 'usb' &&
    runtime.pioneerDeviceLibrary.selectedSourceKey === item.key

  const isSelectedDesktopLibraryIcon = computed(
    () =>
      runtime.libraryAreaSelected === 'PioneerDeviceLibrary' &&
      runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop' &&
      runtime.pioneerDeviceLibrary.selectedSourceKey === desktopLibraryIcon.value?.key
  )

  const handleWindowFocus = () => {
    void refreshRekordboxSourceIcons()
  }

  const handleDocumentVisibilityChange = () => {
    if (typeof document === 'undefined') return
    if (document.visibilityState !== 'visible') return
    void refreshRekordboxSourceIcons()
  }

  onMounted(() => {
    void refreshRekordboxSourceIcons({ force: true })
    refreshTimer = setInterval(() => {
      void refreshRekordboxSourceIcons()
    }, SOURCE_ICON_AUTO_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', handleWindowFocus)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleDocumentVisibilityChange)
    }
  })

  onUnmounted(() => {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
    window.removeEventListener('focus', handleWindowFocus)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleDocumentVisibilityChange)
    }
  })

  watch(
    () => runtime.libraryAreaSelected,
    (next) => {
      if (next !== 'PioneerDeviceLibrary') return
      void refreshRekordboxSourceIcons({ force: true })
    }
  )

  return {
    pioneerDriveIcons,
    pioneerDriveGroups,
    desktopLibraryIcon,
    refreshRekordboxSourceIcons,
    clickPioneerDriveIcon,
    clickDesktopLibraryIcon,
    handlePioneerDriveContextmenu,
    handleDesktopLibraryContextmenu,
    isEjectingPioneerDriveIcon,
    isImportingPioneerDriveIcon,
    isImportingDesktopLibraryIcon,
    isSelectedPioneerDriveIcon,
    isSelectedDesktopLibraryIcon
  }
}
