<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRef, useTemplateRef, watch } from 'vue'
import playerControls from '@renderer/components/playerControls.vue'
import BpmTap from '@renderer/pages/modules/songPlayer/BpmTap.vue'
import PlayerCoverSlot from '@renderer/pages/modules/songPlayer/PlayerCoverSlot.vue'
import PlayerStructureRail from '@renderer/pages/modules/songPlayer/PlayerStructureRail.vue'
import PlaybackRangeHandles from '@renderer/pages/modules/songPlayer/PlaybackRangeHandles.vue'
import HotCueMarkersLayer from '@renderer/components/HotCueMarkersLayer.vue'
import MemoryCueMarkersLayer from '@renderer/components/MemoryCueMarkersLayer.vue'
import WindowVolumeDial from '@renderer/components/WindowVolumeDial.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useCover } from '@renderer/pages/modules/songPlayer/useCover'
import { usePlayerHotkeys } from '@renderer/pages/modules/songPlayer/usePlayerHotkeys'
import { useMiniPlayerRemoteWaveform } from '@renderer/composables/miniPlayer/useMiniPlayerRemoteWaveform'
import { useMiniPlayerPlayheadDiagnostics } from '@renderer/composables/miniPlayer/useMiniPlayerPlayheadDiagnostics'
import { cloneMiniPlayerHostState } from '@renderer/composables/miniPlayer/miniPlayerStateClone'
import {
  cloneMiniPlayerTaskProgress,
  type MiniPlayerTaskProgress
} from '@shared/miniPlayerTaskProgress'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import {
  MINI_PLAYER_CHANNELS,
  type MiniPlayerCommand,
  type MiniPlayerCoverPopupAnchor,
  type MiniPlayerHostState,
  type MiniPlayerOverlayKind,
  type MiniPlayerOverlayMenuAction,
  type MiniPlayerOverlayResult,
  type MiniPlayerPlayhead,
  type MiniPlayerSession,
  type MiniPlayerTransferActionMode,
  type MiniPlayerTransferTarget
} from '@shared/miniPlayerWindow'
import libraryUtils from '@renderer/utils/libraryUtils'
import logoAsset from '@renderer/assets/logo.png?asset'

const runtime = useRuntimeStore()
const miniPlayerPlaceholderCover = logoAsset
const waveform = useTemplateRef<HTMLDivElement>('waveform')
const focusCanvas = useTemplateRef<HTMLCanvasElement>('focusCanvas')
const pinRef = useTemplateRef<HTMLDivElement>('pinRef')
const closeRef = useTemplateRef<HTMLDivElement>('closeRef')
const coverAnchorRef = useTemplateRef<HTMLDivElement>('coverAnchorRef')
const hostState = ref<MiniPlayerHostState | null>(null)
const { notePlaybackUpdate } = useMiniPlayerPlayheadDiagnostics(hostState)
const overlayBusy = ref(false)
const overlayOpen = ref(false)
const windowFocused = ref(false)
const selectSongListDialogShow = overlayBusy
const alwaysOnTop = computed(() => runtime.miniPlayerSession.alwaysOnTop !== false)
const song = computed(() => hostState.value?.song || runtime.playingData.playingSong)
const isPlaying = computed(() => !!hostState.value?.isPlaying)
const currentSeconds = computed(() => Number(hostState.value?.currentSeconds) || 0)
const durationSeconds = computed(() => Number(hostState.value?.durationSeconds) || 0)
const volume = computed(() => Number(hostState.value?.volume) || 0)
const waveformMode = computed(() => hostState.value?.waveformMode || 'half')
const compactVisualWaveform = computed(() => hostState.value?.compactVisualWaveform || null)
const pioneerPreviewWaveform = computed(() => hostState.value?.pioneerPreviewWaveform || null)
const playbackRange = computed(() => hostState.value?.playbackRange || null)
const taskProgressVisible = computed(() => !!hostState.value?.taskProgress?.visible)
const taskProgressPercent = computed(() => {
  const percent = hostState.value?.taskProgress?.percent
  return percent === null || percent === undefined ? null : percent
})
const taskProgressBarStyle = computed(() => ({
  width: taskProgressPercent.value === null ? '100%' : `${taskProgressPercent.value}%`
}))
const waveformContainerWidth = ref(0)
let waveformResizeObserver: ResizeObserver | null = null
let focusCanvasResizeObserver: ResizeObserver | null = null
let focusAnimationFrame = 0
let focusAnimationStartedAt = 0

