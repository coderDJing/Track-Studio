<script setup lang="ts">
import previousSongAsset from '@renderer/assets/previousSong.svg?asset'
import fastBackwardAsset from '@renderer/assets/fastBackward.svg?asset'
import playAsset from '@renderer/assets/play.svg?asset'
import pauseAsset from '@renderer/assets/pause.svg?asset'
import fastForwardAsset from '@renderer/assets/fastForward.svg?asset'
import nextSongAsset from '@renderer/assets/nextSong.svg?asset'
import moreAsset from '@renderer/assets/more.svg?asset'
import { ref, onUnmounted, watch, useTemplateRef, onMounted, computed } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import shortcutIconAsset from '@renderer/assets/shortcutIcon.svg?asset'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import type { LibraryTransferActionMode } from '@renderer/utils/libraryTransfer'
import {
  buildNeteaseSearchQuery,
  normalizeNeteaseSearchText,
  openNeteaseSearch
} from '@renderer/utils/neteaseSearch'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import { hasEffectiveAcoustIdKey } from '@renderer/utils/acoustid'
import { openRekordboxDesktopPlaylistForSelectedTracks } from '@renderer/utils/rekordboxDesktopPlaylist'
import { openRekordboxXmlExportForSelectedTracks } from '@renderer/utils/rekordboxXmlExport'
import { startAudioConvertFromFiles } from '@renderer/utils/audioConvertActions'
import { promptAndStartTrackReanalysis } from '@renderer/utils/trackReanalysis'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import { resolvePlaybackDeleteAllAboveTarget } from '@shared/playbackDeleteAllAbove'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'
import {
  type ISongInfo,
  type IMetadataAutoFillSummary,
  type IMetadataAutoFillItemResult
} from '../../../types/globals'
const previousSong = previousSongAsset
const fastBackward = fastBackwardAsset
const play = playAsset
const pause = pauseAsset
const fastForward = fastForwardAsset
const nextSong = nextSongAsset
const more = moreAsset
const shortcutIcon = shortcutIconAsset
const uuid = uuidV4()
const runtime = useRuntimeStore()
const props = withDefaults(
  defineProps<{
    variant?: 'main' | 'mini'
    hidePlaybackControls?: boolean
    playing?: boolean
  }>(),
  {
    variant: 'main',
    hidePlaybackControls: false,
    playing: false
  }
)
const isReadOnlyPlaybackSource = computed(() =>
  isRekordboxExternalPlaybackSource(
    runtime.playingData.playingSongListUUID,
    runtime.playingData.playingSong
  )
)
const isPlaying = computed(() => props.playing === true)
watch(
  () => runtime.activeMenuUUID,
  (val) => {
    if (val !== uuid) {
      moreMenuShow.value = false
    }
  }
)
const emits = defineEmits([
  'pause',
  'play',
  'fastForward',
  'fastBackward',
  'nextSong',
  'previousSong',
  'delSong',
  'delAllAbove',
  'moveToLikeLibrary',
  'moveToListLibrary',
  'moveToSetLibrary',
  'moveToMixtapeLibrary',
  'exportTrack',
  'toggleMiniWindow',
  'toggleMiniMoreMenu'
])

const handlePause = () => {
  emits('pause')
}

const handlePlay = () => {
  emits('play')
}

let fastForwardInterval: NodeJS.Timeout
const handleFastForwardMouseup = () => {
  clearInterval(fastForwardInterval)
  document.removeEventListener('mouseup', handleFastForwardMouseup)
}
const handleFastForward = () => {
  emits('fastForward')
  fastForwardInterval = setInterval(() => {
    emits('fastForward')
  }, 200)
  document.addEventListener('mouseup', handleFastForwardMouseup)
}

let fastBackwardInterval: NodeJS.Timeout
const handleFastBackwardMouseup = () => {
  clearInterval(fastBackwardInterval)
  document.removeEventListener('mouseup', handleFastBackwardMouseup)
}
const handleFastBackward = () => {
  emits('fastBackward')
  fastBackwardInterval = setInterval(() => {
    emits('fastBackward')
  }, 200)
  document.addEventListener('mouseup', handleFastBackwardMouseup)
}

const handleNextSong = () => {
  emits('nextSong')
}

