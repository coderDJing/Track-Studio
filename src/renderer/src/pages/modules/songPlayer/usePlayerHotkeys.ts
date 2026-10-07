import { onMounted, onUnmounted, Ref, ref } from 'vue'
import hotkeys, { KeyHandler } from 'hotkeys-js'
import type { SongsAreaPaneKey } from '@renderer/stores/runtime'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { isEditablePioneerUsbSong } from '@renderer/utils/pioneerUsbEditing'
import { resolveSeekPercentHotkeyRatio } from '@shared/playerSeekHotkeyRatio'
import type { ISongInfo } from '../../../../../types/globals'

// 使用 ReturnType 获取 useRuntimeStore 的返回类型，模拟 Store 类型
type RuntimeStoreType = ReturnType<typeof useRuntimeStore>

// 定义传递给 Composable 的参数类型
interface PlayerActions {
  play: () => void
  pause: () => void
  fastForward: () => void
  fastBackward: () => void
  nextSong: () => void
  previousSong: () => void
  delSong: () => void // 改回同步，因为 KeyHandler 不支持 async
  moveToListLibrary: () => void
  moveToLikeLibrary: () => void
  seekToPercent: (percent: number) => void
  volumeUp: () => void
  volumeDown: () => void
  // 可以添加一个 togglePlayPause 方法来简化 space 键处理
  togglePlayPause?: () => void
  togglePlaybackRange?: () => void
}

interface PlayerState {
  waveformShow: Ref<boolean>
  selectSongListDialogShow: Ref<boolean>
  confirmShow: Readonly<Ref<boolean>> // 从 runtime store 获取，设为只读
  songsAreaSelectedCount: Readonly<Ref<number>> // 从 runtime store 获取
  activeMenuUUID: { value: string } // 从 runtime store 获取，允许修改
  isPlaying?: Readonly<Ref<boolean>> // 可选：传入播放状态以优化 space 键
  hotkeysEnabled?: Readonly<Ref<boolean>>
}

type PreviewStatePayload = {
  filePath?: string
  active?: boolean
  song?: ISongInfo | null
  sourceLibraryName?: string
  sourceSongListUUID?: string
  sourcePane?: SongsAreaPaneKey | ''
}

type PreviewMoveRequestPayload = {
  song: ISongInfo
  sourceLibraryName: string
  sourceSongListUUID: string
  sourcePane: SongsAreaPaneKey | ''
  targetLibraryName: 'FilterLibrary' | 'CuratedLibrary'
}

