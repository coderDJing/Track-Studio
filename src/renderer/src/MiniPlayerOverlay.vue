<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, type CSSProperties } from 'vue'
import hotkeys from 'hotkeys-js'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import confirmDialog from '@renderer/components/confirmDialog.vue'
import exportDialog from '@renderer/components/exportDialog.vue'
import MiniPlayerMoreMenu from '@renderer/composables/miniPlayer/MiniPlayerMoreMenu.vue'
import {
  MINI_PLAYER_CHANNELS,
  type MiniPlayerOverlayConfirmPayload,
  type MiniPlayerOverlayExportPayload,
  type MiniPlayerOverlayMenuAction,
  type MiniPlayerOverlayMenuPayload,
  type MiniPlayerOverlayResult,
  type MiniPlayerOverlaySongListPayload,
  type MiniPlayerOverlayState
} from '@shared/miniPlayerWindow'

const rootRef = ref<HTMLElement | null>(null)
const state = ref<MiniPlayerOverlayState | null>(null)
let resizeObserver: ResizeObserver | null = null

const kind = computed(() => state.value?.kind || null)
const menuPayload = computed(() =>
  state.value?.kind === 'menu' ? (state.value.payload as MiniPlayerOverlayMenuPayload) : null
)
const songListPayload = computed(() =>
  state.value?.kind === 'song-list'
    ? (state.value.payload as MiniPlayerOverlaySongListPayload)
    : null
)
const confirmPayload = computed(() =>
  state.value?.kind === 'confirm' ? (state.value.payload as MiniPlayerOverlayConfirmPayload) : null
)
const exportPayload = computed(() =>
  state.value?.kind === 'export' ? (state.value.payload as MiniPlayerOverlayExportPayload) : null
)
const songListHeightPx = computed(() =>
  kind.value === 'song-list' ? state.value?.songListHeightPx || 0 : 0
)
const overlayRootStyle = computed<CSSProperties | undefined>(() =>
  songListHeightPx.value > 0
    ? ({ '--overlay-song-list-height': `${songListHeightPx.value}px` } as CSSProperties)
    : undefined
)

const complete = async (result: MiniPlayerOverlayResult) => {
  const requestId = state.value?.requestId
  if (!requestId) return
  await window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.overlayComplete, {
    requestId,
    result
  })
}

const resolveMeasureEl = () => {
  const root = rootRef.value
  if (!root) return null
  const inner = root.querySelector('.inner')
  if (inner instanceof HTMLElement) return inner
  const first = root.firstElementChild
  return first instanceof HTMLElement ? first : null
}

const reportContentSize = async () => {
  await nextTick()
  const el = resolveMeasureEl()
  if (!el) return
  const rect = el.getBoundingClientRect()
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.overlayContentSize, {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height)
  })
}

const observeContent = () => {
  resizeObserver?.disconnect()
  const el = resolveMeasureEl()
  if (!el) return
  resizeObserver = new ResizeObserver(() => {
    void reportContentSize()
  })
  resizeObserver.observe(el)
}

const handleMenuAction = (action: MiniPlayerOverlayMenuAction) => {
  void complete({ type: 'menu', action })
}

const handleMenuHotkeyQ = (event: KeyboardEvent) => {
  event.preventDefault()
  if (kind.value !== 'menu' || !menuPayload.value) return
  handleMenuAction(menuPayload.value.isReadOnly ? 'copyToFilter' : 'moveToFilter')
}

const handleMenuHotkeyE = (event: KeyboardEvent) => {
  event.preventDefault()
  if (kind.value !== 'menu' || !menuPayload.value) return
  handleMenuAction(menuPayload.value.isReadOnly ? 'copyToCurated' : 'moveToCurated')
}

const handleState = (_event: unknown, next: MiniPlayerOverlayState | null) => {
  if (!next?.kind) {
    state.value = null
    resizeObserver?.disconnect()
    resizeObserver = null
    return
  }
  state.value = next
  void nextTick().then(() => {
    observeContent()
    void reportContentSize()
  })
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  void complete({ type: 'dismiss' })
}

onMounted(() => {
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.overlayState, handleState)
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.overlayReady)
  window.addEventListener('keydown', handleKeydown)
  hotkeys('q', 'windowGlobal', handleMenuHotkeyQ)
  hotkeys('e', 'windowGlobal', handleMenuHotkeyE)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('keydown', handleKeydown)
  hotkeys.unbind('q', 'windowGlobal')
  hotkeys.unbind('e', 'windowGlobal')
  window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.overlayState, handleState)
})
</script>

<template>
  <div ref="rootRef" class="mini-player-overlay-root" :style="overlayRootStyle">
    <MiniPlayerMoreMenu
      v-if="kind === 'menu' && menuPayload"
      :is-read-only="menuPayload.isReadOnly"
      :can-delete-all-above="menuPayload.canDeleteAllAbove"
      @action="handleMenuAction"
    />
    <selectSongListDialog
      v-else-if="kind === 'song-list' && songListPayload"
      :library-name="songListPayload.libraryName"
      :action-mode="songListPayload.actionMode"
      @confirm="(uuid: string) => complete({ type: 'song-list', uuid })"
      @cancel="complete({ type: 'dismiss' })"
    />
    <confirmDialog
      v-else-if="kind === 'confirm' && confirmPayload"
      :title="confirmPayload.title"
      :content="confirmPayload.content"
      :confirm-show="confirmPayload.confirmShow !== false"
      :inner-height="confirmPayload.innerHeight || 220"
      :inner-width="confirmPayload.innerWidth || 400"
      :confirm-callback="() => complete({ type: 'confirm', ok: true })"
      :cancel-callback="() => complete({ type: 'confirm', ok: false })"
    />
    <exportDialog
      v-else-if="kind === 'export' && exportPayload"
      :title="exportPayload.title"
      :force-copy-only="exportPayload.forceCopyOnly"
      :confirm-callback="
        (data: { folderPathVal: string; deleteSongsAfterExport: boolean }) =>
          complete({
            type: 'export',
            folderPath: data.folderPathVal,
            deleteAfter: data.deleteSongsAfterExport
          })
      "
      :cancel-callback="() => complete({ type: 'dismiss' })"
    />
  </div>
</template>

<style lang="scss" scoped>
.mini-player-overlay-root {
  width: max-content;
  height: max-content;
  overflow: hidden;
  border-radius: 8px;
  background: transparent;
}

:global(.mini-player-overlay-root .dialog) {
  --dialog-available-height: 100vh;
  position: static;
  padding: 0;
  width: max-content;
  height: max-content;
  display: block;
  background-color: transparent;
  opacity: 1;
  pointer-events: auto;
  overflow: visible;
  transition: none;
}

:global(.mini-player-overlay-root .dialog .inner) {
  // This window fits the measured dialog exactly, so viewport gutters would
  // feed back into each resize and progressively shrink the popup.
  max-width: 100vw !important;
  transform: none;
  opacity: 1;
  box-shadow: none;
  transition: none;
  border-radius: 8px;
  overflow: hidden;
}

:global(.mini-player-overlay-root .content.inner) {
  width: 300px;
  height: var(--overlay-song-list-height, 70vh) !important;
  max-height: var(--overlay-song-list-height, 70vh) !important;
}
</style>