const updateWaveformContainerWidth = () => {
  waveformContainerWidth.value = waveform.value?.clientWidth || 0
}

const focusKeyboardTarget = () => {
  const el = waveform.value
  if (!el) return
  el.focus({ preventScroll: true })
}
const isReadOnlyPlaybackSource = computed(() =>
  isRekordboxExternalPlaybackSource(
    runtime.playingData.playingSongListUUID,
    runtime.playingData.playingSong
  )
)
const { coverBlobUrl, setCoverByIPC } = useCover(runtime)
const formatTime = (seconds: number) => {
  const safe = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(safe / 60)
  const secondsRemainder = Math.round(safe) % 60
  return `${minutes}:${`0${secondsRemainder}`.slice(-2)}`
}
const timeText = computed(() => formatTime(currentSeconds.value))
const durationText = computed(() => formatTime(durationSeconds.value))

const sendCommand = (command: MiniPlayerCommand) => {
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.command, command)
}

const coverPopupOpen = ref(false)
let coverHideTimer: ReturnType<typeof setTimeout> | null = null
let coverPointerInsidePopup = false

const clearCoverHideTimer = () => {
  if (!coverHideTimer) return
  clearTimeout(coverHideTimer)
  coverHideTimer = null
}

const hideCoverPopup = async () => {
  clearCoverHideTimer()
  coverPointerInsidePopup = false
  coverPopupOpen.value = false
  await window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.hideCoverPopup)
}

const isCoverPopupBlocked = () => overlayOpen.value

const showCoverPopup = async () => {
  const current = song.value
  const anchorEl = coverAnchorRef.value
  if (!current?.filePath || !anchorEl || isCoverPopupBlocked()) return
  const rect = anchorEl.getBoundingClientRect()
  const songListUUID = String(
    hostState.value?.playingSongListUUID || runtime.playingData.playingSongListUUID || ''
  )
  coverPopupOpen.value = true
  await window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.showCoverPopup, {
    filePath: current.filePath,
    title: String(current.title || ''),
    artist: String(current.artist || ''),
    album: String(current.album || ''),
    label: String(current.label || ''),
    songListUUID,
    rootDir: libraryUtils.findDirPathByUuid(songListUUID) || '',
    anchor: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    }
  })
}

const handleCoverEnter = () => {
  clearCoverHideTimer()
  void showCoverPopup()
}

const scheduleCoverPopupHide = () => {
  clearCoverHideTimer()
  coverHideTimer = setTimeout(() => {
    if (coverPointerInsidePopup) return
    void hideCoverPopup()
  }, 200)
}

const handleCoverPopupPointer = (_event: unknown, payload: { inside?: boolean }) => {
  coverPointerInsidePopup = !!payload?.inside
  if (coverPointerInsidePopup) {
    clearCoverHideTimer()
    return
  }
  scheduleCoverPopupHide()
}

const getBarAnchor = (): MiniPlayerCoverPopupAnchor => {
  const el = document.querySelector('.mini-player__bar') as HTMLElement | null
  const rect = el?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0, width: 100, height: 62 }
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

let ignoreMoreToggleUntil = 0
let menuRequestOpen = false

const showOverlay = async (
  kind: MiniPlayerOverlayKind,
  payload: unknown,
  anchor?: MiniPlayerCoverPopupAnchor | null
) => {
  void hideCoverPopup()
  overlayOpen.value = true
  overlayBusy.value = kind !== 'menu'
  try {
    return (await window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.showOverlay, {
      kind,
      payload,
      anchor: anchor || getBarAnchor()
    })) as MiniPlayerOverlayResult
  } finally {
    overlayOpen.value = false
    overlayBusy.value = false
  }
}

const applyHostState = (payload: MiniPlayerHostState | null) => {
  if (!payload) {
    hostState.value = null
    notePlaybackUpdate({ currentSeconds: 0, durationSeconds: 0, isPlaying: false })
    runtime.playingData.playingSong = null
    runtime.playingData.playingSongListUUID = ''
    return
  }
  const next = cloneMiniPlayerHostState(payload)
  hostState.value = next
  notePlaybackUpdate(next)
  runtime.playingData.playingSong = next.song
  runtime.playingData.playingSongListUUID = next.playingSongListUUID
}

