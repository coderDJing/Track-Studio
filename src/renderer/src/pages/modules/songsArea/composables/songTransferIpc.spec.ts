import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { toRaw } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import emitter from '@renderer/utils/mitt'
import type { ISongInfo } from '../../../../../../types/globals'
import { useSelectAndMoveSongs } from './useSelectAndMoveSongs'
import { useDragSongs } from './useDragSongs'

vi.mock('@renderer/utils/libraryUtils', () => ({
  default: {
    getLibraryTreeByUUID: vi.fn(),
    buildDisplayPathByUuid: vi.fn(() => 'Filter Library / Source')
  }
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))

// Simulate Electron's structured-clone boundary without moving any real files.
const invoke = vi.fn((channel: string, payload: unknown) => {
  structuredClone(payload)
  return Promise.resolve(channel === 'mixtape:append' ? { inserted: 1, skippedNoBpm: 0 } : [])
})

const createSong = (): ISongInfo => ({
  filePath: 'D:/Music/Track.mp3',
  fileName: 'Track.mp3',
  fileFormat: 'MP3',
  cover: null,
  title: 'Track',
  artist: 'Artist',
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
  key: '2A',
  keyAnalysisAlgorithmVersion: 1,
  bpm: 128,
  energyScore: 5,
  energyAlgorithmVersion: 11,
  energyAnalysis: {
    version: 11,
    model: 'musicnn-deam-emomusic-structure-v11',
    sustainedScore: 5,
    averageScore: 5,
    medianScore: 5,
    peakScore: 7,
    rangeScore: 2,
    confidence: 0.9,
    patchCount: 2,
    energyCurve: [{ timeMs: 0, score: 5, role: 'intro' }]
  },
  hotCues: [{ slot: 0, sec: 12, label: 'Start' }],
  memoryCues: [{ sec: 24, comment: 'Verse' }]
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
})

afterEach(() => {
  emitter.all.clear()
  vi.unstubAllGlobals()
})

describe('song transfer IPC payloads', () => {
  it('copies USB songs dragged into SET through custody instead of a USB file reference', async () => {
    const runtime = useRuntimeStore()
    const song = createSong()
    song.externalSourceKind = 'usb'
    runtime.playingData.playingSongListUUID = 'usb:playlist'
    runtime.playingData.playingSongListData = [song]
    runtime.dragSourceSongListUUID = 'usb:playlist'
    runtime.draggingSongFilePaths = [song.filePath]
    vi.mocked(libraryUtils.getLibraryTreeByUUID).mockImplementation((uuid) =>
      uuid === 'target-set' ? { uuid, type: 'setList', dirName: 'SET' } : null
    )
    const transfer = useDragSongs()
    await transfer.handleDropToSongList('target-set', 'SetLibrary')
    expect(invoke).toHaveBeenCalledExactlyOnceWith('setList:append-custody-items', {
      playlistUuid: 'target-set',
      items: [{ song, originPathSnapshot: 'rekordbox' }]
    })
    expect(runtime.playingData.playingSongListData).toEqual([song])
  })

  it.each([
    ['dialog', 'setList'],
    ['drag', 'setList'],
    ['dialog', 'mixtapeList'],
    ['drag', 'mixtapeList']
  ] as const)(
    '%s preserves reactive analysis and cues when adding to %s',
    async (entry, target) => {
      const runtime = useRuntimeStore()
      const state = runtime.songsArea
      state.songListUUID = 'source-list'
      state.songInfoArr = [createSong()]
      state.selectedSongFilePath = [state.songInfoArr[0].filePath]
      const song = state.songInfoArr[0]
      const expectedAnalysis = {
        key: song.key,
        keyAnalysisAlgorithmVersion: song.keyAnalysisAlgorithmVersion,
        energyScore: song.energyScore,
        energyAlgorithmVersion: song.energyAlgorithmVersion,
        energyAnalysis: structuredClone(toRaw(song.energyAnalysis)),
        hotCues: structuredClone(toRaw(song.hotCues)),
        memoryCues: structuredClone(toRaw(song.memoryCues))
      }
      expect(() => structuredClone(song.energyAnalysis)).toThrow()
      vi.mocked(libraryUtils.getLibraryTreeByUUID).mockImplementation((uuid) => ({
        uuid,
        type: uuid === 'source-list' ? 'songList' : target,
        dirName: uuid
      }))
      const changed = vi.fn()
      emitter.on('playlistContentChanged', changed)

      if (entry === 'dialog') {
        const transfer = useSelectAndMoveSongs({ songsAreaState: state })
        transfer.initiateMoveSongs(target === 'setList' ? 'SetLibrary' : 'MixtapeLibrary')
        await transfer.handleMoveSongsConfirm('target-list')
        expect(state.selectedSongFilePath).toEqual([])
      } else {
        const transfer = useDragSongs({ songsAreaState: state })
        transfer.startDragSongs(song, 'FilterLibrary', 'source-list')
        await expect(transfer.handleDropToSongList('target-list', '')).resolves.toEqual([])
        expect(transfer.isDragging.value).toBe(false)
        expect(runtime.songDragActive).toBe(false)
      }

      // Later edits must not mutate the snapshot submitted to the main process.
      song.energyAnalysis!.energyCurve![0].score = 9
      song.hotCues![0].label = 'Changed'
      song.memoryCues![0].comment = 'Changed'
      const item = {
        filePath: song.filePath,
        originPlaylistUuid: 'source-list',
        originPathSnapshot: 'Filter Library / Source',
        ...(target === 'setList'
          ? { analysis: expectedAnalysis }
          : { info: expect.objectContaining(expectedAnalysis) })
      }
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        target === 'setList' ? 'setList:append-items' : 'mixtape:append',
        {
          ...(target === 'setList'
            ? { playlistUuid: 'target-list' }
            : { playlistId: 'target-list' }),
          items: [expect.objectContaining(item)]
        }
      )
      expect(changed).toHaveBeenCalledExactlyOnceWith({ uuids: ['target-list'] })
      expect(state.songInfoArr).toEqual([song])
    }
  )
})
