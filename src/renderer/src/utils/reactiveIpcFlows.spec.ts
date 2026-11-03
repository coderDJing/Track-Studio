// Run: pnpm exec vitest run src/renderer/src/utils/reactiveIpcFlows.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from './libraryUtils'
import emitter from './mitt'
import { appendOrderedTracksToMixtape } from './mixtapePlaylistAppend'
import { usePlayerControlsLogic } from '@renderer/pages/modules/songPlayer/usePlayerControlsLogic'
import { useHorizontalBrowseDeckMove } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckMove'
import { useMainPlayerMiniPlayer } from '@renderer/pages/modules/songPlayer/useMainPlayerMiniPlayer'
import { useMiniPlayerHost } from '@renderer/composables/miniPlayer/useMiniPlayerHost'
import { usePioneerTrackCopyDialog } from '@renderer/pages/modules/pioneerSongsArea/usePioneerTrackCopyDialog'
import { useI18n } from '@renderer/composables/useI18n'
import type { ISongInfo } from 'src/types/globals'

vi.mock('@renderer/utils/libraryUtils', () => ({
  default: {
    getLibraryTreeByUUID: vi.fn(),
    buildDisplayPathByUuid: vi.fn(() => 'Library / Source')
  }
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/components/confirmDialog', () => ({ default: vi.fn() }))
vi.mock('@renderer/components/exportDialog', () => ({ default: vi.fn() }))
vi.mock('@renderer/components/selectSongListDialog', () => ({
  default: vi.fn(async () => ({ uuid: 'target-list' }))
}))
vi.mock('@renderer/pages/modules/songPlayer/webAudioPlayer', () => ({
  WebAudioPlayer: class {}
}))
vi.mock('@renderer/pages/modules/songPlayer/usePlayerDeleteAllAbove', () => ({
  createDelAllAbove: () => vi.fn()
}))
vi.mock('@renderer/composables/rekordboxDesktop/usePioneerUsbPlaybackDeletion', () => ({
  usePioneerUsbPlaybackDeletion: vi.fn()
}))
vi.mock('@renderer/composables/miniPlayer/useMiniPlayerHost', () => ({
  useMiniPlayerHost: vi.fn()
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref('zh-CN') })
}))
vi.mock('@renderer/i18n', () => ({ setLocale: vi.fn() }))

const songPath = 'D:/Music/Track.mp3'
const invoke = vi.fn((channel: string, ...args: unknown[]) => {
  // Electron rejects Proxy values anywhere inside its argument graph.
  structuredClone(args)
  if (channel === 'songList:resolve-by-file-path') {
    return Promise.resolve({ songListUuid: 'source-list' })
  }
  if (channel === 'mixtape:copy-files-to-vault') {
    return Promise.resolve([{ sourcePath: songPath, targetPath: 'D:/Vault/Track.mp3' }])
  }
  return Promise.resolve(channel === 'mixtape:append' ? { inserted: 1, skippedNoBpm: 0 } : [])
})

const createSong = (): ISongInfo => ({
  filePath: songPath,
  fileName: 'Track.mp3',
  fileFormat: 'MP3',
  cover: { format: 'image/png', data: new Uint8Array([1, 2, 3]) },
  title: 'Track',
  artist: 'Artist',
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
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
  vi.mocked(libraryUtils.getLibraryTreeByUUID).mockImplementation((uuid) => ({
    uuid,
    type: uuid === 'source-list' ? 'songList' : uuid === 'target-set' ? 'setList' : 'mixtapeList',
    dirName: uuid
  }))
})

afterEach(() => {
  emitter.all.clear()
  vi.unstubAllGlobals()
})

const prepareRuntime = () => {
  const runtime = useRuntimeStore()
  runtime.songsArea.songListUUID = 'source-list'
  runtime.songsArea.songInfoArr = [createSong()]
  runtime.playingData.playingSong = runtime.songsArea.songInfoArr[0]
  runtime.playingData.playingSongListUUID = 'source-list'
  runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
  return runtime
}

const expectSnapshotSubmitted = (channel: string) => {
  const call = invoke.mock.calls.find(([name]) => name === channel)
  expect(call).toBeDefined()
  expect(() => structuredClone(call)).not.toThrow()
  const snapshot = expect.objectContaining({
    energyAnalysis: createSong().energyAnalysis,
    hotCues: createSong().hotCues,
    memoryCues: createSong().memoryCues
  })
  expect(call?.[1]).toEqual(
    expect.objectContaining({
      items: [
        expect.objectContaining(
          channel === 'setList:append-items' ? { analysis: snapshot } : { info: snapshot }
        )
      ]
    })
  )
}

describe('reactive data crossing IPC boundaries', () => {
  it.each(['set', 'mixtape', 'usb-set', 'desktop-set'] as const)(
    'main player adds a song to %s',
    async (target) => {
      const runtime = prepareRuntime()
      const custody = target === 'usb-set' || target === 'desktop-set'
      if (custody) {
        runtime.playingData.playingSongListUUID = `${target === 'usb-set' ? 'usb' : 'desktop'}:playlist`
        runtime.playingData.playingSong!.externalSourceKind =
          target === 'usb-set' ? 'usb' : 'desktop'
      }
      const controls = usePlayerControlsLogic({
        runtime,
        audioPlayer: ref(null),
        bpm: ref<number | string>(''),
        waveformShow: ref(false),
        selectSongListDialogShow: ref(false),
        selectSongListDialogLibraryName: ref(''),
        selectSongListDialogActionMode: ref('move'),
        isInternalSongChange: ref(false),
        requestLoadSong: vi.fn(),
        ignoreNextEmptyError: ref(false)
      })
      if (target !== 'mixtape') controls.moveToSetLibrary()
      else {
        // A Set source is copied into a Mixtape.
        runtime.playingData.playingSongListUUID = 'source-set'
        vi.mocked(libraryUtils.getLibraryTreeByUUID).mockImplementation((uuid) => ({
          uuid,
          type: uuid === 'source-set' ? 'setList' : 'mixtapeList',
          dirName: uuid
        }))
        controls.moveToMixtapeLibrary()
      }
      await controls.handleMoveSong(target !== 'mixtape' ? 'target-set' : 'target-list')
      if (custody) {
        expect(invoke).toHaveBeenCalledExactlyOnceWith('setList:append-custody-items', {
          playlistUuid: 'target-set',
          items: [{ song: runtime.playingData.playingSong, originPathSnapshot: 'rekordbox' }]
        })
        // Completion must release the operation flag for the next addition.
        controls.moveToSetLibrary()
        await controls.handleMoveSong('target-set')
        expect(invoke).toHaveBeenCalledTimes(2)
      } else {
        expectSnapshotSubmitted(target === 'set' ? 'setList:append-items' : 'mixtape:append')
      }
    }
  )

  it.each(['move', 'copy'] as const)('deck player adds to Mixtape in %s mode', async (mode) => {
    const runtime = prepareRuntime()
    const move = useHorizontalBrowseDeckMove({
      getDeckSong: () => runtime.playingData.playingSong,
      setDeckSong: vi.fn()
    })
    move.openDeckMoveDialog('top', 'MixtapeLibrary', mode)
    await move.handleDeckMoveSong('target-list')
    expectSnapshotSubmitted('mixtape:append')
  })

  it('adds ordered reactive tracks to a Mixtape', async () => {
    const runtime = prepareRuntime()
    await appendOrderedTracksToMixtape({
      entries: runtime.songsArea.songInfoArr.map((song) => ({ song }))
    })
    expectSnapshotSubmitted('mixtape:append')
  })

  it.each(['MixtapeLibrary', 'SetLibrary'] as const)(
    'copies external reactive song snapshots into %s',
    async (target) => {
      const runtime = prepareRuntime()
      const songs = runtime.songsArea.songInfoArr
      const copy = usePioneerTrackCopyDialog({
        resolveTrackKey: (song) => song.filePath,
        resolveSelectedTracksByKeys: () => songs,
        resolveSelectedTracks: () => songs,
        resolveExistingOperationTracks: async () => ({ missingTracks: [], existingTracks: songs }),
        showFileMissingHint: vi.fn(),
        normalizePath: (path) => path,
        buildSongSnapshot: (filePath, song) => ({
          ...song,
          cover: null,
          filePath,
          key: song.key,
          originalKey: song.key,
          originalBpm: song.bpm,
          energyScore: song.energyScore,
          energyAlgorithmVersion: song.energyAlgorithmVersion,
          energyAnalysis: song.energyAnalysis,
          hotCues: song.hotCues || [],
          memoryCues: song.memoryCues || []
        }),
        originPathSnapshot: computed(() => 'External Library')
      })
      copy.openCopyTargetDialog(target, songs)
      await copy.handleSelectSongListDialogConfirm('target-list')
      if (target === 'SetLibrary') {
        expect(invoke).toHaveBeenCalledExactlyOnceWith('setList:append-custody-items', {
          playlistUuid: 'target-list',
          items: [{ song: songs[0], originPathSnapshot: 'External Library' }]
        })
      } else {
        expectSnapshotSubmitted('mixtape:append')
      }
    }
  )

  it('exports a reactive playing song from the mini player with its binary cover intact', async () => {
    const runtime = prepareRuntime()
    const action = vi.fn()
    useMainPlayerMiniPlayer({
      runtime,
      audioPlayer: ref(null),
      isPlaying: computed(() => false),
      playerCurrentSeconds: ref(0),
      playerWaveformDurationSec: computed(() => 180),
      playerWaveformRenderRevision: ref(0),
      waveformShow: ref(false),
      bpm: ref<number | string>(''),
      isInternalSongChange: ref(false),
      requestLoadSong: action,
      play: action,
      actions: {
        pause: action,
        togglePlayPause: action,
        nextSong: action,
        previousSong: action,
        fastForward: action,
        fastBackward: action,
        delSong: action,
        delAllAbove: action,
        handleMoveSong: async () => {},
        setPlaybackRangeStartPercent: action,
        setPlaybackRangeEndPercent: action,
        savePlaybackRange: action,
        togglePlaybackRange: action
      },
      setVolume: action,
      getVolume: () => 1
    })
    const host = vi.mocked(useMiniPlayerHost).mock.calls[0][0]
    await host.actions.exportTrackWithFolder('D:/Export', false)
    const call = invoke.mock.calls.find(([name]) => name === 'exportSongsToDir')
    expect(() => structuredClone(call)).not.toThrow()
    expect(call?.[3]).toEqual([createSong()])
    expect(runtime.playingData.playingSong?.filePath).toBe(songPath)
  })

  it('persists language changes with a plain settings snapshot', async () => {
    const runtime = prepareRuntime()
    runtime.setting.language = ''
    await useI18n().switchLanguage('en-US')
    expect(runtime.setting.language).toBe('enUS')
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'setSetting',
      expect.objectContaining({ language: 'enUS' })
    )
    expect(() => structuredClone(invoke.mock.calls[0])).not.toThrow()
  })
})
