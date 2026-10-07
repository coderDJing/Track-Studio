import type { ISongInfo, ISongMemoryCue } from 'src/types/globals'
import {
  editPioneerUsbSong,
  isEditablePioneerUsbSong,
  canEditSongCues
} from '@renderer/utils/pioneerUsbEditing'
import { mergeHorizontalBrowseSongWithMemoryCues } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellSongs'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

type SongMemoryCuePayload = {
  filePath?: string
  memoryCues?: ISongMemoryCue[]
} | null

type UseHorizontalBrowseDeckMemoryCuesParams = {
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  buildDeckStoredCueDefinition: (
    deck: DeckKey
  ) => Pick<ISongMemoryCue, 'sec' | 'isLoop' | 'loopEndSec'> | null
  handleDeckMemoryCueRecall: (
    deck: DeckKey,
    cue: Pick<ISongMemoryCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
  ) => Promise<void>
}

export const useHorizontalBrowseDeckMemoryCues = (
  params: UseHorizontalBrowseDeckMemoryCuesParams
) => {
  const patchDeckSongMemoryCues = (deck: DeckKey, memoryCues: ISongMemoryCue[]) => {
    const currentSong = params.resolveDeckSong(deck)
    if (!currentSong) return
    params.setDeckSong(deck, {
      ...currentSong,
      memoryCues
    })
  }

  const handleDeckMemoryCueCreate = async (deck: DeckKey) => {
    const song = params.resolveDeckSong(deck)
    if (!song || !canEditSongCues(song)) return
    const cueDefinition = params.buildDeckStoredCueDefinition(deck)
    if (!cueDefinition) return
    const result = isEditablePioneerUsbSong(song)
      ? await editPioneerUsbSong(song, {
          kind: 'add-memory-cue',
          cue: {
            ...cueDefinition,
            sec: Math.round(cueDefinition.sec * 1000) / 1000,
            loopEndSec:
              cueDefinition.loopEndSec === undefined
                ? undefined
                : Math.round(cueDefinition.loopEndSec * 1000) / 1000
          }
        })
      : ((await window.electron.ipcRenderer.invoke('song:add-memory-cue', {
          filePath: song.filePath,
          sec: cueDefinition.sec,
          isLoop: cueDefinition.isLoop,
          loopEndSec: cueDefinition.loopEndSec
        })) as { memoryCues?: ISongMemoryCue[] } | null)
    if (isEditablePioneerUsbSong(song) && !result) return
    if (params.resolveDeckSong(deck)?.filePath !== song.filePath) return
    patchDeckSongMemoryCues(deck, Array.isArray(result?.memoryCues) ? result.memoryCues : [])
  }

  const handleDeckMemoryCueDelete = async (deck: DeckKey, sec: number) => {
    const song = params.resolveDeckSong(deck)
    if (!song || !canEditSongCues(song)) return
    const result = isEditablePioneerUsbSong(song)
      ? await editPioneerUsbSong(song, { kind: 'delete-memory-cue', sec })
      : ((await window.electron.ipcRenderer.invoke('song:delete-memory-cue', {
          filePath: song.filePath,
          sec
        })) as { memoryCues?: ISongMemoryCue[] } | null)
    if (isEditablePioneerUsbSong(song) && !result) return
    if (params.resolveDeckSong(deck)?.filePath !== song.filePath) return
    patchDeckSongMemoryCues(deck, Array.isArray(result?.memoryCues) ? result.memoryCues : [])
  }

  const handleDeckMemoryCueRecallPress = async (deck: DeckKey, sec: number) => {
    const song = params.resolveDeckSong(deck)
    if (!song) return
    const memoryCue = Array.isArray(song.memoryCues)
      ? song.memoryCues.find((item) => Math.abs(item.sec - sec) <= 0.0001)
      : null
    if (!memoryCue) return
    await params.handleDeckMemoryCueRecall(deck, memoryCue)
  }

  const handleSongMemoryCuesUpdated = (_event: unknown, payload: SongMemoryCuePayload) => {
    const topSong = params.resolveDeckSong('top')
    if (topSong) {
      const nextTopSong = mergeHorizontalBrowseSongWithMemoryCues(topSong, payload)
      if (nextTopSong !== topSong) {
        params.setDeckSong('top', nextTopSong)
      }
    }

    const bottomSong = params.resolveDeckSong('bottom')
    if (bottomSong) {
      const nextBottomSong = mergeHorizontalBrowseSongWithMemoryCues(bottomSong, payload)
      if (nextBottomSong !== bottomSong) {
        params.setDeckSong('bottom', nextBottomSong)
      }
    }
  }

  return {
    handleDeckMemoryCueCreate,
    handleDeckMemoryCueDelete,
    handleDeckMemoryCueRecallPress,
    handleSongMemoryCuesUpdated
  }
}