const handlePreviousSong = () => {
  emits('previousSong')
}

onUnmounted(() => {
  clearInterval(fastForwardInterval)
  clearInterval(fastBackwardInterval)
  document.removeEventListener('mouseup', handleFastForwardMouseup)
  document.removeEventListener('mouseup', handleFastBackwardMouseup)
})

const moreMenuShow = ref(false)
const handelMoreClick = () => {
  if (moreMenuShow.value) {
    runtime.activeMenuUUID = ''
    moreMenuShow.value = false
    return
  }
  runtime.activeMenuUUID = uuid
  moreMenuShow.value = true
}

const previousSongRef = useTemplateRef('previousSongRef')
const fastBackwardRef = useTemplateRef('fastBackwardRef')
const playRef = useTemplateRef('playRef')
const pauseRef = useTemplateRef('pauseRef')
const fastForwardRef = useTemplateRef('fastForwardRef')
const nextSongRef = useTemplateRef('nextSongRef')
const miniWindowRef = useTemplateRef('miniWindowRef')

const handleMoreButtonClick = () => {
  if (props.variant === 'mini') {
    emits('toggleMiniMoreMenu')
    return
  }
  handelMoreClick()
}

const delSong = () => {
  emits('delSong')
}

const moveToLikeLibrary = (actionMode: LibraryTransferActionMode = 'move') => {
  emits('moveToLikeLibrary', runtime.playingData.playingSong, actionMode)
}

const moveToListLibrary = (actionMode: LibraryTransferActionMode = 'move') => {
  emits('moveToListLibrary', runtime.playingData.playingSong, actionMode)
}
const copyToLikeLibrary = () => {
  moveToLikeLibrary('copy')
}
const copyToListLibrary = () => {
  moveToListLibrary('copy')
}
const moveToSetLibrary = () => {
  emits('moveToSetLibrary', runtime.playingData.playingSong)
}
const moveToMixtapeLibrary = () => {
  emits('moveToMixtapeLibrary', runtime.playingData.playingSong)
}
const exportTrack = () => {
  emits('exportTrack')
}
const showInFileExplorer = () => {
  window.electron.ipcRenderer.send('show-item-in-folder', runtime.playingData.playingSong?.filePath)
  closeMoreMenu()
}

const closeMoreMenu = () => {
  runtime.activeMenuUUID = ''
  moreMenuShow.value = false
}

const delAllAbove = () => {
  closeMoreMenu()
  emits('delAllAbove')
}

const normalizeFilePathForCompare = (filePath?: string | null) =>
  normalizeFilePathForComparison(
    filePath,
    isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
  )

const resolvePlaybackSourceSongListPath = (listUuid = runtime.playingData.playingSongListUUID) => {
  return listUuid ? String(libraryUtils.findDirPathByUuid(listUuid) || '') : ''
}

const syncRemovedPlaybackSourcePaths = (removedPaths: string[], sourceListUuid: string) => {
  const normalizedRemovedPaths = new Set(
    removedPaths.map((item) => normalizeFilePathForCompare(item)).filter(Boolean)
  )
  if (normalizedRemovedPaths.size === 0) return

  if (!sourceListUuid || runtime.playingData.playingSongListUUID === sourceListUuid) {
    runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.filter(
      (item) => !normalizedRemovedPaths.has(normalizeFilePathForCompare(item.filePath))
    )
    if (
      runtime.playingData.playingSong &&
      normalizedRemovedPaths.has(
        normalizeFilePathForCompare(runtime.playingData.playingSong.filePath)
      )
    ) {
      runtime.playingData.playingSong = null
    }
  }

  if (!sourceListUuid) return
  try {
    emitter.emit('songsRemoved', {
      listUUID: sourceListUuid,
      paths: removedPaths
    })
    emitter.emit('playlistContentChanged', { uuids: [sourceListUuid] })
  } catch {}
}

