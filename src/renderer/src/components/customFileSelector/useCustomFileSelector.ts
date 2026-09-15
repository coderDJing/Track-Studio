import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  shallowRef,
  triggerRef,
  watch
} from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import utils from '@renderer/utils/utils'
import audioFileIcon from '@renderer/assets/audioFile.svg?asset'
import folderIcon from '@renderer/assets/folder.svg?asset'
import desktopIcon from '@renderer/assets/desktop.svg?asset'
import diskIcon from '@renderer/assets/disk.svg?asset'
import type {
  CustomFileSelectorEmits,
  CustomFileSelectorProps,
  FileSystemItem,
  SelectedItem,
  SelectionModifiers
} from './types'

type DriveInfo = {
  name: string
  path: string
  size?: number
}

type RawDirectoryItem = {
  name: string
  path: string
  isDirectory: boolean
}

type FileSizeResult = {
  path: string
  size: number | null
}

const PATH_STORAGE_KEY = 'fileSelector_lastPath'
const DIRECTORY_CLICK_DELAY = 200
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const scrollbarOptions = {
  scrollbars: {
    autoHide: 'leave' as const,
    autoHideDelay: 50,
    clickScroll: true
  } as const,
  overflow: {
    x: 'hidden',
    y: 'scroll'
  } as const
}

const getLastUsedPath = (): string => {
  try {
    return localStorage.getItem(PATH_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

const saveLastUsedPath = (path: string) => {
  try {
    localStorage.setItem(PATH_STORAGE_KEY, path)
  } catch {
    // 本地存储不可用时不影响文件选择器主流程。
  }
}

const getParentPath = (inputPath: string): string => {
  const normalized = inputPath.replace(/[\\/]+$/, '')
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) return ''

  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (separatorIndex < 0) return ''
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(normalized)) {
    return normalized.slice(0, 2)
  }
  return normalized.slice(0, separatorIndex)
}

const getPathName = (path: string): string => {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

const findExistingPath = async (startPath: string): Promise<string> => {
  if (!startPath) return ''

  let currentPath = startPath
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const exists = await window.electron.ipcRenderer.invoke('check-path-exists', currentPath)
      if (exists) return currentPath
    } catch {
      // 继续尝试上级目录。
    }

    const parentPath = getParentPath(currentPath)
    if (!parentPath || parentPath === currentPath) break
    currentPath = parentPath
  }

  return ''
}

const sortDirectoryItems = (items: FileSystemItem[]) =>
  items.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
    return nameCollator.compare(left.name, right.name)
  })

