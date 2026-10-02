import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  isSameHorizontalBrowseSongFilePath,
  mergeHorizontalBrowseSongWithSharedGrid,
  mergeHorizontalBrowseSongWithStructure
} from '@renderer/composables/horizontalBrowse/horizontalBrowseShellSongs'
import { buildHorizontalBrowseTransportGridPayload } from '@shared/horizontalBrowseTransportGrid'
import type { SongStructureAnalysis } from '@shared/songStructure'
import { patchHorizontalBrowseRuntimeSongSnapshots } from '@renderer/composables/horizontalBrowse/horizontalBrowseSongSnapshotPatch'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportBeatGridInput
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

type HorizontalBrowseLoadSongPayload = {
  deck?: DeckKey
  song?: ISongInfo | null
  sourceSongListUUID?: string
  sourceSongListData?: ISongInfo[]
}

type SharedSongGridPayload = {
  filePath?: string
  timeBasisOffsetMs?: number
  beatGridMap?: ISongInfo['beatGridMap'] | null
  rekordboxGridEntries?: ISongInfo['rekordboxGridEntries']
  hotCues?: ISongInfo['hotCues']
  memoryCues?: ISongInfo['memoryCues']
  bpm?: number
  fileMissing?: boolean
  externalBeatGridPreference?: 'frkb-manual'
} | null

type SongStructurePayload = {
  filePath?: string
  songStructure?: SongStructureAnalysis
} | null

type UseHorizontalBrowseDeckSongSyncParams = {
  topDeckSong: Ref<ISongInfo | null>
  bottomDeckSong: Ref<ISongInfo | null>
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  syncDeckDefaultCue: (deck: DeckKey, song: ISongInfo | null, force?: boolean) => void
  setDeckBeatGridToNative: (
    deck: DeckKey,
    payload: HorizontalBrowseTransportBeatGridInput
  ) => Promise<unknown>
  assignSongToDeck: (
    deck: DeckKey,
    song: ISongInfo,
    sourceOptions?: { sourceSongListUUID?: string; sourceSongListData?: ISongInfo[] }
  ) => Promise<void>
}

