<script setup lang="ts">
import listIconAsset from '@renderer/assets/list.svg?asset'
import likeIconAsset from '@renderer/assets/like.svg?asset'
import trashIconAsset from '@renderer/assets/trash.svg?asset'
import neteaseIconAsset from '@renderer/assets/netease.svg?asset'
import mixtapeIconAsset from '@renderer/assets/mixtape.svg?asset'
import setListIconAsset from '@renderer/assets/setList.svg?asset'
import recordIconAsset from '@renderer/assets/record.svg?asset'
import rekordboxIconAsset from '@renderer/assets/rekordbox.svg?asset'
import rekordboxUsbIconAsset from '@renderer/assets/rekordboxUsb.svg?asset'
import seratoIconAsset from '@renderer/assets/serato.svg?asset'
import traktorIconAsset from '@renderer/assets/traktor.svg?asset'
import {
  computed,
  ref,
  reactive,
  watch,
  nextTick,
  onMounted,
  onUnmounted,
  useTemplateRef
} from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { t } from '@renderer/utils/translate'
import type { Icon, IDir } from '../../../../types/globals'
import tempListIconAsset from '@renderer/assets/tempList.svg?asset'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'
import {
  ensureNeteaseLoggedIn,
  getNeteaseStatus,
  neteaseCatalogSyncing,
  neteaseLoggedIn,
  syncNeteaseLibrary
} from '@renderer/utils/neteaseActions'
import { findNeteaseLibraryNode, isNeteasePlaylistUuid } from '@renderer/utils/neteaseSongs'
import { isNeteaseLibraryIconVisible } from '@shared/netease'
import { requestUserGuideStep } from '@renderer/composables/userGuideBridge'
import {
  requestLibraryUserGuide,
  resolveLibraryUserGuideTarget
} from './librarySelectArea/libraryUserGuide'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_CHANGED_EVENT, RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { useRekordboxSourceIcons } from './librarySelectArea/useRekordboxSourceIcons'
import RekordboxRuntimeMissingEntry from './librarySelectArea/RekordboxRuntimeMissingEntry.vue'
import { useExternalDjSourceIcons } from './librarySelectArea/useExternalDjSourceIcons'
import { useLibraryBatchActions } from './librarySelectArea/useLibraryBatchActions'
import IcloudLibraryEntry from './IcloudLibraryEntry.vue'
import {
  useIcloudLibraryRail,
  leaveIcloudLibrary,
  selectIcloudSiblingLibrary
} from './librarySelectArea/useIcloudLibraryRail'
import { resolveActivePlaybackSongListUUIDs } from '@renderer/utils/playbackSongListSources'
import { scrollIntoContainerView } from '@renderer/utils/scrollIntoContainerView'
import { icloudOpen } from '@renderer/utils/icloudLibrary'
const props = defineProps<{ containScroll?: boolean }>()
const emit = defineEmits(['librarySelectedChange'])

type HoverableIcon = {
  name: string
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}

type PlaylistContentChangedPayload = {
  uuids?: unknown
}

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
type ComponentWithElement = ComponentPublicInstance & { $el?: unknown }

const externalIcon: Icon = {
  name: 'ExternalPlaylist',
  grey: tempListIconAsset,
  white: tempListIconAsset,
  src: tempListIconAsset,
  showAlt: false,
  i18nKey: 'library.externalPlaylist'
}

const recordingIcon: Icon = {
  name: 'RecordingLibrary',
  grey: recordIconAsset,
  white: recordIconAsset,
  src: recordIconAsset,
  showAlt: false,
  i18nKey: 'library.recordingLibrary'
}

const baseIcons: Icon[] = [
  {
    name: 'FilterLibrary',
    grey: listIconAsset,
    white: listIconAsset,
    src: listIconAsset,
    showAlt: false,
    // i18n key for tooltip
    i18nKey: 'library.filter'
  },
  {
    name: 'CuratedLibrary',
    grey: likeIconAsset,
    white: likeIconAsset,
    src: likeIconAsset,
    showAlt: false,
    i18nKey: 'library.curated'
  },
  {
    name: 'SetLibrary',
    grey: setListIconAsset,
    white: setListIconAsset,
    src: setListIconAsset,
    showAlt: false,
    i18nKey: 'library.setLibrary'
  },
  {
    name: 'MixtapeLibrary',
    grey: mixtapeIconAsset,
    white: mixtapeIconAsset,
    src: mixtapeIconAsset,
    showAlt: false,
    i18nKey: 'library.mixtapeLibrary'
  },
  {
    name: 'RecycleBin',
    grey: trashIconAsset,
    white: trashIconAsset,
    src: trashIconAsset,
    showAlt: false,
    i18nKey: 'recycleBin.recycleBin'
  },
  {
    name: 'NeteaseLibrary',
    grey: neteaseIconAsset,
    white: neteaseIconAsset,
    src: neteaseIconAsset,
    showAlt: false,
    i18nKey: 'library.neteaseLibrary'
  }
]