const handleHostState = (_event: unknown, payload: MiniPlayerHostState) => {
  applyHostState(payload)
}

const handlePlayhead = (_event: unknown, payload: MiniPlayerPlayhead) => {
  if (!hostState.value) return
  hostState.value = {
    ...hostState.value,
    currentSeconds: Number(payload?.currentSeconds) || 0,
    durationSeconds: Number(payload?.durationSeconds) || 0,
    isPlaying: !!payload?.isPlaying,
    volume: Number(payload?.volume) || 0
  }
  notePlaybackUpdate(hostState.value)
}

const handleTaskProgress = (_event: unknown, payload: MiniPlayerTaskProgress) => {
  if (!hostState.value) return
  hostState.value = {
    ...hostState.value,
    taskProgress: cloneMiniPlayerTaskProgress(payload)
  }
}

const handleSession = (_event: unknown, payload: MiniPlayerSession) => {
  runtime.miniPlayerSession = {
    open: !!payload?.open,
    alwaysOnTop: payload?.alwaysOnTop !== false
  }
}

const handleWindowFocus = (_event: unknown, focused: unknown) => {
  windowFocused.value = focused === true || document.hasFocus()
}

const handleRendererFocus = () => {
  windowFocused.value = true
}

const handleRendererBlur = () => {
  windowFocused.value = false
}

const FOCUS_SOURCE_CYCLE_MS = 3600

const resolveFocusPerimeterPoint = (
  distance: number,
  left: number,
  top: number,
  right: number,
  bottom: number
): { x: number; y: number; perimeter: number } => {
  const horizontalLength = Math.max(0, right - left)
  const verticalLength = Math.max(0, bottom - top)
  const perimeter = Math.max(1, 2 * (horizontalLength + verticalLength))
  let offset = ((distance % perimeter) + perimeter) % perimeter

  if (offset <= horizontalLength) {
    return { x: left + offset, y: top, perimeter }
  }
  offset -= horizontalLength
  if (offset <= verticalLength) {
    return { x: right, y: top + offset, perimeter }
  }
  offset -= verticalLength
  if (offset <= horizontalLength) {
    return { x: right - offset, y: bottom, perimeter }
  }
  offset -= horizontalLength
  return { x: left, y: bottom - offset, perimeter }
}

const drawFocusSource = (timestamp = performance.now()) => {
  const canvas = focusCanvas.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const cssWidth = Math.max(1, rect.width)
  const cssHeight = Math.max(1, rect.height)
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1)
  const pixelWidth = Math.max(1, Math.round(cssWidth * pixelRatio))
  const pixelHeight = Math.max(1, Math.round(cssHeight * pixelRatio))
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  const context = canvas.getContext('2d')
  if (!context) return
  // 按设备像素描边：2px 核的外沿落到 bitmap 最外一行。
  // CSS 的 height-1 在 125% 缩放下对不齐 62px 高的最后一行，底边会空出约 1px。
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, pixelWidth, pixelHeight)
  if (!windowFocused.value) return

  const accent = getComputedStyle(canvas).getPropertyValue('--accent').trim() || 'rgb(0, 170, 255)'
  const coreLineWidth = 2 * pixelRatio
  const glowLineWidth = 5 * pixelRatio
  const inset = coreLineWidth / 2
  const left = inset
  const top = inset
  const right = Math.max(left, pixelWidth - inset)
  const bottom = Math.max(top, pixelHeight - inset)
  const perimeter = resolveFocusPerimeterPoint(0, left, top, right, bottom).perimeter
  const elapsed = Math.max(0, timestamp - focusAnimationStartedAt)
  const headDistance = ((elapsed % FOCUS_SOURCE_CYCLE_MS) / FOCUS_SOURCE_CYCLE_MS) * perimeter
  const tailLength = Math.min(190, Math.max(120, cssWidth * 0.18)) * pixelRatio
  const segmentCount = Math.max(72, Math.ceil(tailLength / (2 * pixelRatio)))
  const lightTheme = document.documentElement.classList.contains('theme-light')

  const drawPass = (lineWidth: number, alphaScale: number, shadowBlur: number) => {
    context.lineWidth = lineWidth
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = accent
    context.shadowColor = accent
    context.shadowBlur = shadowBlur
    for (let index = 0; index < segmentCount; index += 1) {
      const startRatio = index / segmentCount
      const endRatio = (index + 1) / segmentCount
      const start = resolveFocusPerimeterPoint(
        headDistance - tailLength + tailLength * startRatio,
        left,
        top,
        right,
        bottom
      )
      const end = resolveFocusPerimeterPoint(
        headDistance - tailLength + tailLength * endRatio,
        left,
        top,
        right,
        bottom
      )
      context.globalAlpha = Math.pow(endRatio, 1.8) * alphaScale
      context.beginPath()
      context.moveTo(start.x, start.y)
      context.lineTo(end.x, end.y)
      context.stroke()
    }
  }

  drawPass(glowLineWidth, lightTheme ? 0.18 : 0.24, 7 * pixelRatio)
  drawPass(coreLineWidth, lightTheme ? 0.72 : 0.92, 2 * pixelRatio)
  context.globalAlpha = 1
  context.shadowBlur = 0
}