const syncRemovedPlaybackSourceItemIds = (removedItemIds: string[], sourceListUuid: string) => {
  const idSet = new Set(removedItemIds.filter(Boolean))
  if (idSet.size === 0) return

  if (!sourceListUuid || runtime.playingData.playingSongListUUID === sourceListUuid) {
    runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.filter(
      (item) => !idSet.has(item.setItemId || item.mixtapeItemId || '')
    )
    if (
      runtime.playingData.playingSong &&
      idSet.has(
        runtime.playingData.playingSong.setItemId ||
          runtime.playingData.playingSong.mixtapeItemId ||
          ''
      )
    ) {
      runtime.playingData.playingSong = null
    }
  }

  if (!sourceListUuid) return
  try {
    emitter.emit('songsRemoved', {
      listUUID: sourceListUuid,
      itemIds: removedItemIds
    })
    emitter.emit('playlistContentChanged', { uuids: [sourceListUuid] })
  } catch {}
}

const handleAnalyzeCurrentSongFingerprint = async () => {
  const filePath = runtime.playingData.playingSong?.filePath
  if (!filePath) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('fingerprints.noPlayingTrack')],
      confirmShow: false
    })
    return
  }
  closeMoreMenu()
  await analyzeFingerprintsForPaths([filePath], { origin: 'player' })
}

const showNeteaseSearchEmptyHint = async (messageKey: string) => {
  await confirm({
    title: t('dialog.hint'),
    content: [t(messageKey)],
    confirmShow: false
  })
}

const openSongNeteaseSearch = async (query: string) => {
  if (!openNeteaseSearch(query)) {
    await showNeteaseSearchEmptyHint('tracks.neteaseSearchEmpty')
  }
}

const handleNeteaseSearchTitleArtist = async () => {
  const song = runtime.playingData.playingSong
  if (!song) return
  const title = normalizeNeteaseSearchText(song.title)
  const artist = normalizeNeteaseSearchText(song.artist)
  if (!title && !artist) {
    await showNeteaseSearchEmptyHint('tracks.neteaseSearchTitleArtistEmpty')
    return
  }
  await openSongNeteaseSearch(buildNeteaseSearchQuery(title, artist))
  closeMoreMenu()
}

const handleNeteaseSearchTitle = async () => {
  const song = runtime.playingData.playingSong
  if (!song) return
  const title = normalizeNeteaseSearchText(song.title)
  if (!title) {
    await showNeteaseSearchEmptyHint('tracks.neteaseSearchTitleEmpty')
    return
  }
  await openSongNeteaseSearch(title)
  closeMoreMenu()
}

const handleNeteaseSearchArtist = async () => {
  const song = runtime.playingData.playingSong
  if (!song) return
  const artist = normalizeNeteaseSearchText(song.artist)
  if (!artist) {
    await showNeteaseSearchEmptyHint('tracks.neteaseSearchArtistEmpty')
    return
  }
  await openSongNeteaseSearch(artist)
  closeMoreMenu()
}

const handleNeteaseSearchAlbum = async () => {
  const song = runtime.playingData.playingSong
  if (!song) return
  const album = normalizeNeteaseSearchText(song.album)
  if (!album) {
    await showNeteaseSearchEmptyHint('tracks.neteaseSearchAlbumEmpty')
    return
  }
  await openSongNeteaseSearch(album)
  closeMoreMenu()
}

const handleSimilarTracks = async () => {
  const song = runtime.playingData.playingSong
  if (!song) return
  const { default: openBatchSimilarTracksDialog } =
    await import('@renderer/components/batchSimilarTracksDialog')
  await openBatchSimilarTracksDialog([song])
  closeMoreMenu()
}

const handleAutoFillMetadata = async () => {
  const filePath = runtime.playingData.playingSong?.filePath
  if (!filePath) return
  closeMoreMenu()
  if (!(await hasEffectiveAcoustIdKey(runtime.setting))) {
    await confirm({
      title: t('metadata.autoFillFingerprintHintTitle'),
      content: [
        t('metadata.autoFillFingerprintHintMissing'),
        t('metadata.autoFillFingerprintHintGuide')
      ],
      confirmShow: false
    })
  }
  runtime.isProgressing = true
  let summary: IMetadataAutoFillSummary | null = null
  let hadError = false
  try {
    summary = await invokeMetadataAutoFill([filePath])
  } catch (error: unknown) {
    hadError = true
    await confirm({
      title: t('common.error'),
      content: [error instanceof Error ? error.message : String(error || t('common.unknownError'))],
      confirmShow: false
    })
  } finally {
    runtime.isProgressing = false
  }
  if (!summary) {
    if (!hadError) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('metadata.autoFillNoEligible')],
        confirmShow: false
      })
    }
    return
  }
  const { default: openAutoSummary } =
    await import('@renderer/components/autoMetadataSummaryDialog')
  await openAutoSummary(summary)
  applyMetadataChangesToPlayingSong(summary.items)
}