const iconArr = ref<Icon[]>([...baseIcons])
const coreIconNameSet = new Set([
  'FilterLibrary',
  'CuratedLibrary',
  'SetLibrary',
  'MixtapeLibrary',
  'RecycleBin',
  'NeteaseLibrary'
])
const runtime = useRuntimeStore()
const coreIconArr = computed(() =>
  iconArr.value.filter((item) => {
    if (!coreIconNameSet.has(item.name)) return false
    if (item.name === 'NeteaseLibrary' && !isNeteaseLibraryIconVisible(runtime.setting)) {
      return false
    }
    return true
  })
)
const dynamicIconArr = computed(() =>
  iconArr.value.filter((item) => !coreIconNameSet.has(item.name))
)
const selectedIcon = ref<HoverableIcon>(iconArr.value[0])
selectedIcon.value.src = selectedIcon.value.white
const recycleBinTrackCount = ref<number | null>(null)
let recycleBinTrackCountRequestId = 0
let recycleBinTrackCountRefreshTimer: ReturnType<typeof setTimeout> | null = null

const refreshRecycleBinTrackCount = async (requestId: number) => {
  try {
    const count = await window.electron.ipcRenderer.invoke(
      'getSongListTrackCount',
      'library/RecycleBin'
    )
    if (requestId !== recycleBinTrackCountRequestId) return
    recycleBinTrackCount.value =
      typeof count === 'number' && Number.isFinite(count) ? Math.max(0, count) : 0
  } catch {
    if (requestId === recycleBinTrackCountRequestId) {
      recycleBinTrackCount.value = 0
    }
  }
}

const scheduleRecycleBinTrackCountRefresh = (delay = 0) => {
  const requestId = ++recycleBinTrackCountRequestId
  if (recycleBinTrackCountRefreshTimer) {
    clearTimeout(recycleBinTrackCountRefreshTimer)
  }
  recycleBinTrackCountRefreshTimer = setTimeout(() => {
    recycleBinTrackCountRefreshTimer = null
    void refreshRecycleBinTrackCount(requestId)
  }, delay)
}

const getIconTooltipTitle = (item: Icon) => {
  if (item.name === 'RecycleBin' && recycleBinTrackCount.value !== null) {
    return t('recycleBin.tooltipWithTrackCount', { count: recycleBinTrackCount.value })
  }
  return t(item.i18nKey || item.name)
}

const hasRecycleBinContentChange = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return false
  const { uuids } = payload as PlaylistContentChangedPayload
  return Array.isArray(uuids) && uuids.some((uuid: unknown) => uuid === RECYCLE_BIN_UUID)
}

const handlePlaylistContentChanged = (payload: unknown) => {
  if (hasRecycleBinContentChange(payload)) {
    scheduleRecycleBinTrackCountRefresh()
  }
}

const handleLibraryTreeUpdated = () => {
  scheduleRecycleBinTrackCountRefresh(100)
}

const handleIconTooltipMouseEnter = (item: Icon) => {
  if (item.name === 'RecycleBin') {
    scheduleRecycleBinTrackCountRefresh()
  }
}

onMounted(() => {
  emitter.on('playlistContentChanged', handlePlaylistContentChanged)
  window.electron.ipcRenderer.on('library-tree-updated', handleLibraryTreeUpdated)
  scheduleRecycleBinTrackCountRefresh()
})

onUnmounted(() => {
  emitter.off('playlistContentChanged', handlePlaylistContentChanged)
  window.electron.ipcRenderer.removeListener('library-tree-updated', handleLibraryTreeUpdated)
  recycleBinTrackCountRequestId += 1
  if (recycleBinTrackCountRefreshTimer) {
    clearTimeout(recycleBinTrackCountRefreshTimer)
    recycleBinTrackCountRefreshTimer = null
  }
})

const waitForUiIdle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const updateSelectedIcon = (item: HoverableIcon | undefined) => {
  if (!item) return
  if (selectedIcon.value && selectedIcon.value !== item) {
    selectedIcon.value.src = selectedIcon.value.grey
  }
  selectedIcon.value = item
  selectedIcon.value.src = selectedIcon.value.white
}

