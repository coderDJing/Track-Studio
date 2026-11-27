import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { icloudState } from '@renderer/utils/icloudLibrary'
import { cancelCloudPlayback, setIcloudDeckLocalizedHandler } from '@renderer/utils/icloudPlayback'
import { useHorizontalBrowseEditDeckNavigation } from './useHorizontalBrowseEditDeckNavigation'

const invoke = vi.fn()
const harness = vi.hoisted(() => {
  const { reactive } = require('vue') as typeof import('vue')
  return { songs: reactive<ISongInfo[]>([]) }
})
vi.mock('@renderer/stores/runtime', () => ({
  useRuntimeStore: () => ({ horizontalBrowseDecks: { topSongListData: harness.songs } })
}))
vi.mock('@renderer/composables/horizontalBrowse/horizontalBrowseInteractionTimeline', () => ({
  beginHorizontalBrowseDeckInteraction: vi.fn()
}))

const song = (index: number, filePath = `icloud-song:${index}.wav`): ISongInfo =>
  ({
    filePath,
    fileName: `${index}.wav`,
    title: String(index),
    icloudOrigin: {
      relativePath: `${index}.wav`,
      rootToken: 'root',
      key: `icloud-song:${index}.wav`
    }
  }) as ISongInfo

const setup = () => {
  const topDeckSong = ref<ISongInfo | null>(song(0, '/tmp/0.wav'))
  let playing = true
  const assignSongToDeck = vi.fn(async (_deck: 'top' | 'bottom', next: ISongInfo) => {
    topDeckSong.value = next
    playing = false
  })
  const handleDeckPlayPauseToggle = vi.fn()
  harness.songs.splice(0, harness.songs.length, song(0, '/tmp/0.wav'), song(1), song(2))
  const navigation = useHorizontalBrowseEditDeckNavigation({
    topDeckSong,
    assignSongToDeck,
    handleDeckBeatJump: vi.fn(),
    resolveDeckPlaying: () => playing,
    handleDeckPlayPauseToggle
  })
  return { topDeckSong, assignSongToDeck, handleDeckPlayPauseToggle, navigation }
}

beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  icloudState.value = {
    supported: true,
    visible: true,
    available: true,
    configured: true,
    folder: 'drive',
    rootToken: 'root'
  }
  invoke.mockImplementation(async (channel: string, relative: string) => ({
    ok: true,
    value:
      channel === 'icloud:prepare-play'
        ? `frkb-preview://icloud/?ticket=${encodeURIComponent(relative)}&path=${encodeURIComponent(`/tmp/${relative}`)}`
        : true
  }))
})
afterEach(() => {
  cancelCloudPlayback()
  setIcloudDeckLocalizedHandler(null)
  icloudState.value = null
  harness.songs.splice(0, harness.songs.length)
  vi.unstubAllGlobals()
})

it('downloads only the next cloud song, then loads that local file and keeps the rest logical', async () => {
  const localized = vi.fn()
  setIcloudDeckLocalizedHandler(localized)
  const { assignSongToDeck, handleDeckPlayPauseToggle, navigation } = setup()
  expect(navigation.loadEditAdjacentSong(1)).toBe(true)
  expect(assignSongToDeck).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(assignSongToDeck).toHaveBeenCalledTimes(1))
  expect(assignSongToDeck).toHaveBeenCalledWith(
    'top',
    expect.objectContaining({
      filePath: '/tmp/1.wav',
      icloudOrigin: expect.objectContaining({ relativePath: '1.wav' })
    })
  )
  expect(handleDeckPlayPauseToggle).toHaveBeenCalledWith('top')
  expect(localized).toHaveBeenCalledWith('1.wav', '/tmp/1.wav')
  expect(harness.songs.map((item) => item.filePath)).toEqual([
    '/tmp/0.wav',
    '/tmp/1.wav',
    'icloud-song:2.wav'
  ])
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'icloud:prepare-play')
      .map(([, relative]) => relative)
  ).toEqual(['1.wav'])
  await navigation.loadEditAdjacentSong(1)
  await vi.waitFor(() => expect(assignSongToDeck).toHaveBeenCalledTimes(2))
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'icloud:prepare-play')
      .map(([, relative]) => relative)
  ).toEqual(['1.wav', '2.wav'])
  expect(harness.songs[0].filePath).toBe('/tmp/0.wav')
})

it('loads an already local neighbor immediately and does not assign a cancelled download', async () => {
  const { assignSongToDeck, navigation, topDeckSong } = setup()
  harness.songs.splice(1, 1, song(1, '/tmp/1.wav'))
  expect(navigation.loadEditAdjacentSong(1)).toBe(true)
  expect(assignSongToDeck).toHaveBeenCalledWith(
    'top',
    expect.objectContaining({ filePath: '/tmp/1.wav' })
  )
  expect(invoke).not.toHaveBeenCalled()

  let finish!: (value: unknown) => void
  invoke.mockImplementation((channel: string) =>
    channel === 'icloud:prepare-play'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({ ok: true, value: true })
  )
  topDeckSong.value = song(0, '/tmp/0.wav')
  harness.songs.splice(0, harness.songs.length, song(0, '/tmp/0.wav'), song(1), song(2))
  assignSongToDeck.mockClear()
  expect(navigation.loadEditAdjacentSong(1)).toBe(true)
  cancelCloudPlayback(song(1).filePath)
  finish({ ok: true, value: 'frkb-preview://icloud/?path=%2Ftmp%2F1.wav&ticket=1' })
  await Promise.resolve()
  await Promise.resolve()
  expect(assignSongToDeck).not.toHaveBeenCalled()
  expect(harness.songs[1].filePath).toBe('icloud-song:1.wav')
})

it('does not load the downloaded neighbor after the deck has already moved to another song', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementation((channel: string) =>
    channel === 'icloud:prepare-play'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({ ok: true, value: true })
  )
  const { assignSongToDeck, navigation, topDeckSong } = setup()
  expect(navigation.loadEditAdjacentSong(1)).toBe(true)
  topDeckSong.value = song(8, '/tmp/clicked.wav')
  finish({ ok: true, value: 'frkb-preview://icloud/?path=%2Ftmp%2F1.wav&ticket=1' })
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
  await Promise.resolve()
  expect(assignSongToDeck).not.toHaveBeenCalled()
})
