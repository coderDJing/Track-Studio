<script setup lang="ts">
import listIconAsset from '@renderer/assets/list.svg?asset'
import likeIconAsset from '@renderer/assets/like.svg?asset'
import trashIconAsset from '@renderer/assets/trash.svg?asset'
import mixtapeIconAsset from '@renderer/assets/mixtape.svg?asset'
import setListIconAsset from '@renderer/assets/setList.svg?asset'
import recordIconAsset from '@renderer/assets/record.svg?asset'
import rekordboxIconAsset from '@renderer/assets/rekordbox.svg?asset'
import rekordboxUsbIconAsset from '@renderer/assets/rekordboxUsb.svg?asset'
import seratoIconAsset from '@renderer/assets/serato.svg?asset'
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
import { requestUserGuideStep } from '@renderer/composables/userGuideBridge'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_CHANGED_EVENT, RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { useRekordboxSourceIcons } from './librarySelectArea/useRekordboxSourceIcons'
import { useExternalDjSourceIcons } from './librarySelectArea/useExternalDjSourceIcons'
import { useLibraryBatchActions } from './librarySelectArea/useLibraryBatchActions'
import { resolveActivePlaybackSongListUUIDs } from '@renderer/utils/playbackSongListSources'
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
  }
]

const iconArr = ref<Icon[]>([...baseIcons])
const coreIconNameSet = new Set([
  'FilterLibrary',
  'CuratedLibrary',
  'SetLibrary',
  'MixtapeLibrary',
  'RecycleBin'
])
const coreIconArr = computed(() => iconArr.value.filter((item) => coreIconNameSet.has(item.name)))
const dynamicIconArr = computed(() =>
  iconArr.value.filter((item) => !coreIconNameSet.has(item.name))
)
const selectedIcon = ref<HoverableIcon>(iconArr.value[0])
selectedIcon.value.src = selectedIcon.value.white

const runtime = useRuntimeStore()
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

const resolveLibraryUserGuideTarget = (name: string) => {
  if (name === 'FilterLibrary' || name === 'CuratedLibrary') return 'filter-curated'
  if (name === 'SetLibrary') return 'set-library'
  if (name === 'MixtapeLibrary') return 'mixtape-library'
  if (name === 'RecordingLibrary') return 'recording-library'
  return undefined
}

const requestLibraryUserGuide = (name: string) => {
  if (name === 'SetLibrary') {
    void requestUserGuideStep('setLibrary')
    return
  }
  if (name === 'MixtapeLibrary') {
    void requestUserGuideStep('mixtapeLibrary')
    return
  }
  if (name === 'RecordingLibrary') {
    void requestUserGuideStep('recordingLibrary')
  }
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

const clickIcon = (item: Icon) => {
  if (item.name === 'RecycleBin') {
    scheduleRecycleBinTrackCountRefresh()
  }
  if (item.name == selectedIcon.value.name) {
    runtime.libraryAreaSelected = item.name
    return
  }
  runtime.libraryAreaSelected = item.name
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
  emitLibrarySelectedChange: (payload) => emit('librarySelectedChange', payload)
})
const {
  sourceIcons: externalDjSourceIcons,
  clickSourceIcon: clickExternalDjSourceIcon,
  isSelectedSourceIcon: isSelectedExternalDjSourceIcon
} = useExternalDjSourceIcons({
  runtime,
  seratoIconAsset,
  updateSelectedIcon,
  emitLibrarySelectedChange: (payload) => emit('librarySelectedChange', payload)
})
const hasDynamicEntries = computed(
  () =>
    dynamicIconArr.value.length > 0 ||
    Boolean(desktopLibraryIcon.value) ||
    externalDjSourceIcons.value.length > 0 ||
    pioneerDriveGroups.value.length > 0
)
const dynamicIconsScrollRef = useTemplateRef<OverlayScrollbarsComponentRef>('dynamicIconsScrollRef')
const dynamicScrollState = reactive({
  canScroll: false,
  atTop: true,
  atBottom: true
})
let dynamicScrollViewportEl: HTMLElement | null = null
const updateDynamicScrollState = () => {
  const viewport = dynamicIconsScrollRef.value?.osInstance()?.elements().viewport as
    | HTMLElement
    | undefined
  if (!viewport) {
    dynamicScrollState.canScroll = false
    dynamicScrollState.atTop = true
    dynamicScrollState.atBottom = true
    return
  }
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  dynamicScrollState.canScroll = maxScrollTop > 1
  dynamicScrollState.atTop = viewport.scrollTop <= 1
  dynamicScrollState.atBottom = viewport.scrollTop >= maxScrollTop - 1
}
const handleDynamicScroll = () => {
  updateDynamicScrollState()
}
const syncDynamicScrollViewport = async () => {
  await nextTick()
  const viewport = dynamicIconsScrollRef.value?.osInstance()?.elements().viewport as
    | HTMLElement
    | undefined
  if (dynamicScrollViewportEl !== viewport) {
    dynamicScrollViewportEl?.removeEventListener('scroll', handleDynamicScroll)
    dynamicScrollViewportEl = viewport || null
    dynamicScrollViewportEl?.addEventListener('scroll', handleDynamicScroll, { passive: true })
  }
  updateDynamicScrollState()
}
const selectedDynamicScrollKey = computed(() => {
  if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
    return (
      runtime.externalDjLibrary.selectedSourceKey ||
      runtime.pioneerDeviceLibrary.selectedSourceKey ||
      ''
    )
  }
  return dynamicIconArr.value.some((item) => item.name === runtime.libraryAreaSelected)
    ? runtime.libraryAreaSelected
    : ''
})
const scrollSelectedDynamicIconIntoView = async () => {
  const key = selectedDynamicScrollKey.value
  if (!key) return
  await nextTick()
  const viewport = dynamicIconsScrollRef.value?.osInstance()?.elements().viewport as
    | HTMLElement
    | undefined
  const target = scrollItemRefMap[key]
  if (!viewport || !target) return
  target.scrollIntoView({ block: 'nearest' })
  updateDynamicScrollState()
}
onMounted(() => {
  void syncDynamicScrollViewport()
})