const selectLibraryIcon = (item: Icon) => {
  selectIcloudSiblingLibrary(runtime, item.name)
}

/**
 * 未登录时先扫码，成功后再切库。关掉登录窗必须停在原来的库，不能先把蓝条切过去。
 * 拖拽经过图标时不要走这条（会弹窗），见 iconDragEnter。
 */
let activatingNetease = false
const hasNeteasePlaylistInTree = (): boolean =>
  Boolean(findFirstNeteasePlaylist(runtime.libraryTree))

/** 已经确认登录，或树上已经有歌单：点击时可以立刻切库，不必再等 IPC。 */
const canEnterNeteaseImmediately = (): boolean =>
  neteaseLoggedIn.value === true || hasNeteasePlaylistInTree()

const enterNeteaseLibrary = () => {
  selectIcloudSiblingLibrary(runtime, 'NeteaseLibrary')
  // 只有树上还是空的才亮 loading；歌单已经出来后不要再插一条「正在同步」。
  if (!hasNeteasePlaylistInTree()) neteaseCatalogSyncing.value = true
  // 先让这一帧把蓝条和 loading 画出来，再发同步，避免第一次点击像卡住。
  window.setTimeout(() => {
    void syncNeteaseLibrary({ silent: true, background: true })
  }, 0)
}

const activateNeteaseLibrary = async () => {
  if (activatingNetease) return
  activatingNetease = true
  try {
    if (canEnterNeteaseImmediately()) {
      enterNeteaseLibrary()
      return
    }
    // 启动预取可能还在路上：跟那一次共用，不要再另起一次才切库。
    if (neteaseLoggedIn.value !== false) {
      const status = await getNeteaseStatus()
      if (status.loggedIn) {
        enterNeteaseLibrary()
        return
      }
    }
    if (!(await ensureNeteaseLoggedIn())) return
    enterNeteaseLibrary()
  } finally {
    activatingNetease = false
  }
}

const clickIcon = (item: Icon) => {
  if (item.name === 'RecycleBin') {
    scheduleRecycleBinTrackCountRefresh()
  }
  if (item.name === 'NeteaseLibrary') {
    void activateNeteaseLibrary()
    return
  }
  selectLibraryIcon(item)
}

/** 树里第一张网易云歌单（深度优先，与树上的显示顺序一致） */
const findFirstNeteasePlaylist = (root: IDir | null | undefined): string => {
  const libraryNode = findNeteaseLibraryNode(root)
  if (!libraryNode) return ''
  const queue: IDir[] = [...(libraryNode.children || [])]
  while (queue.length) {
    const node = queue.shift() as IDir
    if (isNeteasePlaylistUuid(node.uuid)) return node.uuid
    for (const child of node.children || []) queue.push(child)
  }
  return ''
}

const iconRefMap = reactive<Record<string, HTMLElement | null>>({})
const scrollItemRefMap = reactive<Record<string, HTMLElement | null>>({})
const resolveRefDom = (el: Element | ComponentPublicInstance | null) => {
  let dom: HTMLElement | null = null
  if (el) {
    if (el instanceof HTMLElement) {
      dom = el
    } else if ((el as ComponentWithElement).$el instanceof HTMLElement) {
      dom = (el as ComponentWithElement).$el
    }
  }
  return dom
}
const setIconRef = (name: string, el: Element | ComponentPublicInstance | null) => {
  const dom = resolveRefDom(el)
  iconRefMap[name] = dom
}
const setScrollItemRef = (name: string, el: Element | ComponentPublicInstance | null) => {
  const dom = resolveRefDom(el)
  scrollItemRefMap[name] = dom
}
const iconMouseover = (item: HoverableIcon) => {
  if (selectedIcon.value != item) {
    item.src = item.white
  }
}
const iconMouseout = (item: HoverableIcon) => {
  if (selectedIcon.value != item) {
    item.src = item.grey
  }
}

const getIconMaskStyle = (item: HoverableIcon) => ({
  '--icon-mask': `url("${item.src}")`
})

const activePlaybackSongListUUIDs = computed(() => resolveActivePlaybackSongListUUIDs(runtime))

