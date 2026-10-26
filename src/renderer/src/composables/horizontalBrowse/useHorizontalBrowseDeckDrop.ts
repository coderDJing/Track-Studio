import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import { reactive, ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { buildHorizontalBrowseSongSnapshot } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellSongs'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseDeckSongSourceOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckSourceState'
import { useRuntimeStore } from '@renderer/stores/runtime'

type DeckKey = HorizontalBrowseDeckKey

type UseHorizontalBrowseDeckDropParams = {
  resolveSongsAreaStateBySongListUUID: (songListUUID: string) => { songInfoArr: ISongInfo[] } | null
  resolveSongListSnapshot: (songListUUID: string) => ISongInfo[]
  assignSongToDeck: (
    deck: DeckKey,
    song: ISongInfo,
    sourceOptions?: HorizontalBrowseDeckSongSourceOptions
  ) => Promise<unknown>
}

const resolveDeckByRegion = (regionId: number): DeckKey => (regionId <= 4 ? 'top' : 'bottom')

export const useHorizontalBrowseDeckDrop = (params: UseHorizontalBrowseDeckDropParams) => {
  const runtime = useRuntimeStore()
  const hoveredDeckKey = ref<DeckKey | null>(null)
  const regionDragDepth = reactive<Record<number, number>>({
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
    8: 0
  })

  const resetRegionDragState = () => {
    hoveredDeckKey.value = null
    for (const key of Object.keys(regionDragDepth)) {
      regionDragDepth[Number(key)] = 0
    }
  }

  const isSongDrag = (event: DragEvent) =>
    Boolean(event.dataTransfer?.types?.includes('application/x-song-drag'))

  const resolveDraggedSong = () => {
    const filePath = String(runtime.draggingSongFilePaths?.[0] || '').trim()
    if (!filePath) return null

    const sourceSongListUUID = String(runtime.dragSourceSongListUUID || '').trim()
    const sourceSongsAreaState = params.resolveSongsAreaStateBySongListUUID(sourceSongListUUID)
    const currentSong =
      sourceSongsAreaState?.songInfoArr.find((song) =>
        sameRendererFilePath(song.filePath, filePath)
      ) ||
      runtime.songsArea.songInfoArr.find((song) => sameRendererFilePath(song.filePath, filePath)) ||
      runtime.playingData.playingSongListData.find((song) =>
        sameRendererFilePath(song.filePath, filePath)
      )

    return currentSong ? { ...currentSong } : buildHorizontalBrowseSongSnapshot(filePath)
  }

  const resolveDeckDragDepth = (deck: DeckKey) => {
    if (deck === 'top') {
      return regionDragDepth[1] + regionDragDepth[2] + regionDragDepth[3] + regionDragDepth[4]
    }
    return regionDragDepth[5] + regionDragDepth[6] + regionDragDepth[7] + regionDragDepth[8]
  }

  const handleRegionDragEnter = (regionId: number, event: DragEvent) => {
    if (!isSongDrag(event)) return
    regionDragDepth[regionId] += 1
    hoveredDeckKey.value = resolveDeckByRegion(regionId)
  }

  const handleRegionDragOver = (regionId: number, event: DragEvent) => {
    if (!isSongDrag(event)) return
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    hoveredDeckKey.value = resolveDeckByRegion(regionId)
  }

  const handleRegionDragLeave = (regionId: number, event: DragEvent) => {
    if (!isSongDrag(event)) return
    regionDragDepth[regionId] = Math.max(0, regionDragDepth[regionId] - 1)
    const deck = resolveDeckByRegion(regionId)
    requestAnimationFrame(() => {
      if (resolveDeckDragDepth(deck) === 0 && hoveredDeckKey.value === deck) {
        hoveredDeckKey.value = null
      }
    })
  }

  const handleRegionDrop = (regionId: number, event: DragEvent) => {
    if (!isSongDrag(event)) return
    const song = resolveDraggedSong()
    const sourceSongListUUID = String(runtime.dragSourceSongListUUID || '').trim()
    const sourceSongListData = params.resolveSongListSnapshot(sourceSongListUUID)
    resetRegionDragState()
    if (!song) return
    void params.assignSongToDeck(resolveDeckByRegion(regionId), song, {
      sourceSongListUUID,
      sourceSongListData
    })
  }

  const isDeckHovered = (deck: DeckKey) => hoveredDeckKey.value === deck
  const handleGlobalDragFinish = () => resetRegionDragState()

  return {
    isDeckHovered,
    handleRegionDragEnter,
    handleRegionDragOver,
    handleRegionDragLeave,
    handleRegionDrop,
    handleGlobalDragFinish
  }
}
