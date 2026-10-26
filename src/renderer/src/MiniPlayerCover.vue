<script setup lang="ts">
import { sameRendererFilePath } from '@renderer/utils/filePathComparison'

import {
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  type ComponentPublicInstance
} from 'vue'
import { MINI_PLAYER_CHANNELS, type MiniPlayerCoverPopupPayload } from '@shared/miniPlayerWindow'
import logoAsset from '@renderer/assets/logo.png?asset'
import PlayerSongInfoCard from '@renderer/pages/modules/songPlayer/PlayerSongInfoCard.vue'
import {
  showSaveCoverContextMenu,
  type CoverSaveSnapshot
} from '@renderer/pages/modules/songPlayer/useCover'
import rightClickMenu from '@renderer/components/rightClickMenu'
import { t } from '@renderer/utils/translate'

const placeholderLogo = logoAsset
const payload = ref<MiniPlayerCoverPopupPayload | null>(null)
const coverUrl = ref('')
const coverFormat = ref('image/jpeg')
const cardRef = useTemplateRef<ComponentPublicInstance>('cardRef')
const isShowingContextMenu = ref(false)
let pointerInsideWindow = false
let resizeObserver: ResizeObserver | null = null

const reportSize = async () => {
  await nextTick()
  const el = cardRef.value?.$el
  if (!(el instanceof HTMLElement)) return
  const rect = el.getBoundingClientRect()
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.coverPopupContentSize, {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height)
  })
}

const observeCard = () => {
  resizeObserver?.disconnect()
  const el = cardRef.value?.$el
  if (!(el instanceof HTMLElement)) return
  resizeObserver = new ResizeObserver(() => {
    void reportSize()
  })
  resizeObserver.observe(el)
}

const disposeCoverUrl = () => {
  if (coverUrl.value && coverUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(coverUrl.value)
  }
  coverUrl.value = ''
}

const toUint8Array = (raw: unknown): Uint8Array | null => {
  if (!raw) return null
  if (raw instanceof Uint8Array) return raw
  if (Array.isArray(raw)) return new Uint8Array(raw as number[])
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
    return new Uint8Array((raw as { data: number[] }).data)
  }
  return null
}

const resolveCoverFormat = (thumb: { format?: unknown; dataUrl?: unknown }) => {
  const format = String(thumb.format || '')
  if (format) return format
  const dataUrl = String(thumb.dataUrl || '')
  if (dataUrl.startsWith('data:image/png')) return 'image/png'
  return 'image/jpeg'
}

const loadCover = async (next: MiniPlayerCoverPopupPayload) => {
  const filePath = next.filePath
  const trySize = async (size: number) => {
    const thumb = await window.electron.ipcRenderer.invoke(
      'getSongCoverThumb',
      filePath,
      size,
      next.rootDir || ''
    )
    if (!thumb || !sameRendererFilePath(payload.value?.filePath, filePath)) return false
    if (thumb.data) {
      const bytes = toUint8Array(thumb.data)
      if (bytes && bytes.length > 0) {
        disposeCoverUrl()
        const cloned = bytes.slice()
        const format = resolveCoverFormat(thumb)
        const blob = new Blob([cloned], { type: format || 'image/jpeg' })
        coverFormat.value = format
        coverUrl.value = URL.createObjectURL(blob)
        return true
      }
    }
    if (typeof thumb.dataUrl === 'string' && thumb.dataUrl) {
      disposeCoverUrl()
      coverFormat.value = resolveCoverFormat(thumb)
      coverUrl.value = thumb.dataUrl
      return true
    }
    return false
  }
  if (await trySize(512)) return
  if (await trySize(256)) return
  if (sameRendererFilePath(payload.value?.filePath, filePath)) disposeCoverUrl()
}

const handleState = (_event: unknown, next: MiniPlayerCoverPopupPayload) => {
  const sameFile = sameRendererFilePath(payload.value?.filePath, next.filePath)
  payload.value = next
  if (!sameFile || !coverUrl.value) void loadCover(next)
  void reportSize()
}

const sendPointer = (inside: boolean) => {
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.coverPopupPointer, { inside })
}

const setPointerInsideWindow = (inside: boolean) => {
  pointerInsideWindow = inside
  if (!inside && isShowingContextMenu.value) return
  sendPointer(inside)
}

const focusPopup = () => {
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.focusCoverPopup)
}

const buildCoverSnapshot = (): CoverSaveSnapshot | null => {
  if (!coverUrl.value) return null
  return {
    blobUrl: coverUrl.value,
    songTitle: payload.value?.title || t('tracks.unknownTrack'),
    artist: payload.value?.artist || t('tracks.unknownArtist'),
    format: coverFormat.value
  }
}

const runWhileMenuOpen = (task: () => Promise<void>) => {
  focusPopup()
  isShowingContextMenu.value = true
  sendPointer(true)
  window.setTimeout(() => {
    void task().finally(() => {
      isShowingContextMenu.value = false
      if (!pointerInsideWindow) sendPointer(false)
    })
  }, 0)
}

const showCoverContextMenu = (event: MouseEvent) => {
  const snapshot = buildCoverSnapshot()
  if (!snapshot) return
  runWhileMenuOpen(() => showSaveCoverContextMenu(event, snapshot))
}

const writeClipboardText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

const showTextCopyMenu = (event: MouseEvent, text: string) => {
  const selected = window.getSelection()?.toString() || ''
  const value = selected || text
  if (!value) return
  void runWhileMenuOpen(async () => {
    const result = await rightClickMenu({
      menuArr: [[{ menuName: 'common.copy', shortcutKey: '' }]],
      clickEvent: event
    })
    if (result !== 'cancel' && result.menuName === 'common.copy') {
      await writeClipboardText(value)
    }
  })
}

const handleWindowPointerEnter = () => {
  setPointerInsideWindow(true)
}

const handleWindowPointerLeave = () => {
  setPointerInsideWindow(false)
}

onMounted(async () => {
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.coverPopupState, handleState)
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.coverPopupReady)
  document.documentElement.addEventListener('mouseenter', handleWindowPointerEnter)
  document.documentElement.addEventListener('mouseleave', handleWindowPointerLeave)
  await nextTick()
  observeCard()
  void reportSize()
})

onUnmounted(() => {
  sendPointer(false)
  resizeObserver?.disconnect()
  resizeObserver = null
  document.documentElement.removeEventListener('mouseenter', handleWindowPointerEnter)
  document.documentElement.removeEventListener('mouseleave', handleWindowPointerLeave)
  window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.coverPopupState, handleState)
  disposeCoverUrl()
})
</script>

<template>
  <PlayerSongInfoCard
    ref="cardRef"
    :cover-url="coverUrl"
    :placeholder-src="placeholderLogo"
    :title-text="payload?.title || ''"
    :artist-text="payload?.artist || ''"
    :album-text="payload?.album || ''"
    :label-text="payload?.label || ''"
    @pointerdown="focusPopup"
    @mouseenter="setPointerInsideWindow(true)"
    @cover-contextmenu="showCoverContextMenu"
    @text-contextmenu="showTextCopyMenu"
  />
</template>

<style scoped lang="scss">
:deep(.songInfo) {
  border-radius: 8px;
  overflow: hidden;
}
</style>