const isPlayingLibraryIcon = (item: Icon) => {
  const playingUuids = activePlaybackSongListUUIDs.value
  if (playingUuids.length === 0) return false
  if (item.name === 'ExternalPlaylist') return playingUuids.includes(EXTERNAL_PLAYLIST_UUID)
  if (item.name === 'RecycleBin') return playingUuids.includes(RECYCLE_BIN_UUID)
  if (item.name === 'RecordingLibrary') return playingUuids.includes(RECORDING_LIBRARY_UUID)
  const libraryNode = findLibraryNode(item.name)
  if (!libraryNode) return false
  const uuids = libraryUtils.getAllUuids(libraryNode)
  return playingUuids.some((playingUuid) => uuids.includes(playingUuid))
}

const findLibraryNode = (libraryName: string): IDir | undefined => {
  return runtime.libraryTree.children?.find((item: IDir) => item.dirName === libraryName)
}

const { handleIconContextmenu } = useLibraryBatchActions({ runtime, findLibraryNode })

const {
  pioneerDriveGroups,
  desktopLibraryIcon,
  desktopRuntimeMissing,
  desktopRuntimeDownloading,
  downloadDesktopRuntime,
  clickPioneerDriveIcon,
  clickDesktopLibraryIcon,
  handlePioneerDriveContextmenu,
  handleDesktopLibraryContextmenu,
  isEjectingPioneerDriveIcon,
  isImportingPioneerDriveIcon,
  isImportingDesktopLibraryIcon,
  isSelectedPioneerDriveIcon,
  isSelectedDesktopLibraryIcon
} = useRekordboxSourceIcons({
  runtime,
  usbDriveIconAsset: rekordboxUsbIconAsset,
  rekordboxDesktopIconAsset: rekordboxIconAsset,
  updateSelectedIcon,
  waitForUiIdle,
  emitLibrarySelectedChange: (payload) => emit('librarySelectedChange', payload),
  onLibraryActivated: leaveIcloudLibrary
})
const {
  sourceIcons: externalDjSourceIcons,
  clickSourceIcon: clickExternalDjSourceIcon,
  isSelectedSourceIcon: isSelectedExternalDjSourceIcon
} = useExternalDjSourceIcons({
  runtime,
  seratoIconAsset,
  traktorIconAsset,
  updateSelectedIcon,
  emitLibrarySelectedChange: (payload) => emit('librarySelectedChange', payload),
  onLibraryActivated: leaveIcloudLibrary
})
const icloudEntryVisible = useIcloudLibraryRail(runtime)
const hasDynamicEntries = computed(
  () =>
    icloudEntryVisible.value ||
    dynamicIconArr.value.length > 0 ||
    Boolean(desktopLibraryIcon.value) ||
    desktopRuntimeMissing.value ||
    externalDjSourceIcons.value.length > 0 ||
    pioneerDriveGroups.value.length > 0
)
const railIconsScrollRef = useTemplateRef<OverlayScrollbarsComponentRef>('railIconsScrollRef')
const railScrollState = reactive({
  canScroll: false,
  atTop: true,
  atBottom: true
})
let railScrollViewportEl: HTMLElement | null = null
let railScrollResizeObserver: ResizeObserver | null = null
const updateRailScrollState = () => {
  const viewport = railIconsScrollRef.value?.osInstance()?.elements().viewport as
    HTMLElement | undefined
  if (!viewport) {
    railScrollState.canScroll = false
    railScrollState.atTop = true
    railScrollState.atBottom = true
    return
  }
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  railScrollState.canScroll = maxScrollTop > 1
  railScrollState.atTop = viewport.scrollTop <= 1
  railScrollState.atBottom = viewport.scrollTop >= maxScrollTop - 1
}
const handleRailScroll = () => {
  updateRailScrollState()
}
// 核心库和设备图标在同一列里滚。选中项要跟着进可视范围，双轨把栏压矮时也一样。
const selectedRailScrollKey = computed(() => {
  if (icloudOpen.value) return 'icloud'
  if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
    return (
      runtime.externalDjLibrary.selectedSourceKey ||
      runtime.pioneerDeviceLibrary.selectedSourceKey ||
      ''
    )
  }
  return runtime.libraryAreaSelected || ''
})
const scrollSelectedRailIconIntoView = async () => {
  const key = selectedRailScrollKey.value
  if (!key) return
  await nextTick()
  const viewport = railIconsScrollRef.value?.osInstance()?.elements().viewport as
    HTMLElement | undefined
  const target = scrollItemRefMap[key]
  if (!viewport || !target) return
  if (props.containScroll) scrollIntoContainerView(target, viewport)
  else target.scrollIntoView({ block: 'nearest' })
  updateRailScrollState()
}
const syncRailScrollViewport = async () => {
  await nextTick()
  const viewport = railIconsScrollRef.value?.osInstance()?.elements().viewport as
    HTMLElement | undefined
  if (railScrollViewportEl !== viewport) {
    railScrollViewportEl?.removeEventListener('scroll', handleRailScroll)
    railScrollResizeObserver?.disconnect()
    railScrollResizeObserver = null
    railScrollViewportEl = viewport || null
    railScrollViewportEl?.addEventListener('scroll', handleRailScroll, { passive: true })
    if (railScrollViewportEl) {
      railScrollResizeObserver = new ResizeObserver(() => {
        updateRailScrollState()
        void scrollSelectedRailIconIntoView()
      })
      railScrollResizeObserver.observe(railScrollViewportEl)
    }
  }
  updateRailScrollState()
}
onMounted(() => {
  void syncRailScrollViewport()
})