export function useCustomFileSelector(
  props: CustomFileSelectorProps,
  emit: CustomFileSelectorEmits
) {
  const runtime = useRuntimeStore()
  const uuid = uuidV4()
  const currentPath = ref('')
  const fileTree = shallowRef<FileSystemItem[]>([])
  const selectedItems = shallowRef<SelectedItem[]>([])
  const selectedPathSet = new Set<string>()
  const selectionRevision = ref(0)
  const selectedFilesCount = ref(0)
  const selectedFoldersCount = ref(0)
  const searchQuery = ref('')
  const isLoading = ref(false)
  const selectionModifiers = ref<SelectionModifiers>({ shift: false, ctrlOrMeta: false })
  const lastActiveIndex = ref<number | null>(null)
  const anchorIndex = ref<number | null>(null)
  const modalRef = ref<HTMLDivElement | null>(null)
  const fileSizeByPath = reactive(new Map<string, number | null>())
  const pendingFileSizePaths = new Set<string>()

  let directoryLoadRequestId = 0
  let fileSizeRequestGeneration = 0
  let directorySelectionTimer: ReturnType<typeof setTimeout> | null = null
  let pendingDirectorySelection: {
    item: FileSystemItem
    index: number
    modifiers: SelectionModifiers
  } | null = null
  let scrollToIndexHandler: ((index: number) => void) | null = null

  const visible = computed({
    get: () => props.visible,
    set: (value) => emit('update:visible', value)
  })

  const filteredTree = computed(() => {
    const query = searchQuery.value.trim().toLocaleLowerCase()
    if (!query) return fileTree.value
    return fileTree.value.filter((item) => item.name.toLocaleLowerCase().includes(query))
  })

  const filteredIndexByPath = computed(() => {
    const indexByPath = new Map<string, number>()
    filteredTree.value.forEach((item, index) => indexByPath.set(item.path, index))
    return indexByPath
  })

  const selectedCount = computed(() => selectedItems.value.length)

  const getFlatItems = () => filteredTree.value
  const findItemIndex = (target: Pick<FileSystemItem, 'path'>) =>
    filteredIndexByPath.value.get(target.path) ?? -1

  const setScrollToIndexHandler = (handler: ((index: number) => void) | null) => {
    scrollToIndexHandler = handler
  }

  const adjustScrollToItem = (index: number) => {
    if (index >= 0) scrollToIndexHandler?.(index)
  }

  const setActiveIndexAndFocus = (index: number) => {
    if (index < 0) return
    lastActiveIndex.value = index
    anchorIndex.value = index
    nextTick(() => adjustScrollToItem(index))
  }

  const updateSelectionModifiers = (event: KeyboardEvent | MouseEvent) => {
    selectionModifiers.value = {
      shift: !!event.shiftKey,
      ctrlOrMeta: !!(event.ctrlKey || event.metaKey)
    }
  }

  const clearSelectionModifiers = () => {
    selectionModifiers.value = { shift: false, ctrlOrMeta: false }
  }

  const getItemSize = (item: FileSystemItem | SelectedItem): number | null | undefined => {
    if (typeof item.size === 'number' || item.size === null) return item.size
    return fileSizeByPath.get(item.path)
  }

  const createSelectedItem = (item: FileSystemItem): SelectedItem => ({
    name: item.name,
    path: item.path,
    type: item.type,
    size: getItemSize(item)
  })

  const addSelection = (item: FileSystemItem) => {
    if (selectedPathSet.has(item.path)) return

    selectedPathSet.add(item.path)
    selectedItems.value.push(createSelectedItem(item))
    triggerRef(selectedItems)
    selectionRevision.value++
    if (item.type === 'file') {
      selectedFilesCount.value++
    } else {
      selectedFoldersCount.value++
    }
  }

  const removeSelectionInternal = (path: string) => {
    if (!selectedPathSet.delete(path)) return
    selectionRevision.value++

    const existingIndex = selectedItems.value.findIndex((selected) => selected.path === path)
    if (existingIndex === -1) return
    const [removedItem] = selectedItems.value.splice(existingIndex, 1)
    triggerRef(selectedItems)
    if (removedItem?.type === 'file') {
      selectedFilesCount.value = Math.max(0, selectedFilesCount.value - 1)
    } else if (removedItem) {
      selectedFoldersCount.value = Math.max(0, selectedFoldersCount.value - 1)
    }
  }

  const clearSelectionInternal = () => {
    selectedPathSet.clear()
    selectionRevision.value++
    selectedItems.value = []
    selectedFilesCount.value = 0
    selectedFoldersCount.value = 0
  }

  const replaceSelection = (items: readonly FileSystemItem[]) => {
    const nextItems: SelectedItem[] = []
    let fileCount = 0
    let folderCount = 0

    selectedPathSet.clear()
    for (const item of items) {
      if (selectedPathSet.has(item.path)) continue
      selectedPathSet.add(item.path)
      nextItems.push(createSelectedItem(item))
      if (item.type === 'file') fileCount++
      else folderCount++
    }

    selectedItems.value = nextItems
    selectedFilesCount.value = fileCount
    selectedFoldersCount.value = folderCount
    selectionRevision.value++
  }

  const clearSelection = () => {
    clearSelectionInternal()
    lastActiveIndex.value = null
    anchorIndex.value = null
  }

  const removeSelectionByPath = (path: string) => {
    removeSelectionInternal(path)
    if (selectedItems.value.length === 0) {
      lastActiveIndex.value = null
      anchorIndex.value = null
    }
  }

  const isItemSelected = (item: Pick<FileSystemItem, 'path'>) => {
    void selectionRevision.value
    return selectedPathSet.has(item.path)
  }

  const clearPendingDirectorySelection = () => {
    if (directorySelectionTimer) {
      clearTimeout(directorySelectionTimer)
      directorySelectionTimer = null
    }
    pendingDirectorySelection = null
  }

  const toggleItemSelection = (
    item: FileSystemItem,
    modifiers: SelectionModifiers = selectionModifiers.value,
    knownIndex?: number
  ) => {
    const items = getFlatItems()
    const currentIndex = knownIndex ?? findItemIndex(item)
    if (currentIndex < 0) return

    if (!props.allowMixedSelection && !isItemSelected(item) && selectedItems.value.length > 0) {
      const firstType = selectedItems.value[0]?.type
      if (firstType && firstType !== item.type) return
    }

    if (modifiers.shift && anchorIndex.value !== null) {
      const start = Math.min(anchorIndex.value, currentIndex)
      const end = Math.max(anchorIndex.value, currentIndex)
      let rangeItems = items.slice(start, end + 1)
      if (!props.allowMixedSelection && rangeItems.length > 0) {
        const rangeType = rangeItems[0]?.type
        rangeItems = rangeItems.filter((rangeItem) => rangeItem.type === rangeType)
      }
      replaceSelection(rangeItems)
      setActiveIndexAndFocus(currentIndex)
      return
    }

    if (props.multiSelect || modifiers.ctrlOrMeta) {
      if (isItemSelected(item)) removeSelectionInternal(item.path)
      else addSelection(item)
      setActiveIndexAndFocus(currentIndex)
      return
    }

    replaceSelection([item])
    setActiveIndexAndFocus(currentIndex)
  }

  const handleItemClick = (item: FileSystemItem, index: number, event?: MouseEvent) => {
    if (event) updateSelectionModifiers(event)
    else clearSelectionModifiers()
    if (event && event.button !== 0) return
    modalRef.value?.focus({ preventScroll: true })

    const modifiers = selectionModifiers.value
    if (item.type === 'directory') {
      clearPendingDirectorySelection()
      pendingDirectorySelection = { item, index, modifiers }
      directorySelectionTimer = setTimeout(() => {
        if (pendingDirectorySelection?.item === item) {
          toggleItemSelection(item, modifiers, index)
        }
        clearPendingDirectorySelection()
      }, DIRECTORY_CLICK_DELAY)
      return
    }

    toggleItemSelection(item, modifiers, index)
  }

  const loadDirectory = async (dirPath: string) => {
    const requestId = ++directoryLoadRequestId
    isLoading.value = true
    try {
      const items = await window.electron.ipcRenderer.invoke('read-directory', dirPath)
      if (requestId !== directoryLoadRequestId) return

      const treeItems: FileSystemItem[] = (items as RawDirectoryItem[]).map((item) => ({
        name: item.name,
        path: item.path,
        type: item.isDirectory ? 'directory' : 'file',
        size: item.isDirectory ? null : undefined,
        isSpecial: false
      }))

      fileTree.value = sortDirectoryItems(treeItems)
      lastActiveIndex.value = null
      anchorIndex.value = null
    } catch (error) {
      if (requestId === directoryLoadRequestId) {
        console.error('加载目录失败:', error)
      }
    } finally {
      if (requestId === directoryLoadRequestId) isLoading.value = false
    }
  }

  const navigateTo = async (item: FileSystemItem) => {
    if (item.type !== 'directory') return
    currentPath.value = item.path
    saveLastUsedPath(item.path)
    await loadDirectory(item.path)
  }

  const handleItemDoubleClick = async (item: FileSystemItem, event?: MouseEvent) => {
    if (event) updateSelectionModifiers(event)
    if (item.type !== 'directory') return
    clearPendingDirectorySelection()
    await navigateTo(item)
  }

  const getDesktopPath = (userHome: string): string => {
    if (runtime.setting.platform === 'win32') return `${userHome}\\Desktop`
    return `${userHome}/Desktop`
  }

  const loadDrives = async () => {
    const requestId = ++directoryLoadRequestId
    isLoading.value = true
    try {
      const drives = (await window.electron.ipcRenderer.invoke('get-drives')) as DriveInfo[]
      const userHome = await window.electron.ipcRenderer.invoke('get-user-home')
      if (requestId !== directoryLoadRequestId) return

      const desktopItem: FileSystemItem = {
        name: t('fileSelector.desktop'),
        path: getDesktopPath(String(userHome || '')),
        type: 'directory',
        size: null,
        isSpecial: true
      }
      const driveItems: FileSystemItem[] = drives.map((drive) => ({
        name: drive.name,
        path: drive.path,
        type: 'directory',
        size: drive.size ?? null,
        isSpecial: false
      }))

      fileTree.value = [desktopItem, ...driveItems]
      currentPath.value = ''
      lastActiveIndex.value = null
      anchorIndex.value = null
    } catch (error) {
      if (requestId === directoryLoadRequestId) {
        console.error('加载驱动器列表失败:', error)
      }
    } finally {
      if (requestId === directoryLoadRequestId) isLoading.value = false
    }
  }

  const markInitialSelections = () => {
    const currentItemByPath = new Map(fileTree.value.map((item) => [item.path, item]))
    const initialItems = props.initialSelectedPaths.map(
      (path): FileSystemItem =>
        currentItemByPath.get(path) ?? {
          name: getPathName(path),
          path,
          type: 'file',
          size: fileSizeByPath.get(path)
        }
    )
    replaceSelection(initialItems)
  }

  const initialize = async () => {
    const requestId = ++directoryLoadRequestId
    fileSizeRequestGeneration++
    isLoading.value = true
    fileSizeByPath.clear()
    pendingFileSizePaths.clear()
    const lastPath = getLastUsedPath()
    if (lastPath) {
      const existingPath = await findExistingPath(lastPath)
      if (requestId !== directoryLoadRequestId || !props.visible) return
      if (existingPath) {
        currentPath.value = existingPath
        await loadDirectory(existingPath)
        return
      }
    }
    if (requestId !== directoryLoadRequestId || !props.visible) return
    await loadDrives()
  }

  const navigateUp = async () => {
    clearPendingDirectorySelection()
    const parentPath = getParentPath(currentPath.value)
    if (!currentPath.value || !parentPath) {
      await loadDrives()
      return
    }

    currentPath.value = parentPath
    saveLastUsedPath(parentPath)
    await loadDirectory(parentPath)
  }

  const requestFileSizes = async (items: readonly FileSystemItem[]) => {
    const filePaths = items
      .filter(
        (item) =>
          item.type === 'file' &&
          item.size === undefined &&
          !fileSizeByPath.has(item.path) &&
          !pendingFileSizePaths.has(item.path)
      )
      .map((item) => item.path)

    if (filePaths.length === 0) return
    const requestGeneration = fileSizeRequestGeneration
    filePaths.forEach((path) => pendingFileSizePaths.add(path))

    try {
      const results = (await window.electron.ipcRenderer.invoke(
        'get-file-sizes',
        filePaths
      )) as FileSizeResult[]
      if (requestGeneration !== fileSizeRequestGeneration) return
      for (const result of results) {
        fileSizeByPath.set(result.path, result.size)
      }
    } catch (error) {
      console.error('读取文件大小失败:', error)
    } finally {
      if (requestGeneration === fileSizeRequestGeneration) {
        filePaths.forEach((path) => pendingFileSizePaths.delete(path))
      }
    }
  }

  const formatFileSize = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB']
    let size = Math.max(0, bytes)
    let unitIndex = 0
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex++
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`
  }

  const isDrive = (item: FileSystemItem) => item.name.includes(':') || item.isSpecial === true

  const getItemIcon = (item: FileSystemItem | SelectedItem) => {
    if ('isSpecial' in item && item.isSpecial) return desktopIcon
    if (item.type === 'directory') return isDrive(item as FileSystemItem) ? diskIcon : folderIcon
    return audioFileIcon
  }

  const confirm = () => {
    const selectedPaths = selectedItems.value.map((item) => item.path)
    emit(
      'confirm',
      selectedPaths.length > 0 || !currentPath.value ? selectedPaths : [currentPath.value]
    )
    close()
  }

  const cancel = () => {
    emit('cancel')
    close()
  }

  const close = () => {
    visible.value = false
    searchQuery.value = ''
    clearSelection()
    clearPendingDirectorySelection()
    directoryLoadRequestId++
    fileSizeRequestGeneration++
    isLoading.value = false
    if (currentPath.value) saveLastUsedPath(currentPath.value)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const eventTarget = event.target
    if (
      eventTarget instanceof HTMLInputElement ||
      eventTarget instanceof HTMLTextAreaElement ||
      eventTarget instanceof HTMLButtonElement ||
      (eventTarget instanceof HTMLElement && eventTarget.isContentEditable)
    ) {
      return
    }

    updateSelectionModifiers(event)
    const items = getFlatItems()
    if (items.length === 0) return

    const selectedFallbackIndex = selectedItems.value.length
      ? findItemIndex(selectedItems.value[selectedItems.value.length - 1] as SelectedItem)
      : -1
    const currentIndex = lastActiveIndex.value ?? Math.max(0, selectedFallbackIndex)
    let newIndex = currentIndex

    switch (event.key) {
      case 'ArrowUp':
        newIndex = Math.max(0, currentIndex - 1)
        event.preventDefault()
        break
      case 'ArrowDown':
        newIndex = Math.min(items.length - 1, currentIndex + 1)
        event.preventDefault()
        break
      case 'PageUp':
        newIndex = Math.max(0, currentIndex - 10)
        event.preventDefault()
        break
      case 'PageDown':
        newIndex = Math.min(items.length - 1, currentIndex + 10)
        event.preventDefault()
        break
      case 'Home':
        newIndex = 0
        event.preventDefault()
        break
      case 'End':
        newIndex = items.length - 1
        event.preventDefault()
        break
      case 'a':
      case 'A':
        if (event.ctrlKey || event.metaKey) {
          replaceSelection(items)
          lastActiveIndex.value = items.length - 1
          anchorIndex.value = items.length - 1
          adjustScrollToItem(items.length - 1)
          event.preventDefault()
        }
        return
      case 'Escape':
        clearSelection()
        return
      case ' ':
        if (items[currentIndex]) {
          toggleItemSelection(
            items[currentIndex],
            !event.shiftKey
              ? selectionModifiers.value
              : {
                  shift: true,
                  ctrlOrMeta: event.ctrlKey || event.metaKey
                },
            currentIndex
          )
          event.preventDefault()
        }
        return
      default:
        return
    }

    const targetItem = items[newIndex]
    if (!targetItem) return
    toggleItemSelection(
      targetItem,
      {
        shift: event.shiftKey,
        ctrlOrMeta: event.ctrlKey || event.metaKey
      },
      newIndex
    )
  }

  watch(
    () => props.visible,
    async (newVisible) => {
      if (!newVisible) return
      await initialize()
      if (!props.visible) return
      if (props.initialSelectedPaths.length > 0) markInitialSelections()
      await nextTick()
      modalRef.value?.focus()
    }
  )

  watch(searchQuery, () => {
    lastActiveIndex.value = null
    anchorIndex.value = null
  })

  onMounted(() => {
    hotkeys('Esc', uuid, cancel)
    hotkeys('E,Enter', uuid, confirm)
    utils.setHotkeysScpoe(uuid)
  })

  onUnmounted(() => {
    directoryLoadRequestId++
    clearPendingDirectorySelection()
    utils.delHotkeysScope(uuid)
  })

  return {
    visible,
    currentPath,
    fileTree,
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
  }
}
