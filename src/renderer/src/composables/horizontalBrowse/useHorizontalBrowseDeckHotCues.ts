import type { ISongHotCue, ISongInfo } from 'src/types/globals'
import { mergeHorizontalBrowseSongWithHotCues } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellSongs'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRenderSync'
import { isRekordboxExternalPlaybackSource } from '@renderer/utils/rekordboxExternalSource'
import { editPioneerUsbSong, isEditablePioneerUsbSong } from '@renderer/utils/pioneerUsbEditing'

type DeckKey = HorizontalBrowseDeckKey

type SongHotCuePayload = {
  filePath?: string
  hotCues?: ISongHotCue[]
} | null

type UseHorizontalBrowseDeckHotCuesParams = {
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  resolveDeckMarkerPlacementSec: (deck: DeckKey) => number
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  buildDeckStoredCueDefinition: (
    deck: DeckKey
  ) => Pick<ISongHotCue, 'sec' | 'isLoop' | 'loopEndSec'> | null
  handleDeckHotCueRecall: (
    deck: DeckKey,
    cue: Pick<ISongHotCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
  ) => Promise<void>
  nativeTransport: {
    seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
    beatsync: (deck: DeckKey) => Promise<unknown>
  }
  commitDeckStatesToNative: () => Promise<unknown>
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  isDeckLoopActive: (deck: DeckKey) => boolean
}

export const useHorizontalBrowseDeckHotCues = (params: UseHorizontalBrowseDeckHotCuesParams) => {
  const patchDeckSongHotCues = (deck: DeckKey, hotCues: ISongHotCue[]) => {
    const currentSong = params.resolveDeckSong(deck)
    if (!currentSong) return
    params.setDeckSong(deck, {
      ...currentSong,
      hotCues
    })
  }

  const triggerDeckHotCuePlayback = async (deck: DeckKey, cueSec: number) => {
    const targetSec = Math.max(0, Number(cueSec) || 0)
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const wasPlaying = Boolean(snapshot.playing)
    await params.nativeTransport.seek(deck, targetSec)
    if (!wasPlaying && snapshot.syncEnabled && !params.isDeckLoopActive(deck)) {
      await params.commitDeckStatesToNative()
      await params.nativeTransport.beatsync(deck)
    }
    if (!wasPlaying) {
      await params.nativeTransport.setPlaying(deck, true)
    }
    params.syncDeckRenderState({ force: deck })
  }

  const handleDeckHotCuePress = async (deck: DeckKey, slot: number) => {
    const song = params.resolveDeckSong(deck)
    if (!song) return
    const existingHotCue = Array.isArray(song.hotCues)
      ? song.hotCues.find((item) => item.slot === slot)
      : null
    if (existingHotCue && Number.isFinite(Number(existingHotCue.sec))) {
      await params.handleDeckHotCueRecall(deck, existingHotCue)
      return
    }
    if (isRekordboxExternalPlaybackSource('', song) && !isEditablePioneerUsbSong(song)) return

    const storedCueDefinition = params.buildDeckStoredCueDefinition(deck)
    if (!storedCueDefinition) return
    const cueDefinition = storedCueDefinition.isLoop
      ? storedCueDefinition
      : {
          ...storedCueDefinition,
          sec: params.resolveDeckMarkerPlacementSec(deck)
        }

    const result = isEditablePioneerUsbSong(song)
      ? await editPioneerUsbSong(song, {
          kind: 'set-hot-cue',
          cue: {
            slot,
            ...cueDefinition,
            sec: Math.round(cueDefinition.sec * 1000) / 1000,
            loopEndSec:
              cueDefinition.loopEndSec === undefined
                ? undefined
                : Math.round(cueDefinition.loopEndSec * 1000) / 1000
          }
        })
      : ((await window.electron.ipcRenderer.invoke('song:set-hot-cue', {
          filePath: song.filePath,
          slot,
          sec: cueDefinition.sec,
          isLoop: cueDefinition.isLoop,
          loopEndSec: cueDefinition.loopEndSec,
          durationSec: params.resolveDeckDurationSeconds(deck)
        })) as { hotCues?: ISongHotCue[] } | null)
    if (isEditablePioneerUsbSong(song) && !result) return
    if (params.resolveDeckSong(deck)?.filePath !== song.filePath) return
    const nextHotCues = Array.isArray(result?.hotCues)
      ? result.hotCues
      : [{ slot, sec: cueDefinition.sec }]
    patchDeckSongHotCues(deck, nextHotCues)
  }

  const handleDeckHotCueTrigger = async (deck: DeckKey, sec: number) => {
    await triggerDeckHotCuePlayback(deck, sec)
  }

  const handleDeckHotCueDelete = async (deck: DeckKey, slot: number) => {
    const song = params.resolveDeckSong(deck)
    if (!song) return
    const existingHotCue = Array.isArray(song.hotCues)
      ? song.hotCues.find((item) => item.slot === slot)
      : null
    if (!existingHotCue) return
    if (isRekordboxExternalPlaybackSource('', song) && !isEditablePioneerUsbSong(song)) return

    const result = isEditablePioneerUsbSong(song)
      ? await editPioneerUsbSong(song, { kind: 'delete-hot-cue', slot })
      : ((await window.electron.ipcRenderer.invoke('song:delete-hot-cue', {
          filePath: song.filePath,
          slot,
          durationSec: params.resolveDeckDurationSeconds(deck)
        })) as { hotCues?: ISongHotCue[] } | null)
    if (isEditablePioneerUsbSong(song) && !result) return
    if (params.resolveDeckSong(deck)?.filePath !== song.filePath) return
    patchDeckSongHotCues(deck, Array.isArray(result?.hotCues) ? result.hotCues : [])
    params.syncDeckRenderState({ force: deck })
  }

  const handleSongHotCuesUpdated = (_event: unknown, payload: SongHotCuePayload) => {
    const topSong = params.resolveDeckSong('top')
    if (topSong) {
      const nextTopSong = mergeHorizontalBrowseSongWithHotCues(topSong, payload)
      if (nextTopSong !== topSong) {
        params.setDeckSong('top', nextTopSong)
      }
    }

    const bottomSong = params.resolveDeckSong('bottom')
    if (bottomSong) {
      const nextBottomSong = mergeHorizontalBrowseSongWithHotCues(bottomSong, payload)
      if (nextBottomSong !== bottomSong) {
        params.setDeckSong('bottom', nextBottomSong)
      }
    }
  }

  return {
    handleDeckHotCuePress,
    handleDeckHotCueTrigger,
    handleDeckHotCueDelete,
    handleSongHotCuesUpdated
  }
}