const stopFocusSourceAnimation = () => {
  if (focusAnimationFrame) {
    cancelAnimationFrame(focusAnimationFrame)
    focusAnimationFrame = 0
  }
}

const startFocusSourceAnimation = () => {
  stopFocusSourceAnimation()
  focusAnimationStartedAt = performance.now()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const renderFrame = (timestamp: number) => {
    drawFocusSource(timestamp)
    if (!windowFocused.value || reducedMotion) {
      focusAnimationFrame = 0
      return
    }
    focusAnimationFrame = requestAnimationFrame(renderFrame)
  }
  focusAnimationFrame = requestAnimationFrame(renderFrame)
}

watch(windowFocused, (focused) => {
  if (focused) {
    startFocusSourceAnimation()
    return
  }
  stopFocusSourceAnimation()
  drawFocusSource()
})

watch(
  () => runtime.setting.themeMode,
  () => drawFocusSource()
)

watch(
  () => song.value?.filePath,
  (filePath) => {
    if (filePath) {
      void setCoverByIPC(filePath)
      if (coverPopupOpen.value) void showCoverPopup()
      return
    }
    void hideCoverPopup()
  },
  { immediate: true }
)

useMiniPlayerRemoteWaveform({
  waveformEl: waveform,
  compactVisualWaveform,
  pioneerPreviewWaveform,
  currentSeconds,
  durationSeconds,
  waveformMode,
  themeMode: computed(() => runtime.setting.themeMode),
  onSeekPercent: (percent) => sendCommand({ type: 'seekPercent', percent })
})

const closeLocalMenus = () => {
  runtime.activeMenuUUID = ''
}

const showHint = async (content: string[]) => {
  await showOverlay('confirm', {
    title: t('dialog.hint'),
    content,
    confirmShow: false,
    innerHeight: 220,
    innerWidth: 400
  })
}

const openTransferDialog = async (
  libraryName: MiniPlayerTransferTarget,
  actionMode: MiniPlayerTransferActionMode = 'move'
) => {
  if (libraryName === 'MixtapeLibrary' && song.value?.beatGridStatus === 'no-bpm') {
    void showHint([t('mixtape.noBpmBlocked')])
    return
  }
  closeLocalMenus()
  const result = await showOverlay('song-list', { libraryName, actionMode })
  if (result.type !== 'song-list' || !result.uuid) return
  sendCommand({
    type: 'applyTransfer',
    libraryName,
    actionMode,
    targetUuid: result.uuid
  })
}

const handleExport = async () => {
  closeLocalMenus()
  const result = await showOverlay('export', {
    title: 'tracks.title',
    forceCopyOnly: isReadOnlyPlaybackSource.value
  })
  if (result.type !== 'export') return
  sendCommand({
    type: 'export',
    folderPath: result.folderPath,
    deleteAfter: isReadOnlyPlaybackSource.value ? false : result.deleteAfter
  })
}