onUnmounted(() => {
  railScrollViewportEl?.removeEventListener('scroll', handleRailScroll)
  railScrollResizeObserver?.disconnect()
  railScrollResizeObserver = null
  railScrollViewportEl = null
})

const libraryHandleClick = (item: Icon) => {
  // 网易云未登录时不能先切面板；选中由 activateNeteaseLibrary 在登录成功后写入。
  if (item.name === 'NeteaseLibrary') return
  emit('librarySelectedChange', item)
}

const isMixtapeSourceSongDrag = () => {
  if (
    Array.isArray(runtime.dragSourceMixtapeItemIds) &&
    runtime.dragSourceMixtapeItemIds.length > 0
  ) {
    return true
  }
  const sourceSongListUUID = runtime.dragSourceSongListUUID
  if (!sourceSongListUUID) return false
  return libraryUtils.getLibraryTreeByUUID(sourceSongListUUID)?.type === 'mixtapeList'
}

// 拖拽时的库切换逻辑
const iconDragEnter = (event: DragEvent, item: Icon) => {
  // 检查是否是歌曲拖拽
  const isSongDrag = event.dataTransfer?.types?.includes('application/x-song-drag')
  if (!isSongDrag || item.name === selectedIcon.value.name) return
  // Mixtape 自动录制歌单来源仅允许在 Mixtape 自动录制库内投放，不应悬浮切换到其他库
  if (isMixtapeSourceSongDrag() && item.name !== 'MixtapeLibrary') return
  // 当拖拽歌曲时，自动切换到对应的库。
  // 网易云未登录不要弹扫码窗，也先不切过去。
  if (item.name === 'NeteaseLibrary') {
    void getNeteaseStatus().then((status) => {
      if (!status.loggedIn) return
      selectLibraryIcon(item)
    })
    return
  }
  clickIcon(item)
  // 同时触发库切换事件，通知父组件更新
  libraryHandleClick(item)
}

const syncRecordingLibraryIcon = async (
  explicitHasRecordings?: boolean,
  options?: { announce?: boolean }
) => {
  const nextHasRecordings =
    typeof explicitHasRecordings === 'boolean'
      ? explicitHasRecordings
      : Boolean(await window.electron.ipcRenderer.invoke('recordingLibrary:has-recordings'))
  const exists = iconArr.value.find((icon) => icon.name === 'RecordingLibrary')
  if (nextHasRecordings && !exists) {
    recordingIcon.src = recordingIcon.grey
    const mixtapeIndex = iconArr.value.findIndex((icon) => icon.name === 'MixtapeLibrary')
    const recycleIndex = iconArr.value.findIndex((icon) => icon.name === 'RecycleBin')
    if (mixtapeIndex >= 0) {
      iconArr.value.splice(mixtapeIndex + 1, 0, recordingIcon)
    } else if (recycleIndex >= 0) {
      iconArr.value.splice(recycleIndex, 0, recordingIcon)
    } else {
      iconArr.value.push(recordingIcon)
    }
    if (runtime.libraryAreaSelected === 'RecordingLibrary') {
      updateSelectedIcon(recordingIcon)
    }
    if (options?.announce) {
      void requestUserGuideStep('recordingLibrary')
    }
    return
  }
  if (!nextHasRecordings && exists) {
    iconArr.value = iconArr.value.filter((icon) => icon.name !== 'RecordingLibrary')
    if (runtime.libraryAreaSelected === 'RecordingLibrary') {
      runtime.libraryAreaSelected = 'FilterLibrary'
    }
  }
}