const applyMetadataUpdateToPlayingSong = (updatedSong: ISongInfo, oldFilePath?: string) => {
  const current = runtime.playingData.playingSong
  if (!current) return
  if (current.filePath !== updatedSong.filePath && current.filePath !== (oldFilePath ?? '')) return
  runtime.playingData.playingSong = { ...current, ...updatedSong }
  runtime.playingData.playingSong.filePath = updatedSong.filePath
  runtime.playingData.playingSongListData = runtime.playingData.playingSongListData.map((item) =>
    item.filePath === (oldFilePath ?? updatedSong.filePath) ||
    item.filePath === updatedSong.filePath
      ? { ...item, ...updatedSong }
      : item
  )
}

const emitMetadataUpdates = (updates: Array<{ song: ISongInfo; oldFilePath?: string }>) => {
  if (!updates.length) return
  for (const update of updates) {
    applyMetadataUpdateToPlayingSong(update.song, update.oldFilePath)
  }
  try {
    emitter.emit('metadataBatchUpdated', { updates })
  } catch {}
}

const applyMetadataChangesToPlayingSong = (items?: IMetadataAutoFillItemResult[]) => {
  if (!items?.length) return
  const updates: Array<{ song: ISongInfo; oldFilePath?: string }> = []
  for (const item of items) {
    if (item.status === 'applied' && item.updatedSongInfo) {
      updates.push({
        song: item.updatedSongInfo,
        oldFilePath: item.oldFilePath
      })
    }
  }
  emitMetadataUpdates(updates)
}

const handleEditMetadata = async () => {
  const filePath = runtime.playingData.playingSong?.filePath
  if (!filePath) return
  closeMoreMenu()
  const { default: openEditMetadataDialog } =
    await import('@renderer/components/editMetadataDialog')
  const result = await openEditMetadataDialog({ filePath })
  if (result && result !== 'cancel') {
    emitMetadataUpdates([
      {
        song: result.updatedSongInfo,
        oldFilePath: result.oldFilePath
      }
    ])
  }
}

const handleConvertFormat = async () => {
  const filePath = runtime.playingData.playingSong?.filePath
  if (!filePath) return
  closeMoreMenu()
  try {
    await startAudioConvertFromFiles({
      files: [filePath],
      allowedSourceExts: runtime.setting.audioExt,
      songListUUID: runtime.playingData.playingSongListUUID
    })
  } catch {
    // 忽略错误，由主进程统一上报
  }
}

const handleStemSeparation = async () => {
  const song = runtime.playingData.playingSong
  if (!song?.filePath) return
  closeMoreMenu()
  const { default: openLibraryStemSeparationDialog } =
    await import('@renderer/components/libraryStemSeparationDialog')
  await openLibraryStemSeparationDialog({
    filePath: song.filePath,
    songTitle: song.title
  })
}

const handleClearTrackCache = async () => {
  const filePath = runtime.playingData.playingSong?.filePath
  if (!filePath) return
  closeMoreMenu()
  await promptAndStartTrackReanalysis(
    [filePath],
    runtime.playingData.playingSong ? [runtime.playingData.playingSong] : []
  )
}

const handleRekordboxDesktopPlaylist = async () => {
  const song = runtime.playingData.playingSong
  if (!song) return
  const sourceListUuid = runtime.playingData.playingSongListUUID
  if (runtime.isProgressing) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  closeMoreMenu()
  runtime.isProgressing = true
  try {
    const songListPath = resolvePlaybackSourceSongListPath(sourceListUuid)
    const summary = await openRekordboxDesktopPlaylistForSelectedTracks({
      tracks: [song],
      songListUUID: sourceListUuid,
      ...(songListPath ? { deletePayload: { songListPath } } : {})
    })
    if (summary?.removedSetItemIds?.length) {
      syncRemovedPlaybackSourceItemIds(summary.removedSetItemIds, sourceListUuid)
    } else if (summary?.removedSourceFilePaths?.length) {
      syncRemovedPlaybackSourcePaths(summary.removedSourceFilePaths, sourceListUuid)
    }
  } finally {
    runtime.isProgressing = false
  }
}