onUnmounted(() => {
  dynamicScrollViewportEl?.removeEventListener('scroll', handleDynamicScroll)
  dynamicScrollViewportEl = null
})

const libraryHandleClick = (item: Icon) => {
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
  // 当拖拽歌曲时，自动切换到对应的库
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
    dynamicIconArr.value.map((item) => item.name).join('|'),
    desktopLibraryIcon.value?.key || '',
    externalDjSourceIcons.value.map((item) => item.key).join('|'),
    pioneerDriveGroups.value.map((group) => group.icons.map((item) => item.key).join(',')).join('|')
  ],
  () => {
    void syncDynamicScrollViewport()
    void scrollSelectedDynamicIconIntoView()
  },
  { flush: 'post' }
)

watch(
  () => selectedDynamicScrollKey.value,
  () => {
    void scrollSelectedDynamicIconIntoView()
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
  <div class="librarySelectArea unselectable">
    <div class="librarySelectAreaCore" data-user-guide-target="library-rail">
      <div
        v-for="item of coreIconArr"
        :key="item.name"
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
          <bubbleBox :dom="iconRefMap[item.name] || undefined" :title="getIconTooltipTitle(item)" />
        </div>
      </div>
    </div>

    <div
      class="librarySelectAreaDynamic"
      :class="{ 'librarySelectAreaDynamic--with-divider': hasDynamicEntries }"
    >
      <div v-if="hasDynamicEntries" class="librarySelectAreaDynamicScrollShell">
        <div
          v-show="dynamicScrollState.canScroll && !dynamicScrollState.atTop"
          class="librarySelectAreaScrollFade librarySelectAreaScrollFade--top"
        ></div>
        <OverlayScrollbarsComponent
          ref="dynamicIconsScrollRef"
          class="librarySelectAreaDynamicScroller"
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
            v-if="desktopLibraryIcon || externalDjSourceIcons.length"
            class="deviceGroup deviceGroup--desktop"
            :class="{
              'deviceGroup--selected':
                isSelectedDesktopLibraryIcon ||
                externalDjSourceIcons.some((item) => isSelectedExternalDjSourceIcon(item)),
              'deviceGroup--multi': externalDjSourceIcons.length + (desktopLibraryIcon ? 1 : 0) > 1
            }"
          >
            <div class="deviceGroupInner">
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
        </OverlayScrollbarsComponent>
        <div
          v-show="dynamicScrollState.canScroll && !dynamicScrollState.atBottom"
          class="librarySelectAreaScrollFade librarySelectAreaScrollFade--bottom"
        ></div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.librarySelectArea {
  height: 100%;
  width: 45px;
  border-right: 1px solid var(--border);
  background-color: var(--bg);
  display: flex;
  flex-direction: column;
  align-items: stretch;

  .librarySelectAreaCore {
    flex: 0 0 auto;
  }

  .librarySelectAreaDynamic {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }

  .librarySelectAreaDynamic--with-divider {
    min-height: 45px;
  }

  .librarySelectAreaDynamic--with-divider::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: color-mix(in srgb, var(--border) 88%, transparent);
    pointer-events: none;
    z-index: 2;
  }

  .librarySelectAreaDynamicScrollShell {
    height: 100%;
    position: relative;
  }

  .librarySelectAreaDynamicScroller {
    height: 100%;
    width: 100%;
  }

  .librarySelectAreaScrollFade {
    position: absolute;
    left: 0;
    right: 0;
    height: 18px;
    pointer-events: none;
    z-index: 1;
  }

  .librarySelectAreaScrollFade--top {
    top: 0;
    background: linear-gradient(to bottom, var(--bg), transparent);
  }

  .librarySelectAreaScrollFade--bottom {
    bottom: 0;
    background: linear-gradient(to top, var(--bg), transparent);
  }

  .fade-enter-active,
  .fade-leave-active {
    transition: opacity 0.15s;
  }

  .fade-enter,
  .fade-leave-to {
    opacity: 0;
  }

  .iconBox {
    width: 45px;
    height: 45px;
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;

    .iconBoxAccent {
      width: 2px;
      height: 100%;
      flex: 0 0 2px;
    }

    .iconBoxContent {
      flex-grow: 1;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      position: relative;
    }

    .sidebar-icon {
      width: 25px;
      height: 25px;
      display: inline-block;
      position: relative;
      opacity: var(--sidebar-icon-opacity);
      background-color: currentColor;
      color: var(--text);
      mask-image: var(--icon-mask);
      mask-repeat: no-repeat;
      mask-position: center;
      mask-size: contain;
      -webkit-mask-image: var(--icon-mask);
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-position: center;
      -webkit-mask-size: contain;
      transition:
        opacity 0.15s ease,
        color 0.15s ease;
    }

    .sidebar-icon.is-ejecting,
    .sidebar-icon.is-importing {
      opacity: 0.82;
    }

    .sidebar-icon.is-ejecting::after,
    .sidebar-icon.is-importing::after {
      content: '';
      position: absolute;
      width: 6px;
      height: 6px;
      right: -2px;
      bottom: -1px;
      border-radius: 999px;
      background-color: var(--accent);
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 24%, transparent);
      animation: usb-drive-eject-dot 1.15s ease-in-out infinite;
      pointer-events: none;
    }

    &:hover .sidebar-icon {
      opacity: 0.85;
    }

    .sidebar-icon.is-active {
      opacity: 1;
    }

    .sidebar-icon.is-playing {
      opacity: 1;
      color: var(--accent);
    }

    &.iconBox--device.is-ejecting,
    &.iconBox--device.is-importing {
      cursor: progress;
    }

    &.iconBox--device-group {
      height: 39px;
    }
  }

  .deviceGroup {
    --device-connector-x: 6px;
    --device-connector-branch-width: 4px;
    width: 45px;
    display: flex;
    justify-content: center;
    padding: 4px 0;
  }

  .deviceGroupInner {
    width: 45px;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
  }

  :deep(.librarySelectAreaDynamicScroller .os-viewport) {
    overscroll-behavior: contain;
  }

  .deviceGroup--multi .deviceGroupInner::before {
    content: '';
    position: absolute;
    top: 19.5px;
    bottom: 19.5px;
    left: var(--device-connector-x);
    width: 1.5px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--border) 78%, transparent);
    pointer-events: none;
  }

  .deviceGroup--multi .iconBox--device-group::before {
    content: '';
    position: absolute;
    left: var(--device-connector-x);
    top: 50%;
    width: var(--device-connector-branch-width);
    height: 1.5px;
    transform: translateY(-50%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--border) 78%, transparent);
    pointer-events: none;
  }

  .deviceGroup--selected.deviceGroup--multi .deviceGroupInner::before,
  .deviceGroup--selected.deviceGroup--multi .iconBox--device-group::before {
    background: color-mix(in srgb, var(--accent) 52%, var(--border));
  }

  .bubbleBox {
    height: 22px;
    line-height: 22px;
    text-align: center;
    position: relative;
    border-radius: 3px;
    border: 1px solid var(--border);
    font-size: 12px;
    background-color: var(--bg-elev);
    padding: 0 10px;
  }

  .bubbleBox::before {
    content: '';
    position: absolute;
    width: 0;
    height: 0;
    top: 5px;
    left: -5px;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-right: 5px solid var(--border);
  }

  @keyframes usb-drive-eject-dot {
    0%,
    100% {
      opacity: 0.45;
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 12%, transparent);
    }

    50% {
      opacity: 1;
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 0%, transparent);
    }
  }
}
</style>