const handleDelete = async () => {
  closeLocalMenus()
  if (isReadOnlyPlaybackSource.value) {
    await showHint([t('tracks.readOnlySourceDeleteNotAllowed')])
    return
  }
  if (String(hostState.value?.playingSongListUUID || '') === RECYCLE_BIN_UUID) {
    const result = await showOverlay('confirm', {
      title: t('common.delete'),
      content: [t('tracks.confirmDeletePlaying'), t('tracks.deleteHint')],
      confirmShow: true,
      innerHeight: 220,
      innerWidth: 400
    })
    if (result.type !== 'confirm' || !result.ok) return
  }
  sendCommand({ type: 'delete' })
}

const handleDeleteAllAbove = async () => {
  closeLocalMenus()
  if (isReadOnlyPlaybackSource.value) {
    await showHint([t('tracks.readOnlySourceDeleteNotAllowed')])
    return
  }
  const count = Number(hostState.value?.deleteAllAboveCount || 0)
  if (!(count > 0) || !hostState.value?.canDeleteAllAbove) return
  const isRecycle = String(hostState.value?.playingSongListUUID || '') === RECYCLE_BIN_UUID
  const content = [t('tracks.confirmDeleteAllAbovePlaying', { count })]
  if (isRecycle) {
    content.push(t('tracks.confirmDeleteAllAbove'), t('tracks.deleteHint'))
  }
  const result = await showOverlay('confirm', {
    title: t('common.delete'),
    content,
    confirmShow: true,
    innerHeight: isRecycle ? 260 : 220,
    innerWidth: 400
  })
  if (result.type !== 'confirm' || !result.ok) return
  sendCommand({ type: 'deleteAllAbove', confirmed: true })
}

const handleMenuAction = (action: MiniPlayerOverlayMenuAction) => {
  if (action === 'export') {
    void handleExport()
    return
  }
  if (action === 'moveToFilter') {
    void openTransferDialog('FilterLibrary', 'move')
    return
  }
  if (action === 'moveToCurated') {
    void openTransferDialog('CuratedLibrary', 'move')
    return
  }
  if (action === 'copyToFilter') {
    void openTransferDialog('FilterLibrary', 'copy')
    return
  }
  if (action === 'copyToCurated') {
    void openTransferDialog('CuratedLibrary', 'copy')
    return
  }
  if (action === 'addToSet') {
    void openTransferDialog('SetLibrary')
    return
  }
  if (action === 'addToMixtape') {
    void openTransferDialog('MixtapeLibrary')
    return
  }
  if (action === 'delete') {
    void handleDelete()
    return
  }
  if (action === 'deleteAllAbove') {
    void handleDeleteAllAbove()
    return
  }
  window.electron.ipcRenderer.send('show-item-in-folder', song.value?.filePath)
}

const handleToggleMiniMoreMenu = async (anchor: MiniPlayerCoverPopupAnchor | null) => {
  if (Date.now() < ignoreMoreToggleUntil) return
  if (menuRequestOpen) {
    await window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.hideOverlay)
    return
  }
  menuRequestOpen = true
  try {
    const result = await showOverlay(
      'menu',
      {
        isReadOnly: isReadOnlyPlaybackSource.value,
        filePath: String(song.value?.filePath || ''),
        canDeleteAllAbove: !!hostState.value?.canDeleteAllAbove
      },
      anchor
    )
    if (result.type === 'dismiss') {
      ignoreMoreToggleUntil = Date.now() + 280
      return
    }
    if (result.type === 'menu') handleMenuAction(result.action)
  } finally {
    menuRequestOpen = false
  }
}

const toggleAlwaysOnTop = async () => {
  await window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.setAlwaysOnTop, !alwaysOnTop.value)
}

const restoreMainWindow = async () => {
  await window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.close)
}

const playerState = {
  waveformShow: computed({
    get: () => !!song.value,
    set: () => undefined
  }),
  selectSongListDialogShow,
  confirmShow: overlayBusy,
  songsAreaSelectedCount: computed(() => 0),
  activeMenuUUID: toRef(runtime, 'activeMenuUUID'),
  isPlaying
}