const resolvePlaybackSourceLibraryName = ():
  | 'FilterLibrary'
  | 'CuratedLibrary'
  | 'SetLibrary'
  | '' => {
  const listUuid = runtime.playingData.playingSongListUUID
  if (!listUuid) return ''
  const dirPath = String(libraryUtils.findDirPathByUuid(listUuid) || '').replace(/\\/g, '/')
  if (dirPath === 'library/FilterLibrary' || dirPath.startsWith('library/FilterLibrary/')) {
    return 'FilterLibrary'
  }
  if (dirPath === 'library/CuratedLibrary' || dirPath.startsWith('library/CuratedLibrary/')) {
    return 'CuratedLibrary'
  }
  if (dirPath === 'library/SetLibrary' || dirPath.startsWith('library/SetLibrary/')) {
    return 'SetLibrary'
  }
  return ''
}

const handleRekordboxXmlExport = async () => {
  const song = runtime.playingData.playingSong
  if (!song) return
  const sourceListUuid = runtime.playingData.playingSongListUUID
  if (runtime.isProgressing) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  const sourceLibraryName = resolvePlaybackSourceLibraryName()
  if (!sourceLibraryName) {
    await confirm({
      title: t('rekordboxXmlExport.failureTitle'),
      content: [t('rekordboxXmlExport.unsupportedSource')],
      confirmShow: false
    })
    return
  }
  closeMoreMenu()
  runtime.isProgressing = true
  try {
    const summary = await openRekordboxXmlExportForSelectedTracks({
      tracks: [song],
      sourceLibraryName,
      songListUUID: sourceListUuid
    })
    if (summary?.removedSetItemIds?.length) {
      syncRemovedPlaybackSourceItemIds(summary.removedSetItemIds, sourceListUuid)
    } else if (summary && summary.mode === 'move' && summary.sourceFilePaths.length > 0) {
      syncRemovedPlaybackSourcePaths(summary.sourceFilePaths, sourceListUuid)
    }
  } finally {
    runtime.isProgressing = false
  }
}

const neteaseSearchShow = ref(false)

const exportTrackLabel = computed(() =>
  isReadOnlyPlaybackSource.value ? t('tracks.exportTracksCopyOnly') : t('tracks.exportTracks')
)
const canDeleteAllAbove = computed(() => {
  if (isReadOnlyPlaybackSource.value) return false
  const listUuid = String(runtime.playingData.playingSongListUUID || '')
  return !!resolvePlaybackDeleteAllAboveTarget({
    listUuid,
    listData: runtime.playingData.playingSongListData,
    playingSong: runtime.playingData.playingSong,
    libraryType: libraryUtils.getLibraryTreeByUUID(listUuid)?.type,
    caseInsensitiveFilePath: isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
  })
})

// ---------------- 系统媒体会话（Media Session API）集成 ----------------
// 目标：启用系统的 上一首/下一首/播放/暂停 按钮，并同步元数据和播放状态
let artworkUrl: string = ''

const hasPrev = computed(() => {
  const list = runtime.playingData.playingSongListData
  const cur = runtime.playingData.playingSong?.filePath
  if (!cur) return false
  const idx = list.findIndex((i) => i.filePath === cur)
  return idx > 0
})

const hasNext = computed(() => {
  const list = runtime.playingData.playingSongListData
  const cur = runtime.playingData.playingSong?.filePath
  if (!cur) return false
  const idx = list.findIndex((i) => i.filePath === cur)
  return idx !== -1 && idx < list.length - 1
})

const revokeArtworkUrl = () => {
  if (artworkUrl) {
    try {
      URL.revokeObjectURL(artworkUrl)
    } catch (_) {
      /* ignore */
    }
    artworkUrl = ''
  }
}