export function usePlayerHotkeys(
  actions: PlayerActions,
  state: PlayerState,
  runtime: RuntimeStoreType // 传递 runtime store 实例
) {
  // 将 showDelConfirm 的管理移到内部，因为它是快捷键触发的副作用
  const internalShowDelConfirm = ref(false)
  const previewMoveTarget = ref<{
    filePath: string
    song: ISongInfo
    sourceLibraryName: string
    sourceSongListUUID: string
    sourcePane: SongsAreaPaneKey | ''
  } | null>(null)
  const isReadOnlyPlaybackSource = () =>
    isRekordboxExternalPlaybackSource(
      runtime.playingData.playingSongListUUID,
      runtime.playingData.playingSong
    )
  const clearPreviewMoveTarget = (filePath?: string) => {
    if (!filePath) {
      previewMoveTarget.value = null
      return
    }
    if (previewMoveTarget.value?.filePath === filePath) {
      previewMoveTarget.value = null
    }
  }
  const handleWaveformPreviewState = (payload?: PreviewStatePayload) => {
    const filePath = String(payload?.filePath || '').trim()
    if (!payload?.active) {
      clearPreviewMoveTarget(filePath)
      return
    }
    const song = payload?.song
    const sourceLibraryName = String(payload?.sourceLibraryName || '').trim()
    const sourceSongListUUID = String(payload?.sourceSongListUUID || '').trim()
    const sourcePane = payload?.sourcePane
    if (!song?.filePath || !sourceLibraryName || !sourceSongListUUID) {
      clearPreviewMoveTarget(filePath)
      return
    }
    previewMoveTarget.value = {
      filePath: String(song.filePath || '').trim(),
      song: { ...song },
      sourceLibraryName,
      sourceSongListUUID,
      sourcePane:
        sourcePane === 'single' || sourcePane === 'left' || sourcePane === 'right' ? sourcePane : ''
    }
  }
  const isPreviewMoveActive = () => previewMoveTarget.value !== null
  const isAnySelectSongListDialogVisible = () =>
    state.selectSongListDialogShow.value || runtime.selectSongListDialogShow
  const areHotkeysEnabled = () => state.hotkeysEnabled?.value !== false
  const emitPreviewMoveRequest = (targetLibraryName: 'FilterLibrary' | 'CuratedLibrary') => {
    const target = previewMoveTarget.value
    if (!target) return false
    const payload: PreviewMoveRequestPayload = {
      song: { ...target.song },
      sourceLibraryName: target.sourceLibraryName,
      sourceSongListUUID: target.sourceSongListUUID,
      sourcePane: target.sourcePane,
      targetLibraryName
    }
    emitter.emit('preview-transfer:open-dialog', payload)
    return true
  }

  const setupHotkeys = () => {
    const scope = 'windowGlobal' // 定义快捷键作用域

    const spaceHandler: KeyHandler = (event) => {
      event.preventDefault()
      if (!areHotkeysEnabled() || !state.waveformShow.value || isPreviewMoveActive()) {
        return
      }
      if (actions.togglePlayPause) {
        actions.togglePlayPause()
      } else if (state.isPlaying) {
        if (state.isPlaying.value) {
          actions.pause()
        } else {
          actions.play()
        }
      } else {
        // 降级处理：如果既没有 togglePlayPause 也没有 isPlaying
        // 这种方式可能不准确，因为 play/pause 内部可能有自己的逻辑
        actions.pause() // 尝试暂停
        actions.play() // 尝试播放
      }
    }
    hotkeys('space', scope, spaceHandler)

    hotkeys('d,right', scope, (event) => {
      event.preventDefault()
      if (!areHotkeysEnabled() || !state.waveformShow.value || isPreviewMoveActive()) {
        return
      }
      actions.fastForward()
    })

    // 移除对快进抑制状态的依赖（改由 playerReady 门槛控制）

    hotkeys('a,left', scope, (event) => {
      event.preventDefault()
      if (!areHotkeysEnabled() || !state.waveformShow.value || isPreviewMoveActive()) {
        return
      }
      actions.fastBackward()
    })

    hotkeys('s,down', scope, (event) => {
      event.preventDefault()
      if (
        !areHotkeysEnabled() ||
        !state.waveformShow.value ||
        isPreviewMoveActive() ||
        isAnySelectSongListDialogVisible()
      ) {
        return
      }
      actions.nextSong()
    })

    hotkeys('w,up', scope, (event) => {
      event.preventDefault()
      if (
        !areHotkeysEnabled() ||
        !state.waveformShow.value ||
        isPreviewMoveActive() ||
        isAnySelectSongListDialogVisible()
      ) {
        return
      }
      actions.previousSong()
    })

    hotkeys('r', scope, (event) => {
      if (!areHotkeysEnabled() || runtime.mainWindowBrowseMode !== 'browser') return
      event.preventDefault()
      if (
        !state.waveformShow.value ||
        isPreviewMoveActive() ||
        isAnySelectSongListDialogVisible()
      ) {
        return
      }
      if (actions.togglePlaybackRange) {
        actions.togglePlaybackRange()
        return
      }
      runtime.setting.enablePlaybackRange = !runtime.setting.enablePlaybackRange
      window.electron.ipcRenderer.invoke('setSetting', JSON.parse(JSON.stringify(runtime.setting)))
    })

    const deleteHandler: KeyHandler = (event, handler) => {
      event.preventDefault()
      if (!areHotkeysEnabled() || !state.waveformShow.value || isPreviewMoveActive()) {
        return
      }
      // 检查是否是 Delete 键触发，并且歌曲列表区有选中的歌曲
      if (
        handler.key === 'delete' &&
        runtime.focusArea === 'songsArea' &&
        runtime.libraryAreaSelected === 'PioneerDeviceLibrary'
      )
        return
      if (handler.key === 'delete' && state.songsAreaSelectedCount.value > 0) {
        return // 如果列表区有选中，则此快捷键不响应，让列表区的删除逻辑处理
      }
      if (
        isReadOnlyPlaybackSource() &&
        !isEditablePioneerUsbSong(runtime.playingData.playingSong)
      ) {
        return
      }
      // 防止重复触发确认框
      if (internalShowDelConfirm.value || state.confirmShow.value) {
        return
      }

      // 重置活动菜单（如果需要）
      state.activeMenuUUID.value = ''

      internalShowDelConfirm.value = true // 标记开始处理
      // 调用 delSong，它是异步的，但我们在这里不 await 它
      // 注意：这意味着 internalShowDelConfirm 可能在 delSong 完成前就变回 false
      // 如果需要精确控制，delSong 需要提供回调或返回 Promise 让这里能处理
      actions.delSong()
      // 兜底：触发一次歌单内容变更事件，确保徽标数量刷新
      try {
        const uid = runtime.playingData?.playingSongListUUID
        if (uid) {
          emitter.emit('playlistContentChanged', { uuids: [uid] })
        }
      } catch {}
      // 立即或稍后重置标记，取决于 delSong 的行为
      // 简单的处理是假设 delSong 会处理后续状态
      internalShowDelConfirm.value = false // 暂时立即重置
    }
    hotkeys('f,delete', scope, deleteHandler)

    hotkeys('q', scope, (event) => {
      event.preventDefault()
      if (
        !areHotkeysEnabled() ||
        (!state.waveformShow.value && !isPreviewMoveActive()) ||
        isAnySelectSongListDialogVisible()
      ) {
        return
      }
      if (emitPreviewMoveRequest('FilterLibrary')) {
        return
      }
      if (!state.waveformShow.value) return
      actions.moveToListLibrary()
    })

    hotkeys('e', scope, (event) => {
      event.preventDefault()
      if (
        !areHotkeysEnabled() ||
        (!state.waveformShow.value && !isPreviewMoveActive()) ||
        isAnySelectSongListDialogVisible()
      ) {
        return
      }
      if (emitPreviewMoveRequest('CuratedLibrary')) {
        return
      }
      if (!state.waveformShow.value) return
      actions.moveToLikeLibrary()
    })

    const seekToHotkeyPercent = (event: KeyboardEvent, handlerKey?: string) => {
      event.preventDefault()
      if (
        !areHotkeysEnabled() ||
        !state.waveformShow.value ||
        isPreviewMoveActive() ||
        isAnySelectSongListDialogVisible()
      ) {
        return
      }
      const ratio = resolveSeekPercentHotkeyRatio(event, handlerKey)
      if (ratio === null) return
      actions.seekToPercent(ratio)
    }

    hotkeys('`,shift+`', scope, (event) => {
      seekToHotkeyPercent(event, '`')
    })

    hotkeys(
      '1,2,3,4,5,6,7,8,9,0,num_1,num_2,num_3,num_4,num_5,num_6,num_7,num_8,num_9,num_0',
      scope,
      (event, handler) => {
        seekToHotkeyPercent(event, handler.key)
      }
    )

    // +/- 音量控制
    hotkeys('=,+,shift+=', scope, (event) => {
      event.preventDefault()
      if (!areHotkeysEnabled() || isPreviewMoveActive() || isAnySelectSongListDialogVisible())
        return
      actions.volumeUp()
    })

    hotkeys('-', scope, (event) => {
      event.preventDefault()
      if (!areHotkeysEnabled() || isPreviewMoveActive() || isAnySelectSongListDialogVisible())
        return
      actions.volumeDown()
    })
  }

  const cleanupHotkeys = () => {
    // 精确解绑在此处绑定的快捷键和作用域
    hotkeys.unbind('space', 'windowGlobal')
    hotkeys.unbind('d,right', 'windowGlobal')
    hotkeys.unbind('a,left', 'windowGlobal')
    hotkeys.unbind('s,down', 'windowGlobal')
    hotkeys.unbind('w,up', 'windowGlobal')
    hotkeys.unbind('f,delete', 'windowGlobal')
    hotkeys.unbind('q', 'windowGlobal')
    hotkeys.unbind('e', 'windowGlobal')
    hotkeys.unbind('`,shift+`', 'windowGlobal')
    hotkeys.unbind(
      '1,2,3,4,5,6,7,8,9,0,num_1,num_2,num_3,num_4,num_5,num_6,num_7,num_8,num_9,num_0',
      'windowGlobal'
    )
    hotkeys.unbind('r', 'windowGlobal')
    hotkeys.unbind('=,+,shift+=', 'windowGlobal')
    hotkeys.unbind('-', 'windowGlobal')
  }

  onMounted(() => {
    setupHotkeys()
    emitter.on('waveform-preview:state', handleWaveformPreviewState)
  })

  onUnmounted(() => {
    cleanupHotkeys()
    emitter.off('waveform-preview:state', handleWaveformPreviewState)
  })
}