usePlayerHotkeys(
  {
    play: () => sendCommand({ type: 'play' }),
    pause: () => sendCommand({ type: 'pause' }),
    togglePlayPause: () => sendCommand({ type: 'togglePlayPause' }),
    fastForward: () => sendCommand({ type: 'fastForward' }),
    fastBackward: () => sendCommand({ type: 'fastBackward' }),
    nextSong: () => sendCommand({ type: 'next' }),
    previousSong: () => sendCommand({ type: 'previous' }),
    delSong: () => {
      void handleDelete()
    },
    moveToListLibrary: () =>
      openTransferDialog('FilterLibrary', isReadOnlyPlaybackSource.value ? 'copy' : 'move'),
    moveToLikeLibrary: () =>
      openTransferDialog('CuratedLibrary', isReadOnlyPlaybackSource.value ? 'copy' : 'move'),
    seekToPercent: (percent: number) => sendCommand({ type: 'seekPercent', percent }),
    togglePlaybackRange: () => sendCommand({ type: 'togglePlaybackRange' }),
    volumeUp: () => sendCommand({ type: 'setVolume', value: Math.min(1, volume.value + 0.05) }),
    volumeDown: () => sendCommand({ type: 'setVolume', value: Math.max(0, volume.value - 0.05) })
  },
  playerState,
  runtime
)

onMounted(() => {
  windowFocused.value = document.hasFocus()
  window.addEventListener('focus', handleRendererFocus)
  window.addEventListener('blur', handleRendererBlur)
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.hostState, handleHostState)
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.playhead, handlePlayhead)
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.taskProgress, handleTaskProgress)
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.session, handleSession)
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.windowFocus, handleWindowFocus)
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.coverPopupPointer, handleCoverPopupPointer)
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.requestKeyboardFocus, focusKeyboardTarget)
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.rendererReady)
  updateWaveformContainerWidth()
  focusKeyboardTarget()
  if (waveform.value) {
    waveformResizeObserver = new ResizeObserver(() => updateWaveformContainerWidth())
    waveformResizeObserver.observe(waveform.value)
  }
  if (focusCanvas.value?.parentElement) {
    focusCanvasResizeObserver = new ResizeObserver(() => drawFocusSource())
    focusCanvasResizeObserver.observe(focusCanvas.value.parentElement)
  }
  if (windowFocused.value) startFocusSourceAnimation()
})

onUnmounted(() => {
  window.removeEventListener('focus', handleRendererFocus)
  window.removeEventListener('blur', handleRendererBlur)
  stopFocusSourceAnimation()
  focusCanvasResizeObserver?.disconnect()
  focusCanvasResizeObserver = null
  waveformResizeObserver?.disconnect()
  waveformResizeObserver = null
  clearCoverHideTimer()
  void hideCoverPopup()
  void window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.hideOverlay)
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.hideTooltip)
  window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.hostState, handleHostState)
  window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.playhead, handlePlayhead)
  window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.taskProgress, handleTaskProgress)
  window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.session, handleSession)
  window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.windowFocus, handleWindowFocus)
  window.electron.ipcRenderer.removeListener(
    MINI_PLAYER_CHANNELS.coverPopupPointer,
    handleCoverPopupPointer
  )
  window.electron.ipcRenderer.removeListener(
    MINI_PLAYER_CHANNELS.requestKeyboardFocus,
    focusKeyboardTarget
  )
})
</script>