export const useHorizontalBrowseDeckSongSync = (params: UseHorizontalBrowseDeckSongSyncParams) => {
  const runtime = useRuntimeStore()

  const patchDeckSongSharedGrid = (song: ISongInfo, payload: SharedSongGridPayload) => {
    const nextSong = mergeHorizontalBrowseSongWithSharedGrid(song, payload)
    if (nextSong === song) return false
    song.timeBasisOffsetMs = nextSong.timeBasisOffsetMs
    if (nextSong.beatGridMap) {
      song.beatGridMap = nextSong.beatGridMap
    } else {
      delete song.beatGridMap
    }
    if (nextSong.songStructure) {
      song.songStructure = nextSong.songStructure
    } else {
      delete song.songStructure
    }
    if (nextSong.rekordboxGridEntries) {
      song.rekordboxGridEntries = nextSong.rekordboxGridEntries
    }
    if (nextSong.hotCues) song.hotCues = nextSong.hotCues
    if (nextSong.memoryCues) song.memoryCues = nextSong.memoryCues
    if (nextSong.bpm !== undefined) song.bpm = nextSong.bpm
    if (nextSong.fileMissing === true) song.fileMissing = true
    return true
  }

  const buildNativeGridPayload = (
    payload: SharedSongGridPayload
  ): HorizontalBrowseTransportBeatGridInput | null =>
    buildHorizontalBrowseTransportGridPayload(payload || {})

  const handleExternalDeckSongLoad = (payload: HorizontalBrowseLoadSongPayload) => {
    const deck = payload?.deck
    const song = payload?.song
    if (!deck || !song) return
    void params.assignSongToDeck(
      deck,
      { ...song },
      {
        sourceSongListUUID: String(payload.sourceSongListUUID || '').trim(),
        sourceSongListData: Array.isArray(payload.sourceSongListData)
          ? payload.sourceSongListData
          : []
      }
    )
  }

  const handleSongGridUpdated = (_event: unknown, payload: SharedSongGridPayload) => {
    patchHorizontalBrowseRuntimeSongSnapshots(
      runtime,
      payload,
      mergeHorizontalBrowseSongWithSharedGrid
    )
    const nativeGridPayload = buildNativeGridPayload(payload)
    const nativeUpdates: Promise<unknown>[] = []
    const topSong = params.topDeckSong.value
    if (topSong) {
      if (patchDeckSongSharedGrid(topSong, payload)) {
        params.setDeckSong('top', topSong)
        params.syncDeckDefaultCue('top', topSong)
        if (nativeGridPayload) {
          nativeUpdates.push(params.setDeckBeatGridToNative('top', nativeGridPayload))
        }
      }
    }

    const bottomSong = params.bottomDeckSong.value
    if (bottomSong) {
      if (patchDeckSongSharedGrid(bottomSong, payload)) {
        params.setDeckSong('bottom', bottomSong)
        params.syncDeckDefaultCue('bottom', bottomSong)
        if (nativeGridPayload) {
          nativeUpdates.push(params.setDeckBeatGridToNative('bottom', nativeGridPayload))
        }
      }
    }

    if (nativeUpdates.length > 0) {
      void Promise.allSettled(nativeUpdates)
    }
  }

  const handleSongGridBatchUpdated = (
    _event: unknown,
    payloads: Array<Exclude<SharedSongGridPayload, null>>
  ) => {
    if (!Array.isArray(payloads) || payloads.length === 0) return
    const activePaths = new Set(
      [
        params.topDeckSong.value?.filePath,
        params.bottomDeckSong.value?.filePath,
        runtime.playingData.playingSong?.filePath
      ]
        .map((filePath) =>
          String(filePath || '')
            .replace(/\//g, '\\')
            .toLowerCase()
        )
        .filter(Boolean)
    )
    if (activePaths.size === 0) return
    const handledPaths = new Set<string>()
    for (const payload of payloads) {
      const normalizedPath = String(payload?.filePath || '')
        .replace(/\//g, '\\')
        .toLowerCase()
      if (!normalizedPath || !activePaths.has(normalizedPath) || handledPaths.has(normalizedPath)) {
        continue
      }
      handledPaths.add(normalizedPath)
      handleSongGridUpdated(undefined, payload)
    }
  }

  const handleSongKeyUpdated = (
    _event: unknown,
    payload: { filePath?: string; keyText?: string }
  ) => {
    const filePath = String(payload?.filePath || '').trim()
    const keyText = String(payload?.keyText || '').trim()
    if (!filePath || !keyText) return

    const patchDeckSongKey = (deck: DeckKey) => {
      const currentSong = params.resolveDeckSong(deck)
      if (!currentSong) return
      if (!isSameHorizontalBrowseSongFilePath(currentSong.filePath, filePath)) return
      if (String(currentSong.key || '').trim() === keyText) return
      params.setDeckSong(deck, {
        ...currentSong,
        key: keyText
      })
    }

    patchDeckSongKey('top')
    patchDeckSongKey('bottom')
  }

  const handleSongStructureUpdated = (_event: unknown, payload: SongStructurePayload) => {
    patchHorizontalBrowseRuntimeSongSnapshots(
      runtime,
      payload,
      mergeHorizontalBrowseSongWithStructure
    )
    const patchDeckSongStructure = (deck: DeckKey) => {
      const currentSong = params.resolveDeckSong(deck)
      if (!currentSong) return
      const nextSong = mergeHorizontalBrowseSongWithStructure(currentSong, payload)
      if (nextSong === currentSong) return
      params.setDeckSong(deck, nextSong)
    }

    patchDeckSongStructure('top')
    patchDeckSongStructure('bottom')
  }

  return {
    disposeSongSync: () => undefined,
    handleExternalDeckSongLoad,
    handleSongGridBatchUpdated,
    handleSongGridUpdated,
    handleSongKeyUpdated,
    handleSongStructureUpdated
  }
}