const updateMediaSessionMetadata = () => {
  // 有些平台不支持 Media Session
  // @ts-ignore
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const song = runtime.playingData.playingSong
  // @ts-ignore
  const mediaSession = navigator.mediaSession as MediaSession

  revokeArtworkUrl()

  let artwork: Array<{ src: string; sizes?: string; type?: string }> | undefined
  try {
    if (song?.cover?.data && song?.cover?.format) {
      const blob = new Blob([Uint8Array.from(song.cover.data)], { type: song.cover.format })
      artworkUrl = URL.createObjectURL(blob)
      artwork = [
        {
          src: artworkUrl,
          sizes: '512x512',
          type: song.cover.format
        }
      ]
    }
  } catch (_) {
    // 忽略封面生成异常
  }

  // @ts-ignore
  mediaSession.metadata = new window.MediaMetadata({
    title: song?.title || t('tracks.unknownTrack'),
    artist: song?.artist || t('tracks.unknownArtist'),
    album: song?.album || '',
    artwork
  })
}

const updatePlaybackState = () => {
  // @ts-ignore
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  // @ts-ignore
  navigator.mediaSession.playbackState = isPlaying.value ? 'playing' : 'paused'
}

const updateActionHandlers = () => {
  // @ts-ignore
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  // @ts-ignore
  const ms = navigator.mediaSession as MediaSession

  ms.setActionHandler('play', () => {
    if (!isPlaying.value) emits('play')
  })
  ms.setActionHandler('pause', () => {
    if (isPlaying.value) emits('pause')
  })

  ms.setActionHandler('previoustrack', hasPrev.value ? () => emits('previousSong') : null)
  ms.setActionHandler('nexttrack', hasNext.value ? () => emits('nextSong') : null)
}

onMounted(() => {
  updateMediaSessionMetadata()
  updatePlaybackState()
  updateActionHandlers()
})

watch(
  () => runtime.playingData.playingSong,
  () => {
    updateMediaSessionMetadata()
    updateActionHandlers()
  }
)

watch([hasPrev, hasNext], () => {
  updateActionHandlers()
})

watch(isPlaying, () => {
  updatePlaybackState()
})