<template>
  <div
    class="mini-player unselectable canDrag"
    :class="{ 'is-window-focused': windowFocused }"
    @pointerdown="focusKeyboardTarget"
  >
    <canvas ref="focusCanvas" class="mini-player__focus-source" aria-hidden="true"></canvas>
    <div
      v-if="taskProgressVisible"
      class="mini-player__task-progress"
      :class="{ 'is-indeterminate': taskProgressPercent === null }"
      aria-hidden="true"
    >
      <div class="mini-player__task-progress-bar" :style="taskProgressBarStyle"></div>
    </div>
    <div class="mini-player__bar canDrag">
      <div ref="coverAnchorRef" class="mini-player__cover canNotDrag">
        <PlayerCoverSlot
          :cover-blob-url="coverBlobUrl"
          :placeholder-src="miniPlayerPlaceholderCover"
          :slot-size="52"
          :cover-size="44"
          :placeholder-size="28"
          @hover-cover="handleCoverEnter"
          @leave-cover="scheduleCoverPopupHide"
        />
      </div>
      <div class="mini-player__controls">
        <playerControls
          variant="mini"
          :playing="isPlaying"
          @pause="sendCommand({ type: 'pause' })"
          @play="sendCommand({ type: 'play' })"
          @fast-forward="sendCommand({ type: 'fastForward' })"
          @fast-backward="sendCommand({ type: 'fastBackward' })"
          @next-song="sendCommand({ type: 'next' })"
          @previous-song="sendCommand({ type: 'previous' })"
          @del-song="handleDelete"
          @move-to-list-library="
            (_song, actionMode) => openTransferDialog('FilterLibrary', actionMode || 'move')
          "
          @move-to-like-library="
            (_song, actionMode) => openTransferDialog('CuratedLibrary', actionMode || 'move')
          "
          @move-to-set-library="openTransferDialog('SetLibrary')"
          @move-to-mixtape-library="openTransferDialog('MixtapeLibrary')"
          @export-track="handleExport"
          @toggle-mini-window="restoreMainWindow"
          @toggle-mini-more-menu="handleToggleMiniMoreMenu"
        />
      </div>
      <div class="mini-player__waveform">
        <div id="waveform" ref="waveform" class="canNotDrag" tabindex="0">
          <div id="time">{{ timeText }}</div>
          <div id="duration">{{ durationText }}</div>
          <MemoryCueMarkersLayer
            :memory-cues="song?.memoryCues || []"
            :visible-duration-sec="durationSeconds"
            anchor="top"
            size="compact"
          />
          <HotCueMarkersLayer
            :hot-cues="song?.hotCues || []"
            :visible-duration-sec="durationSeconds"
            anchor="top"
            size="compact"
            clickable
            @marker-click="sendCommand({ type: 'seekSeconds', seconds: $event.sec })"
          />
          <PlaybackRangeHandles
            :model-value-start="playbackRange?.startPercent || 0"
            :model-value-end="playbackRange?.endPercent || 100"
            :container-width="waveformContainerWidth"
            :enable-playback-range="!!playbackRange?.visible"
            :waveform-show="!!song"
            :locked="playbackRange?.locked"
            :locked-ranges="playbackRange?.lockedRanges || []"
            @update:model-value-start="
              sendCommand({ type: 'setPlaybackRangeStartPercent', value: $event })
            "
            @update:model-value-end="
              sendCommand({ type: 'setPlaybackRangeEndPercent', value: $event })
            "
            @drag-end="sendCommand({ type: 'savePlaybackRange' })"
          />
        </div>
        <PlayerStructureRail
          class="canNotDrag"
          :song="song || null"
          :current-seconds="currentSeconds"
          :duration-seconds="durationSeconds"
          @seek-play="sendCommand({ type: 'seekSeconds', seconds: $event })"
        />
      </div>
      <div class="mini-player__side">
        <BpmTap :song="song || null" :waveform-show="!!song" />
        <WindowVolumeDial
          class="canNotDrag"
          :model-value="volume"
          :label="t('player.volumeControl')"
          :size="26"
          @update:model-value="sendCommand({ type: 'setVolume', value: $event })"
        />
        <div
          ref="pinRef"
          class="mini-player__icon mini-player__icon--pin canNotDrag"
          :class="{ 'is-active': alwaysOnTop }"
          @click="toggleAlwaysOnTop"
        >
          <span class="mini-player__icon-mask mini-player__icon-mask--pin"></span>
        </div>
        <bubbleBox
          :dom="pinRef || undefined"
          :title="alwaysOnTop ? t('player.miniWindowUnpin') : t('player.miniWindowPin')"
        />
        <div ref="closeRef" class="mini-player__icon canNotDrag" @click="restoreMainWindow">
          <span class="mini-player__icon-mask mini-player__icon-mask--close"></span>
        </div>
        <bubbleBox :dom="closeRef || undefined" :title="t('player.miniWindowRestore')" />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mini-player {
  --mini-player-inset: 5px;
  --task-progress-start: #3a7afe;
  --task-progress-end: #4da3ff;
  --task-progress-stripe-strong: rgba(255, 255, 255, 0.12);
  --task-progress-stripe-soft: rgba(255, 255, 255, 0.04);
  --task-progress-shine: rgba(255, 255, 255, 0.25);
  --task-progress-track: rgba(58, 122, 254, 0.28);
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}

:global(.theme-light) .mini-player {
  --task-progress-start: #2b66d9;
  --task-progress-end: #4b88ff;
  --task-progress-stripe-strong: rgba(255, 255, 255, 0.18);
  --task-progress-stripe-soft: rgba(255, 255, 255, 0.08);
  --task-progress-shine: rgba(255, 255, 255, 0.32);
  --task-progress-track: rgba(43, 102, 217, 0.22);
}

