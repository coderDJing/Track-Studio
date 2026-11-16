import { computed, markRaw, onUnmounted, ref, type ComputedRef, type ShallowRef } from 'vue'
import { type ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { t } from '@renderer/utils/translate'
import dropIntoDialog from '@renderer/components/dropIntoDialog'
import {
  MIXTAPE_DRAG_SESSION_MIME,
  buildMixtapeDragSessionText,
  type MixtapeDragSessionItem,
  type MixtapeDragSessionPayload,
  type MixtapeDragSessionPreview
} from '@shared/mixtapeDragSession'
import {
  buildMixtapeDragSessionItem,
  createMixtapeDragSessionToken
} from '@renderer/utils/mixtapeDragSession'
import type { ISongInfo } from '../../../../../../types/globals'
import { isNeteasePendingPath, isNeteasePreviewUrl } from '@shared/netease'
import { isNeteaseStoreCopyOnlySource } from '@renderer/utils/libraryTransfer'

type StartDragSongsOptions = {
  songFilePaths?: string[]
  sourceMixtapeItemIds?: string[]
  dragMode?: 'internal' | 'external'
}

type UseSongsAreaDragAndDropOptions = {
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  isMixtapeListView: ComputedRef<boolean>
  getRowKey: (song: ISongInfo) => string
  resolveSelectedFilePaths: (keys?: string[]) => string[]
  activatePaneIfNeeded: () => void
  resolveCoreLibraryNameBySongListUUID: (uuid: string) => string
  startDragSongs: (
    songOrSongs: ISongInfo | ISongInfo[],
    sourceLibraryName: string,
    sourceSongListUUID: string,
    options?: StartDragSongsOptions
  ) => string[]
  scheduleDragCleanup: (delayMs?: number) => void
  handleDropToSongList: (targetSongListUUID: string, targetLibraryName: string) => Promise<string[]>
  openSongList: () => Promise<void>
  applyFiltersAndSorting: () => void
}

export const useSongsAreaDragAndDrop = (options: UseSongsAreaDragAndDropOptions) => {
  const runtime = useRuntimeStore()
  const dragHintVisible = ref(false)
  const dragHintMode = ref<'internal' | 'external'>('internal')
  const paneDropHover = ref(false)
  const paneDropHoverMode = ref<'internal' | 'external' | ''>('')
  const clipboardHintVisible = ref(false)
  const clipboardHintText = ref('')
  const isAltPressed = ref(false)
  const isCtrlPressed = ref(false)

  let paneDropEnterDepth = 0
  let dragHintCleanup: (() => void) | null = null
  let clipboardHintTimer: ReturnType<typeof setTimeout> | null = null
  let modifierKeyCleanup: (() => void) | null = null

  const hideDragHint = () => {
    dragHintVisible.value = false
    if (dragHintCleanup) {
      dragHintCleanup()
      dragHintCleanup = null
    }
  }

  const attachDragHintListeners = () => {
    if (dragHintCleanup) return
    const onMouseUp = () => hideDragHint()
    const onDragEnd = () => hideDragHint()
    const onBlur = () => hideDragHint()
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('dragend', onDragEnd)
    window.addEventListener('blur', onBlur)
    dragHintCleanup = () => {
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('dragend', onDragEnd)
      window.removeEventListener('blur', onBlur)
    }
  }

  const showDragHint = (mode: 'internal' | 'external') => {
    if (mode === 'external') {
      hideDragHint()
      return
    }
    dragHintMode.value = mode
    dragHintVisible.value = true
    attachDragHintListeners()
  }

  const showClipboardHint = (message: string) => {
    clipboardHintText.value = message
    clipboardHintVisible.value = true
    if (clipboardHintTimer) {
      clearTimeout(clipboardHintTimer)
    }
    clipboardHintTimer = setTimeout(() => {
      clipboardHintVisible.value = false
    }, 2000)
  }

  const handleClipboardHint = (payload?: { action?: 'copy' | 'cut'; message?: string }) => {
    const message = payload?.message
    if (message) {
      showClipboardHint(message)
      return
    }
    const action = payload?.action
    if (action === 'cut') {
      showClipboardHint(t('tracks.clipboardCutSuccess'))
      return
    }
    if (action === 'copy') {
      showClipboardHint(t('tracks.clipboardCopySuccess'))
    }
  }

  const attachModifierKeyListeners = () => {
    if (modifierKeyCleanup) return
    const updateModifierState = (event: KeyboardEvent) => {
      isAltPressed.value = event.altKey
      isCtrlPressed.value = event.ctrlKey
    }
    const onKeyDown = (event: KeyboardEvent) => {
      updateModifierState(event)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      updateModifierState(event)
    }
    const onBlur = () => {
      isAltPressed.value = false
      isCtrlPressed.value = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    modifierKeyCleanup = () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }

  const resetPaneDropHover = () => {
    paneDropHover.value = false
    paneDropHoverMode.value = ''
    paneDropEnterDepth = 0
  }

  const isInternalSongDragEvent = (event: DragEvent) =>
    runtime.songDragActive ||
    runtime.draggingSongFilePaths.length > 0 ||
    event.dataTransfer?.types?.includes('application/x-song-drag')

  const isExternalFileDragEvent = (event: DragEvent) => {
    const types = event.dataTransfer?.types
    if (types?.includes('Files')) return true
    const items = event.dataTransfer?.items
    if (!items || items.length === 0) return false
    return Array.from(items).some((item) => item.kind === 'file')
  }

  const isPlainSongListDropTarget = computed(
    () =>
      libraryUtils.getLibraryTreeByUUID(options.songsAreaState.songListUUID)?.type === 'songList'
  )
  const isSetListDropTarget = computed(
    () => libraryUtils.getLibraryTreeByUUID(options.songsAreaState.songListUUID)?.type === 'setList'
  )

  const shouldBlockParentDropZone = computed(() => runtime.songsAreaPanels.splitEnabled)

  const acceptPaneDrag = (
    event: DragEvent
  ): { accepted: boolean; mode: 'internal' | 'external' | '' } => {
    if (isInternalSongDragEvent(event)) {
      if (
        (!isPlainSongListDropTarget.value && !isSetListDropTarget.value) ||
        runtime.dragTableHeader
      ) {
        return { accepted: shouldBlockParentDropZone.value, mode: '' }
      }
      return { accepted: true, mode: 'internal' }
    }
    if (isExternalFileDragEvent(event)) {
      if (!isPlainSongListDropTarget.value) {
        return { accepted: shouldBlockParentDropZone.value, mode: '' }
      }
      return { accepted: true, mode: 'external' }
    }
    return { accepted: false, mode: '' }
  }

  const handlePaneDragEnter = (event: DragEvent) => {
    const { accepted, mode } = acceptPaneDrag(event)
    if (!accepted) return
    event.preventDefault()
    event.stopPropagation()
    paneDropEnterDepth += 1
    paneDropHover.value = mode !== ''
    paneDropHoverMode.value = mode
  }

  const handlePaneDragOver = (event: DragEvent) => {
    const { accepted, mode } = acceptPaneDrag(event)
    if (!accepted) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect =
        mode === 'external'
          ? 'copy'
          : mode === 'internal'
            ? isSetListDropTarget.value ||
              isNeteaseStoreCopyOnlySource(runtime.dragSourceSongListUUID)
              ? 'copy'
              : 'move'
            : 'none'
    }
    if (mode) {
      options.activatePaneIfNeeded()
    }
    paneDropHover.value = mode !== ''
    paneDropHoverMode.value = mode
  }

  const handlePaneDragLeave = (event: DragEvent) => {
    const { accepted } = acceptPaneDrag(event)
    if (!accepted) return
    event.stopPropagation()
    paneDropEnterDepth = Math.max(0, paneDropEnterDepth - 1)
    if (paneDropEnterDepth === 0) {
      resetPaneDropHover()
    }
  }

  const handlePaneDrop = async (event: DragEvent) => {
    const { accepted, mode } = acceptPaneDrag(event)
    if (!accepted) return
    event.preventDefault()
    event.stopPropagation()
    resetPaneDropHover()
    if (!mode) return
    options.activatePaneIfNeeded()

    if (mode === 'internal') {
      const sourceSongListUUID = runtime.dragSourceSongListUUID
      const targetSongListUUID = options.songsAreaState.songListUUID
      if (!targetSongListUUID || !sourceSongListUUID || sourceSongListUUID === targetSongListUUID) {
        return
      }
      const movedSongPaths = await options.handleDropToSongList(
        targetSongListUUID,
        runtime.libraryAreaSelected
      )
      if (movedSongPaths.length > 0) {
        await options.openSongList()
      }
      return
    }

    if (event.dataTransfer === null || !options.songsAreaState.songListUUID) return
    const filePaths = Array.from(event.dataTransfer.files)
      .map((item) => window.api.showFilesPath(item))
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
    if (!filePaths.length) return
    const libraryName = options.resolveCoreLibraryNameBySongListUUID(
      options.songsAreaState.songListUUID
    )
    if (!libraryName) return
    const result = await dropIntoDialog({
      songListUuid: options.songsAreaState.songListUUID,
      libraryName
    })
    if (result === 'cancel') return
    runtime.importingSongListUUID = result.importingSongListUUID
    runtime.isProgressing = true
    window.electron.ipcRenderer.send('startImportSongs', {
      filePaths,
      songListPath: result.songListPath,
      isDeleteSourceFile: result.isDeleteSourceFile,
      isComparisonSongFingerprint: result.isComparisonSongFingerprint,
      isPushSongFingerprintLibrary: result.isPushSongFingerprintLibrary,
      deduplicateMode: result.deduplicateMode,
      songListUUID: result.importingSongListUUID
    })
  }

  const isMacPlatform = computed(() => runtime.setting.platform === 'darwin')
  const dragHintModifier = computed(() =>
    isMacPlatform.value ? t('tracks.dragHintModifierOption') : t('tracks.dragHintModifierCtrl')
  )
  const dragHintTarget = computed(() =>
    isMacPlatform.value ? t('tracks.dragHintTargetFinder') : t('tracks.dragHintTargetExplorer')
  )
  const dragHintTitle = computed(() =>
    dragHintMode.value === 'external'
      ? t('tracks.dragHintExternalTitle')
      : t('tracks.dragHintInternalTitle')
  )
  const dragHintDesc = computed(() =>
    dragHintMode.value === 'external'
      ? t('tracks.dragHintExternalSub', { target: dragHintTarget.value })
      : t('tracks.dragHintInternalSub', {
          modifier: dragHintModifier.value,
          target: dragHintTarget.value
        })
  )

  let activeMixtapeDragSessionToken = ''

  const cancelActiveMixtapeDragSession = (delayMs = 0) => {
    if (!activeMixtapeDragSessionToken) return
    const token = activeMixtapeDragSessionToken
    activeMixtapeDragSessionToken = ''
    if (delayMs > 0) {
      setTimeout(() => {
        window.electron.ipcRenderer.send('mixtape-drag-session:cancel', token)
      }, delayMs)
      return
    }
    window.electron.ipcRenderer.send('mixtape-drag-session:cancel', token)
  }

  const resolveSelectedSongsInVisibleOrder = (
    selectedKeys: string[],
    fallbackSong: ISongInfo,
    keyResolver: (song: ISongInfo) => string
  ) => {
    const selectedSet = new Set(selectedKeys.filter(Boolean))
    const visibleSongs = options.songsAreaState.songInfoArr.filter((item) =>
      selectedSet.has(keyResolver(item))
    )
    if (visibleSongs.length > 0) return visibleSongs
    return fallbackSong?.filePath ? [fallbackSong] : []
  }

  const registerMixtapeDragSession = (
    event: DragEvent,
    items: MixtapeDragSessionItem[],
    sourceSongListUUID: string
  ) => {
    const normalizedItems = items.filter((item) => item.filePath)
    if (!normalizedItems.length) return
    cancelActiveMixtapeDragSession()
    const token = createMixtapeDragSessionToken()
    const payload: MixtapeDragSessionPayload = {
      token,
      sourceSongListUUID,
      items: normalizedItems
    }
    const preview: MixtapeDragSessionPreview = {
      token,
      sourceSongListUUID,
      itemCount: normalizedItems.length
    }
    activeMixtapeDragSessionToken = token
    window.electron.ipcRenderer.send('mixtape-drag-session:create', payload)
    if (!event.dataTransfer) return
    try {
      event.dataTransfer.setData(MIXTAPE_DRAG_SESSION_MIME, JSON.stringify(preview))
      event.dataTransfer.setData('text/plain', buildMixtapeDragSessionText(token))
    } catch {}
  }

  const handleSongDragStart = (event: DragEvent, song: ISongInfo) => {
    if (!options.songsAreaState.songListUUID) return
    // 网易云歌单里的曲目在盘上没有文件。内部拖到 SET 会先入单再后台下载；
    // 拖到筛选库 / 精选库 / 混音库，或按修饰键往外拖，仍然先拦住并提示。
    const rowKey = options.getRowKey(song)
    const isSelected = options.songsAreaState.selectedSongFilePath.includes(rowKey)

    if (!isSelected || options.songsAreaState.selectedSongFilePath.length === 0) {
      options.songsAreaState.selectedSongFilePath = [rowKey]
    }

    const selectedKeysSnapshot = options.songsAreaState.selectedSongFilePath.length
      ? [...options.songsAreaState.selectedSongFilePath]
      : [rowKey]
    const songFilePaths = options.resolveSelectedFilePaths(selectedKeysSnapshot)
    const isStreamOnlyDrag =
      isNeteasePreviewUrl(song.filePath) ||
      isNeteasePendingPath(song.filePath) ||
      songFilePaths.some(
        (filePath) => isNeteasePreviewUrl(filePath) || isNeteasePendingPath(filePath)
      )

    const hasExternalModifier = isMacPlatform.value
      ? event.altKey ||
        isAltPressed.value ||
        (typeof event.getModifierState === 'function' && event.getModifierState('Alt'))
      : event.ctrlKey ||
        isCtrlPressed.value ||
        (typeof event.getModifierState === 'function' && event.getModifierState('Control'))

    if (hasExternalModifier) {
      if (isStreamOnlyDrag) {
        event.preventDefault()
        showClipboardHint(t('netease.streamOnlyDragHint'))
        return
      }
      cancelActiveMixtapeDragSession()
      options.startDragSongs(
        song,
        runtime.libraryAreaSelected,
        options.songsAreaState.songListUUID,
        {
          songFilePaths,
          dragMode: 'external'
        }
      )
      showDragHint('external')
      event.preventDefault()
      window.electron.ipcRenderer.send('startExternalSongDrag', {
        filePaths: songFilePaths
      })
      options.scheduleDragCleanup(30000)
      return
    }

    if (options.isMixtapeListView.value) {
      const listUuid = options.songsAreaState.songListUUID
      const selectedSet = new Set(selectedKeysSnapshot)
      const selectedSongs = options.songsAreaState.songInfoArr.filter(
        (item) => !!item.mixtapeItemId && selectedSet.has(item.mixtapeItemId)
      )
      const selectedItemIds = selectedSongs
        .map((item) => item.mixtapeItemId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      const selectedSongFilePaths = selectedSongs
        .map((item) => item.filePath)
        .filter((path): path is string => typeof path === 'string' && path.length > 0)
      const fallbackId =
        typeof song.mixtapeItemId === 'string' && song.mixtapeItemId.length > 0
          ? [song.mixtapeItemId]
          : []
      const fallbackSongPath =
        typeof song.filePath === 'string' && song.filePath.length > 0 ? [song.filePath] : []
      const itemIds = selectedItemIds.length > 0 ? selectedItemIds : fallbackId
      const dragSongFilePaths =
        selectedSongFilePaths.length > 0 ? selectedSongFilePaths : fallbackSongPath
      if (!listUuid || itemIds.length === 0) return
      const originPathSnapshot = libraryUtils.buildDisplayPathByUuid(listUuid)
      const dragSessionSongs = selectedSongs.length > 0 ? selectedSongs : [song]
      const dragSessionItems = dragSessionSongs
        .map((item) =>
          buildMixtapeDragSessionItem({
            song: item,
            filePath: item.filePath,
            originPathSnapshot,
            sourceSongListUUID: listUuid,
            sourceItemId:
              typeof item.mixtapeItemId === 'string' && item.mixtapeItemId.trim()
                ? item.mixtapeItemId.trim()
                : undefined
          })
        )
        .filter((item): item is NonNullable<typeof item> => item !== null)
      showDragHint('internal')
      options.startDragSongs(
        song,
        runtime.libraryAreaSelected,
        options.songsAreaState.songListUUID,
        {
          songFilePaths: dragSongFilePaths,
          sourceMixtapeItemIds: itemIds
        }
      )
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'copyMove'
        event.dataTransfer.setData(
          'application/x-mixtape-reorder',
          JSON.stringify({
            sourceSongListUUID: listUuid,
            itemIds
          })
        )
        event.dataTransfer.setData(
          'application/x-song-drag',
          JSON.stringify({
            type: 'song',
            sourceLibraryName: runtime.libraryAreaSelected,
            sourceSongListUUID: options.songsAreaState.songListUUID,
            sourceMixtapeItemIds: itemIds
          })
        )
      }
      registerMixtapeDragSession(event, dragSessionItems, listUuid)
      return
    }

    const originPathSnapshot = libraryUtils.buildDisplayPathByUuid(
      options.songsAreaState.songListUUID
    )
    const dragSessionSongs = resolveSelectedSongsInVisibleOrder(
      selectedKeysSnapshot,
      song,
      (item) => options.getRowKey(item)
    )
    const dragSessionItems = dragSessionSongs
      .map((item) =>
        buildMixtapeDragSessionItem({
          song: item,
          filePath: item.filePath,
          originPathSnapshot,
          sourceSongListUUID: options.songsAreaState.songListUUID
        })
      )
      .filter((item): item is NonNullable<typeof item> => item !== null)
    showDragHint('internal')
    options.startDragSongs(song, runtime.libraryAreaSelected, options.songsAreaState.songListUUID)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = isNeteaseStoreCopyOnlySource(
        options.songsAreaState.songListUUID
      )
        ? 'copy'
        : 'copyMove'
      event.dataTransfer.setData(
        'application/x-song-drag',
        JSON.stringify({
          type: 'song',
          sourceLibraryName: runtime.libraryAreaSelected,
          sourceSongListUUID: options.songsAreaState.songListUUID
        })
      )
    }
    registerMixtapeDragSession(event, dragSessionItems, options.songsAreaState.songListUUID)
  }

  const handleSongDragEnd = () => {
    cancelActiveMixtapeDragSession(2000)
    runtime.songDragSuppressClickUntilMs = Date.now() + 450
    resetPaneDropHover()
    hideDragHint()
    options.scheduleDragCleanup()
  }

  const handleMixtapeReorder = async (payload: {
    sourceItemIds: string[]
    targetIndex: number
  }) => {
    if (!options.isMixtapeListView.value) return
    const sourceItemIds = Array.isArray(payload?.sourceItemIds) ? payload.sourceItemIds : []
    if (!sourceItemIds.length) return
    const sourceSet = new Set(sourceItemIds)
    const current = [...options.originalSongInfoArr.value]
    if (!current.length) return
    const moving = current.filter((item) => sourceSet.has(item.mixtapeItemId || ''))
    if (!moving.length) return
    const remaining = current.filter((item) => !sourceSet.has(item.mixtapeItemId || ''))
    const targetIndex =
      typeof payload?.targetIndex === 'number' && Number.isFinite(payload.targetIndex)
        ? payload.targetIndex
        : current.length
    let insertIndex = remaining.length
    if (targetIndex <= 0) {
      insertIndex = 0
    } else if (targetIndex >= current.length) {
      insertIndex = remaining.length
    } else {
      const movingBefore = current
        .slice(0, Math.min(targetIndex, current.length))
        .filter((item) => sourceSet.has(item.mixtapeItemId || '')).length
      insertIndex = Math.max(0, Math.min(remaining.length, targetIndex - movingBefore))
    }
    const next = [...remaining.slice(0, insertIndex), ...moving, ...remaining.slice(insertIndex)]
    next.forEach((item, idx) => {
      item.mixOrder = idx + 1
    })
    options.originalSongInfoArr.value = markRaw(next)
    options.applyFiltersAndSorting()
    const orderedIds = next
      .map((item) => item.mixtapeItemId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (orderedIds.length > 0) {
      void window.electron.ipcRenderer.invoke('mixtape:reorder', {
        playlistId: options.songsAreaState.songListUUID,
        orderedIds
      })
    }
  }

  attachModifierKeyListeners()

  onUnmounted(() => {
    hideDragHint()
    if (clipboardHintTimer) {
      clearTimeout(clipboardHintTimer)
      clipboardHintTimer = null
    }
    if (modifierKeyCleanup) {
      modifierKeyCleanup()
      modifierKeyCleanup = null
    }
  })

  return {
    dragHintVisible,
    dragHintMode,
    dragHintTitle,
    dragHintDesc,
    paneDropHover,
    paneDropHoverMode,
    clipboardHintVisible,
    clipboardHintText,
    handleClipboardHint,
    handlePaneDragEnter,
    handlePaneDragOver,
    handlePaneDragLeave,
    handlePaneDrop,
    handleSongDragStart,
    handleSongDragEnd,
    handleMixtapeReorder
  }
}