const handleRecordingLibraryChanged = (
  eventOrPayload?: unknown,
  maybePayload?: { hasRecordings?: boolean }
) => {
  const payload =
    maybePayload ||
    (eventOrPayload && typeof eventOrPayload === 'object'
      ? (eventOrPayload as { hasRecordings?: boolean })
      : undefined)
  void syncRecordingLibraryIcon(payload?.hasRecordings, { announce: true })
}

watch(
  () => runtime.externalPlaylist.songs.length,
  (len) => {
    const exists = iconArr.value.find((icon) => icon.name === 'ExternalPlaylist')
    if (len > 0 && !exists) {
      externalIcon.src = externalIcon.grey
      const recycleIndex = iconArr.value.findIndex((icon) => icon.name === 'RecycleBin')
      if (recycleIndex === -1) {
        iconArr.value.push(externalIcon)
      } else {
        iconArr.value.splice(recycleIndex, 0, externalIcon)
      }
      if (runtime.libraryAreaSelected === 'ExternalPlaylist') {
        updateSelectedIcon(externalIcon)
      }
    } else if (len === 0 && exists) {
      iconArr.value = iconArr.value.filter((icon) => icon.name !== 'ExternalPlaylist')
    }
  },
  { immediate: true }
)

onMounted(() => {
  window.electron.ipcRenderer.on(RECORDING_LIBRARY_CHANGED_EVENT, handleRecordingLibraryChanged)
  emitter.on(RECORDING_LIBRARY_CHANGED_EVENT, handleRecordingLibraryChanged)
  void syncRecordingLibraryIcon()
})

onUnmounted(() => {
  window.electron.ipcRenderer.removeListener(
    RECORDING_LIBRARY_CHANGED_EVENT,
    handleRecordingLibraryChanged
  )
  emitter.off(RECORDING_LIBRARY_CHANGED_EVENT, handleRecordingLibraryChanged)
})

watch(
  () => runtime.setting.showNeteaseLibraryIcon,
  (visible) => {
    if (visible === false && runtime.libraryAreaSelected === 'NeteaseLibrary') {
      runtime.libraryAreaSelected = 'FilterLibrary'
    }
  },
  { immediate: true }
)

watch(
  () => runtime.libraryAreaSelected,
  (val) => {
    if (val === 'PioneerDeviceLibrary') {
      const target =
        externalDjSourceIcons.value.find(
          (icon) => icon.key === runtime.externalDjLibrary.selectedSourceKey
        ) ||
        (runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop'
          ? desktopLibraryIcon.value
          : null) ||
        pioneerDriveGroups.value
          .flatMap((group) => group.icons)
          .find((icon) => icon.key === runtime.pioneerDeviceLibrary.selectedSourceKey)
      if (target) {
        updateSelectedIcon(target)
      }
      return
    }
    const target = iconArr.value.find((icon) => icon.name === val)
    if (target) {
      updateSelectedIcon(target)
    }
  },
  { immediate: true }
)

watch(
  () => [
    hasDynamicEntries.value,
    icloudEntryVisible.value,
    dynamicIconArr.value.map((item) => item.name).join('|'),
    desktopLibraryIcon.value?.key || '',
    externalDjSourceIcons.value.map((item) => item.key).join('|'),
    pioneerDriveGroups.value.map((group) => group.icons.map((item) => item.key).join(',')).join('|')
  ],
  () => {
    void syncRailScrollViewport()
    void scrollSelectedRailIconIntoView()
  },
  { flush: 'post' }
)

watch(
  () => selectedRailScrollKey.value,
  () => {
    void scrollSelectedRailIconIntoView()
  },
  { flush: 'post' }
)

watch(
  () => ({
    mode: runtime.mainWindowBrowseMode,
    audience: runtime.setting.userGuideAudience,
    hasDesktop: Boolean(desktopLibraryIcon.value),
    usbCount: pioneerDriveGroups.value.length
  }),
  ({ mode, audience, hasDesktop, usbCount }) => {
    if (mode !== 'browser') return
    if (!audience || audience === 'veteran') return
    if (!hasDesktop && usbCount <= 0) return
    void requestUserGuideStep('rekordboxUsb')
  },
  { flush: 'post', immediate: true }
)