onUnmounted(() => {
  // @ts-ignore
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    // @ts-ignore
    const ms = navigator.mediaSession as MediaSession
    ms.setActionHandler('play', null)
    ms.setActionHandler('pause', null)
    ms.setActionHandler('previoustrack', null)
    ms.setActionHandler('nexttrack', null)
    // 清理元数据可选
    // @ts-ignore
    try {
      navigator.mediaSession.metadata = null
    } catch (_) {}
  }
  revokeArtworkUrl()
})
// ---------------- End 媒体会话集成 ----------------
</script>
<template>
  <div class="playerControlsRoot">
    <div class="playerControls unselectable">
      <template v-if="!props.hidePlaybackControls">
        <div ref="previousSongRef" class="buttonIcon" @click="handlePreviousSong()">
          <img :src="previousSong" draggable="false" />
        </div>
        <bubbleBox :dom="previousSongRef || undefined" :title="t('player.previous')" shortcut="W" />
        <div ref="fastBackwardRef" class="buttonIcon" @mousedown="handleFastBackward()">
          <img :src="fastBackward" draggable="false" />
        </div>
        <bubbleBox
          :dom="fastBackwardRef || undefined"
          :title="t('player.fastBackward')"
          shortcut="A"
        />
        <div v-show="!isPlaying" ref="playRef" class="buttonIcon" @click="handlePlay()">
          <img :src="play" draggable="false" />
        </div>
        <bubbleBox :dom="playRef || undefined" :title="t('player.play')" shortcut="Space" />
        <div v-show="isPlaying" ref="pauseRef" class="buttonIcon" @click="handlePause()">
          <img :src="pause" draggable="false" />
        </div>
        <bubbleBox :dom="pauseRef || undefined" :title="t('player.pause')" shortcut="Space" />
        <div ref="fastForwardRef" class="buttonIcon" @mousedown="handleFastForward()">
          <img :src="fastForward" draggable="false" />
        </div>
        <bubbleBox
          :dom="fastForwardRef || undefined"
          :title="t('player.fastForward')"
          shortcut="D"
        />
        <div ref="nextSongRef" class="buttonIcon" @click="handleNextSong()">
          <img :src="nextSong" draggable="false" />
        </div>
        <bubbleBox :dom="nextSongRef || undefined" :title="t('player.next')" shortcut="S" />
        <div class="buttonIcon" @click.stop="handleMoreButtonClick()">
          <img :src="more" draggable="false" />
        </div>
      </template>
      <template v-if="props.variant === 'main'">
        <div
          ref="miniWindowRef"
          class="buttonIcon miniWindowButton"
          @click.stop="emits('toggleMiniWindow')"
        >
          <span class="miniWindowIcon" aria-hidden="true"></span>
        </div>
        <bubbleBox :dom="miniWindowRef || undefined" :title="t('player.miniWindowOpen')" />
      </template>
    </div>
    <transition name="fade">
      <div v-if="moreMenuShow && !props.hidePlaybackControls" class="moreMenu unselectable">
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="exportTrack()">
            <span>{{ exportTrackLabel }}</span>
          </div>
        </div>
        <div
          v-if="!isReadOnlyPlaybackSource"
          style="padding: 5px 5px; border-bottom: 1px solid var(--border)"
        >
          <div class="menuButton" @click="handleRekordboxDesktopPlaylist()">
            <span>{{ t('rekordboxDesktop.menuCreatePlaylistFromSelectedTracks') }}</span>
          </div>
          <div class="menuButton" @click="handleRekordboxXmlExport()">
            <span>{{ t('rekordboxXmlExport.menuExportSelectedTracks') }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div v-if="!isReadOnlyPlaybackSource" class="menuButton" @click="moveToListLibrary()">
            <div>
              <span>{{ t('library.moveToFilter') }}</span>
            </div>
            <div class="shortcut" style="display: flex; align-items: center">
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>Q</span>
            </div>
          </div>
          <div v-if="!isReadOnlyPlaybackSource" class="menuButton" @click="moveToLikeLibrary()">
            <div>
              <span>{{ t('library.moveToCurated') }}</span>
            </div>
            <div class="shortcut" style="display: flex; align-items: center">
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>E</span>
            </div>
          </div>
          <div class="menuButton" @click="copyToListLibrary()">
            <div>
              <span>{{ t('library.copyToFilter') }}</span>
            </div>
            <div
              v-if="isReadOnlyPlaybackSource"
              class="shortcut"
              style="display: flex; align-items: center"
            >
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>Q</span>
            </div>
          </div>
          <div class="menuButton" @click="copyToLikeLibrary()">
            <div>
              <span>{{ t('library.copyToCurated') }}</span>
            </div>
            <div
              v-if="isReadOnlyPlaybackSource"
              class="shortcut"
              style="display: flex; align-items: center"
            >
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>E</span>
            </div>
          </div>
          <div class="menuButton" @click="moveToSetLibrary()">
            <span>{{ t('library.addToSet') }}</span>
          </div>
          <div v-if="isReadOnlyPlaybackSource" class="menuButton" @click="moveToMixtapeLibrary()">
            <span>{{ t('library.addToMixtapeByCopy') }}</span>
          </div>
        </div>
        <div
          v-if="!isReadOnlyPlaybackSource"
          style="padding: 5px 5px; border-bottom: 1px solid var(--border)"
        >
          <div class="menuButton" @click="delSong()">
            <div>
              <span>{{ t('tracks.deleteTracks') }} </span>
            </div>
            <div class="shortcut" style="display: flex; align-items: center">
              <img :src="shortcutIcon" style="margin-right: 5px" :draggable="false" /><span>F</span>
            </div>
          </div>
          <div v-if="canDeleteAllAbove" class="menuButton" @click="delAllAbove()">
            <span>{{ t('tracks.deleteAllAbove') }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="showInFileExplorer()">
            <span>{{ t('tracks.showInFileExplorer') }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div
            class="menuButton hasSubmenu"
            :class="{ submenuOpen: neteaseSearchShow }"
            @mouseenter="neteaseSearchShow = true"
            @mouseleave="neteaseSearchShow = false"
          >
            <span>{{ t('tracks.neteaseSearch') }}</span>
            <span style="margin-left: 8px; opacity: 0.6">▸</span>
            <div v-if="neteaseSearchShow" class="submenu">
              <div class="menuButton" @click.stop="handleNeteaseSearchTitleArtist()">
                <span>{{ t('tracks.neteaseSearchTitleArtist') }}</span>
              </div>
              <div class="menuButton" @click.stop="handleNeteaseSearchTitle()">
                <span>{{ t('tracks.neteaseSearchTitle') }}</span>
              </div>
              <div class="menuButton" @click.stop="handleNeteaseSearchArtist()">
                <span>{{ t('tracks.neteaseSearchArtist') }}</span>
              </div>
              <div class="menuButton" @click.stop="handleNeteaseSearchAlbum()">
                <span>{{ t('tracks.neteaseSearchAlbum') }}</span>
              </div>
            </div>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="handleSimilarTracks()">
            <span>{{ t('similarTracks.menu') }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="handleAutoFillMetadata()">
            <span>{{ t('metadata.autoFillMenu') }}</span>
          </div>
          <div class="menuButton" @click="handleEditMetadata()">
            <span>{{ t('tracks.editMetadata') }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="handleAnalyzeCurrentSongFingerprint()">
            <span>{{ t('fingerprints.analyzeAndAdd') }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px; border-bottom: 1px solid var(--border)">
          <div class="menuButton" @click="handleConvertFormat()">
            <span>{{ t('tracks.convertFormat') }}</span>
          </div>
        </div>
        <div style="padding: 5px 5px">
          <div class="menuButton" @click="handleClearTrackCache()">
            <span>{{ t('tracks.clearTrackCache') }}</span>
          </div>
          <div class="menuButton" @click="handleStemSeparation()">
            <span>{{ t('stemSeparation.menu') }}</span>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>
<style lang="scss" scoped>
.moreMenu {
  width: 280px;
  background-color: var(--bg-elev);
  position: absolute;
  border: 1px solid var(--border);
  border-radius: 3px;
  z-index: var(--z-popover);
  bottom: 58px;
  left: 250px;
  font-size: 14px;
  color: var(--text);

  .menuButton {
    display: flex;
    justify-content: space-between;
    padding: 5px 20px;
    border-radius: 5px;

    &:hover {
      background-color: var(--accent);
      color: #ffffff;
    }
  }

  /* 右侧快捷键容器：始终将内容贴右，字母固定宽度，避免不同字符宽度造成图标水平抖动 */
  .menuButton .shortcut {
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
  .menuButton .shortcut span {
    display: inline-block;
    width: 1.5ch; /* 约等于一个数字字符宽，足够容纳 Q/E/F 等 */
    text-align: center; /* 居中，保证不同字符的视觉中心一致 */
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  }

  .hasSubmenu {
    position: relative;

    &.submenuOpen {
      background-color: var(--accent);
      color: #ffffff;
    }
  }

  .submenu {
    position: absolute;
    left: 100%;
    bottom: 0;
    width: 200px;
    background-color: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 5px 5px;
    z-index: var(--z-popover);
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter,
.fade-leave-to {
  opacity: 0;
}

.playerControlsRoot {
  width: 100%;
}

.playerControls {
  display: flex;
  width: 100%;
  height: 44px;
  align-items: center;
  justify-content: space-between;

  .buttonIcon {
    height: 36px;
    width: 36px;
    display: flex;
    justify-content: center;
    align-items: center;

    &:hover {
      filter: contrast(120%) drop-shadow(0px 0px 6px var(--text));
    }
  }

  .miniWindowButton {
    color: #cccccc;
  }

  .miniWindowIcon {
    width: 18px;
    height: 18px;
    display: block;
    background: currentColor;
    -webkit-mask: url('../assets/miniPlayerPip.svg') center / contain no-repeat;
    mask: url('../assets/miniPlayerPip.svg') center / contain no-repeat;
  }
}

img {
  width: 18px;
  height: 18px;
}

/* 浅色主题下：去掉阴影，用纯黑作为 hover 高亮（适用于白色 PNG 图标） */
.theme-light .playerControls {
  .buttonIcon:hover {
    filter: none;
  }
  .buttonIcon img {
    filter: grayscale(1) brightness(0.58);
  }
  .buttonIcon:hover img {
    filter: grayscale(1) brightness(0);
  }
  .miniWindowIcon {
    background: #767676;
  }
  .miniWindowButton:hover .miniWindowIcon {
    background: #000000;
  }
}
</style>
