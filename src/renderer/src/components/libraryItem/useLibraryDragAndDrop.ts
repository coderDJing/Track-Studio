import { reactive, ref, watch, type Ref } from 'vue'
import {
  handleDragStart,
  handleDragOver,
  handleDragEnter,
  handleDragLeave,
  handleDrop,
  type DragState
} from '../../utils/dragUtils'
import libraryUtils from '@renderer/utils/libraryUtils'
import { isLibraryTreeManualSort } from '@renderer/utils/libraryTreeSort'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { IDir } from '../../../../types/globals'

interface UseLibraryDragAndDropOptions {
  runtime: ReturnType<typeof useRuntimeStore>
  dirDataRef: Ref<IDir | null>
  fatherDirDataRef: Ref<IDir | null>
  deleteDir: () => Promise<void>
  props: { uuid: string; libraryName: string }
  handleDropToSongList: (targetUuid: string, sourceUuid: string) => Promise<string[]>
  emitter: { emit: (event: string, payload?: unknown) => void }
}

export function useLibraryDragAndDrop({
  runtime,
  dirDataRef,
  fatherDirDataRef,
  deleteDir,
  props,
  handleDropToSongList,
  emitter
}: UseLibraryDragAndDropOptions) {
  const getDirData = () => dirDataRef.value
  const getFatherDirData = () => fatherDirDataRef.value

  const dragApproach = ref('')
  const dragState = reactive<DragState>({
    dragApproach: ''
  })

  watch(
    () => dragState.dragApproach,
    (newVal) => {
      dragApproach.value = newVal
    }
  )

  const isTreeReorderAllowed = () =>
    runtime.libraryAreaSelected !== 'RecycleBin' && isLibraryTreeManualSort(props.libraryName)

  const dragstart = async (event: DragEvent) => {
    if (!isTreeReorderAllowed()) {
      event.preventDefault()
      runtime.dragItemData = null
      return
    }
    const shouldDelete = await handleDragStart(event, props.uuid)
    if (shouldDelete) {
      runtime.dragItemData = null
      return
    }
    event.target?.addEventListener(
      'dragend',
      () => {
        runtime.dragItemData = null
      },
      { once: true }
    )
  }

  const isPlaylistInRecycleBin = () => {
    const recycleBin = runtime.libraryTree.children?.find((item) => item.dirName === 'RecycleBin')
    return recycleBin?.children?.some((child) => child.uuid === props.uuid)
  }

  const isInternalSongDrag = (e: DragEvent) => {
    if (runtime.dragItemData) return false
    if (e.dataTransfer?.types?.includes('application/x-song-drag')) return true
    return (
      runtime.songDragMode === 'internal' &&
      runtime.songDragActive &&
      runtime.draggingSongFilePaths.length > 0
    )
  }

  const suppressNextLibraryClick = (delayMs: number = 450) => {
    runtime.songDragSuppressClickUntilMs = Date.now() + delayMs
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

  const handleSongDragGuard = (e: DragEvent) => {
    const dirData = getDirData()
    if (!dirData) return true
    const isSongDrag = isInternalSongDrag(e)
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return true
    }
    if (
      isSongDrag &&
      (dirData.type === 'songList' || dirData.type === 'setList') &&
      isMixtapeSourceSongDrag()
    ) {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return true
    }
    if (
      isSongDrag &&
      (dirData.type === 'songList' || dirData.type === 'mixtapeList' || dirData.type === 'setList')
    ) {
      if (isPlaylistInRecycleBin()) {
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'none'
        }
        return true
      }
    }
    return false
  }

  const dragover = (e: DragEvent) => {
    const dirData = getDirData()
    if (!dirData) return
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return
    }
    const isInternalDrag = isInternalSongDrag(e)
    if (
      isInternalDrag &&
      (dirData.type === 'songList' || dirData.type === 'setList') &&
      isMixtapeSourceSongDrag()
    ) {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      dragState.dragApproach = ''
      return
    }
    if (
      isInternalDrag &&
      (dirData.type === 'songList' || dirData.type === 'mixtapeList' || dirData.type === 'setList')
    ) {
      if (isPlaylistInRecycleBin()) {
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'none'
        }
        return
      }
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect =
          dirData.type === 'mixtapeList' || dirData.type === 'setList' ? 'copy' : 'move'
      }
      dragState.dragApproach = 'center'
      return
    }
    // 自动排序只禁止歌单树内部重排，不能连系统文件/文件夹拖入歌单一起禁掉。
    if (runtime.dragItemData && !isTreeReorderAllowed()) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
      dragState.dragApproach = ''
      return
    }
    handleDragOver(e, dirData, dragState)
  }

  const dragenter = (e: DragEvent) => {
    const dirData = getDirData()
    if (!dirData) return
    if (handleSongDragGuard(e)) {
      return
    }
    const isInternalDrag = isInternalSongDrag(e)
    if (
      isInternalDrag &&
      (dirData.type === 'songList' ||
        dirData.type === 'mixtapeList' ||
        dirData.type === 'setList') &&
      !isPlaylistInRecycleBin()
    ) {
      e.preventDefault()
      dragState.dragApproach = 'center'
      return
    }
    if (runtime.dragItemData && !isTreeReorderAllowed()) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
      dragState.dragApproach = ''
      return
    }
    handleDragEnter(e, dirData, dragState)
  }

  const dragleave = () => {
    if (runtime.libraryAreaSelected === 'RecycleBin') {
      return
    }
    handleDragLeave(dragState)
  }

  const drop = async (e: DragEvent) => {
    const dirData = getDirData()
    const fatherDirData = getFatherDirData()
    if (!dirData || !fatherDirData) {
      dragState.dragApproach = ''
      return
    }
    const isInternalDrag = isInternalSongDrag(e)
    if (handleSongDragGuard(e)) {
      dragState.dragApproach = ''
      if (isInternalDrag) suppressNextLibraryClick()
      return
    }
    if (
      isInternalDrag &&
      (dirData.type === 'songList' || dirData.type === 'mixtapeList' || dirData.type === 'setList')
    ) {
      if (isPlaylistInRecycleBin()) {
        dragState.dragApproach = ''
        suppressNextLibraryClick()
        return
      }
      e.preventDefault()
      const movedSongPaths = await handleDropToSongList(props.uuid, runtime.libraryAreaSelected)
      suppressNextLibraryClick()
      dragState.dragApproach = ''
      if (movedSongPaths.length > 0) {
        emitter.emit('songsMovedByDrag', {
          paths: movedSongPaths,
          preservePlaybackForRemovedPaths: true
        })
      }
      return
    }
    if (runtime.dragItemData && !isTreeReorderAllowed()) {
      dragState.dragApproach = ''
      runtime.dragItemData = null
      return
    }
    const shouldDelete = await handleDrop(e, dirData, dragState, fatherDirData)
    if (shouldDelete) {
      await deleteDir()
    }
  }

  return {
    dragApproach,
    dragstart,
    dragover,
    dragenter,
    dragleave,
    drop
  }
}