watch(
  () => runtime.libraryAreaSelected,
  (name) => {
    requestLibraryUserGuide(name)
  },
  { flush: 'post', immediate: true }
)
</script>
<template>
  <div class="librarySelectArea unselectable" data-user-guide-target="library-rail">
    <div class="librarySelectAreaScrollShell">
      <div
        v-show="railScrollState.canScroll && !railScrollState.atTop"
        class="librarySelectAreaScrollFade librarySelectAreaScrollFade--top"
      ></div>
      <OverlayScrollbarsComponent
        ref="railIconsScrollRef"
        class="librarySelectAreaScroller"
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
        defer
      >
        <div class="librarySelectAreaCore">
          <div
            v-for="item of coreIconArr"
            :key="item.name"
            :ref="(el) => setScrollItemRef(item.name, el)"
            class="iconBox"
            :data-user-guide-target="resolveLibraryUserGuideTarget(item.name)"
            @click="clickIcon(item)"
            @contextmenu.stop.prevent="handleIconContextmenu($event, item)"
            @mouseover="iconMouseover(item)"
            @mouseout="iconMouseout(item)"
            @dragenter="iconDragEnter($event, item)"
          >
            <div
              class="iconBoxAccent"
              :style="{ backgroundColor: item.name == selectedIcon.name ? 'var(--accent)' : '' }"
            ></div>
            <div class="iconBoxContent" @click="libraryHandleClick(item)">
              <span
                :ref="(el) => setIconRef(item.name, el)"
                :style="getIconMaskStyle(item)"
                :class="[
                  'sidebar-icon',
                  {
                    'is-active': item.name === selectedIcon.name,
                    'is-playing': isPlayingLibraryIcon(item)
                  }
                ]"
                @mouseenter="handleIconTooltipMouseEnter(item)"
              ></span>
              <bubbleBox
                :dom="iconRefMap[item.name] || undefined"
                :title="getIconTooltipTitle(item)"
              />
            </div>
          </div>
        </div>
        <div
          v-if="hasDynamicEntries"
          class="librarySelectAreaDynamic librarySelectAreaDynamic--with-divider"
        >
          <IcloudLibraryEntry
            v-if="icloudEntryVisible"
            :ref="(el) => setScrollItemRef('icloud', el)"
          />
          <div
            v-for="item of dynamicIconArr"
            :key="item.name"
            :ref="(el) => setScrollItemRef(item.name, el)"
            class="iconBox"
            :data-user-guide-target="resolveLibraryUserGuideTarget(item.name)"
            @click="clickIcon(item)"
            @contextmenu.stop.prevent="handleIconContextmenu($event, item)"
            @mouseover="iconMouseover(item)"
            @mouseout="iconMouseout(item)"
            @dragenter="iconDragEnter($event, item)"
          >
            <div
              class="iconBoxAccent"
              :style="{ backgroundColor: item.name == selectedIcon.name ? 'var(--accent)' : '' }"
            ></div>
            <div class="iconBoxContent" @click="libraryHandleClick(item)">
              <span
                :ref="(el) => setIconRef(item.name, el)"
                :style="getIconMaskStyle(item)"
                :class="[
                  'sidebar-icon',
                  {
                    'is-active': item.name === selectedIcon.name,
                    'is-playing': isPlayingLibraryIcon(item)
                  }
                ]"
              ></span>
              <bubbleBox
                :dom="iconRefMap[item.name] || undefined"
                :title="getIconTooltipTitle(item)"
              />
            </div>
          </div>
          <div
            v-if="desktopLibraryIcon || desktopRuntimeMissing || externalDjSourceIcons.length"
            class="deviceGroup deviceGroup--desktop"
            :class="{
              'deviceGroup--selected':
                isSelectedDesktopLibraryIcon ||
                externalDjSourceIcons.some((item) => isSelectedExternalDjSourceIcon(item)),
              'deviceGroup--multi':
                externalDjSourceIcons.length +
                  (desktopLibraryIcon || desktopRuntimeMissing ? 1 : 0) >
                1
            }"
          >
            <div class="deviceGroupInner">
              <RekordboxRuntimeMissingEntry
                v-if="desktopRuntimeMissing"
                :icon-asset="rekordboxIconAsset"
                :downloading="desktopRuntimeDownloading"
                :hint="t('optionalComponents.rekordboxMissingHint')"
                @download="downloadDesktopRuntime"
              />
              <div
                v-if="desktopLibraryIcon"
                :ref="(el) => setScrollItemRef(desktopLibraryIcon?.key || '', el)"
                class="iconBox iconBox--device iconBox--device-group"
                data-user-guide-target="rekordbox-library"
                :class="{ 'is-importing': isImportingDesktopLibraryIcon }"
                @click="clickDesktopLibraryIcon()"
                @contextmenu.stop.prevent="handleDesktopLibraryContextmenu($event)"
                @mouseover="iconMouseover(desktopLibraryIcon)"
                @mouseout="iconMouseout(desktopLibraryIcon)"
              >
                <div
                  class="iconBoxAccent"
                  :style="{ backgroundColor: isSelectedDesktopLibraryIcon ? 'var(--accent)' : '' }"
                ></div>
                <div class="iconBoxContent">
                  <span
                    :ref="(el) => setIconRef(desktopLibraryIcon?.key || '', el)"
                    :style="getIconMaskStyle(desktopLibraryIcon)"
                    :class="[
                      'sidebar-icon',
                      {
                        'is-active': isSelectedDesktopLibraryIcon,
                        'is-importing': isImportingDesktopLibraryIcon
                      }
                    ]"
                  ></span>
                  <bubbleBox
                    :dom="iconRefMap[desktopLibraryIcon?.key || ''] || undefined"
                    :title="
                      isImportingDesktopLibraryIcon
                        ? t('pioneer.importArtistsSourceBusyTooltip')
                        : desktopLibraryIcon?.tooltip || ''
                    "
                    :max-width="320"
                  />
                </div>
              </div>
              <div
                v-for="item of externalDjSourceIcons"
                :key="item.key"
                :ref="(el) => setScrollItemRef(item.key, el)"
                class="iconBox iconBox--device iconBox--device-group"
                @click="clickExternalDjSourceIcon(item)"
                @mouseover="iconMouseover(item)"
                @mouseout="iconMouseout(item)"
              >
                <div
                  class="iconBoxAccent"
                  :style="{
                    backgroundColor: isSelectedExternalDjSourceIcon(item) ? 'var(--accent)' : ''
                  }"
                ></div>
                <div class="iconBoxContent">
                  <span
                    :ref="(el) => setIconRef(item.key, el)"
                    :style="getIconMaskStyle(item)"
                    class="sidebar-icon sidebar-icon--dj-brand"
                    :class="{ 'is-active': isSelectedExternalDjSourceIcon(item) }"
                  ></span>
                  <bubbleBox
                    :dom="iconRefMap[item.key] || undefined"
                    :title="item.tooltip"
                    :max-width="320"
                  />
                </div>
              </div>
            </div>
          </div>
          <div
            v-for="group of pioneerDriveGroups"
            :key="group.key"
            class="deviceGroup"
            :class="{
              'deviceGroup--selected': group.icons.some((item) => isSelectedPioneerDriveIcon(item)),
              'deviceGroup--multi': group.icons.length > 1
            }"
          >
            <div class="deviceGroupInner">
              <template v-for="item of group.icons" :key="item.key">
                <div
                  :ref="(el) => setScrollItemRef(item.key, el)"
                  class="iconBox iconBox--device iconBox--device-group"
                  data-user-guide-target="usb-library"
                  :class="{
                    'is-ejecting': isEjectingPioneerDriveIcon(item),
                    'is-importing': isImportingPioneerDriveIcon(item)
                  }"
                  @click="isEjectingPioneerDriveIcon(item) ? null : clickPioneerDriveIcon(item)"
                  @contextmenu.stop.prevent="handlePioneerDriveContextmenu($event, item)"
                  @mouseover="iconMouseover(item)"
                  @mouseout="iconMouseout(item)"
                >
                  <div
                    class="iconBoxAccent"
                    :style="{
                      backgroundColor: isSelectedPioneerDriveIcon(item) ? 'var(--accent)' : ''
                    }"
                  ></div>
                  <div class="iconBoxContent">
                    <span
                      :ref="(el) => setIconRef(item.key, el)"
                      :style="getIconMaskStyle(item)"
                      :class="[
                        'sidebar-icon',
                        {
                          'is-active': isSelectedPioneerDriveIcon(item),
                          'is-ejecting': isEjectingPioneerDriveIcon(item),
                          'is-importing': isImportingPioneerDriveIcon(item)
                        }
                      ]"
                    ></span>
                    <bubbleBox
                      :dom="iconRefMap[item.key] || undefined"
                      :title="
                        isEjectingPioneerDriveIcon(item)
                          ? t('library.ejectUsbDriveProgress')
                          : isImportingPioneerDriveIcon(item)
                            ? t('pioneer.importArtistsSourceBusyTooltip')
                            : item.tooltip
                      "
                      :max-width="320"
                    />
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </OverlayScrollbarsComponent>
      <div
        v-show="railScrollState.canScroll && !railScrollState.atBottom"
        class="librarySelectAreaScrollFade librarySelectAreaScrollFade--bottom"
      ></div>
    </div>
  </div>
</template>
<style lang="scss" scoped src="./librarySelectArea.scss"></style>