.mini-player__task-progress {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 20;
  pointer-events: none;
  overflow: hidden;
  background: var(--task-progress-track);
}

.mini-player__task-progress-bar {
  position: relative;
  height: 100%;
  background: linear-gradient(90deg, var(--task-progress-start), var(--task-progress-end));
  background-size: 200% 100%;
  animation: mini-player-task-slide-bg 3s linear infinite;
  overflow: hidden;
  will-change: background-position, width;
  transition: width 0.2s ease;
}

.mini-player__task-progress-bar::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(
    45deg,
    var(--task-progress-stripe-strong) 0 8px,
    var(--task-progress-stripe-soft) 8px 16px
  );
  mix-blend-mode: overlay;
  animation: mini-player-task-move-stripes 2s linear infinite;
  will-change: background-position;
}

.mini-player__task-progress-bar::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    var(--task-progress-shine) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  transform: translateX(-100%);
  animation: mini-player-task-shine 3.6s ease-in-out infinite;
  will-change: transform;
}

@keyframes mini-player-task-slide-bg {
  0% {
    background-position: 0 0;
  }

  100% {
    background-position: -200% 0;
  }
}

@keyframes mini-player-task-move-stripes {
  0% {
    background-position: 0 0;
  }

  100% {
    background-position: 100px 0;
  }
}

@keyframes mini-player-task-shine {
  0% {
    transform: translateX(-100%);
  }

  50% {
    transform: translateX(0);
  }

  100% {
    transform: translateX(100%);
  }
}

.mini-player__bar {
  display: flex;
  align-items: center;
  flex: 0 0 62px;
  height: 62px;
  padding: var(--mini-player-inset) 8px var(--mini-player-inset) var(--mini-player-inset);
  box-sizing: border-box;
  position: relative;
}

.mini-player__focus-source {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
  opacity: 0;
  transition: opacity 220ms ease;
}

.mini-player.is-window-focused .mini-player__focus-source {
  opacity: 1;
}

.mini-player__cover {
  flex: 0 0 52px;
  width: 52px;
  height: 52px;
  overflow: hidden;
}

.mini-player__controls {
  width: 280px;
  flex: 0 0 280px;
}

.mini-player__waveform {
  flex: 1 1 auto;
  min-width: 0;
  height: 52px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 0 var(--mini-player-inset);
  box-sizing: border-box;
  position: relative;
}

.mini-player__waveform :deep(.player-structure-rail) {
  border-radius: 2px;
}

.mini-player__waveform :deep(.player-structure-rail--empty) {
  display: none;
}

#waveform {
  position: relative;
  flex: 0 0 40px;
  width: 100%;
  height: 40px;
  min-height: 40px;
  background: var(--waveform-bg);
  overflow: hidden;
}

#waveform:focus {
  outline: none;
}

#time,
#duration {
  position: absolute;
  z-index: 11;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  background: rgba(0, 0, 0, 0.75);
  padding: 2px;
  color: #ddd;
}

#time {
  left: 0;
}

#duration {
  right: 0;
}

.mini-player__side {
  --mini-player-side-gap: 4px;
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--mini-player-side-gap);
  padding-left: 4px;
}

.mini-player__icon {
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }

  &.is-active {
    color: var(--accent);
  }
}

.mini-player__icon-mask {
  width: 18px;
  height: 18px;
  display: block;
  background: currentColor;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}

.mini-player__icon--pin {
  // 图钉 SVG 的实际轮廓较窄，向右校正以平衡三项的可见间距。
  transform: translateX(2px);
}

.mini-player__icon-mask--pin {
  -webkit-mask-image: url('./assets/miniPlayerPin.svg');
  mask-image: url('./assets/miniPlayerPin.svg');
}

.mini-player__icon-mask--close {
  -webkit-mask-image: url('./assets/miniPlayerClose.svg');
  mask-image: url('./assets/miniPlayerClose.svg');
}

.mini-player__controls :deep(.buttonIcon),
.mini-player__side :deep(.bpm-tap),
.mini-player__side :deep(.windowVolumeDial) {
  -webkit-app-region: no-drag;
}
</style>
