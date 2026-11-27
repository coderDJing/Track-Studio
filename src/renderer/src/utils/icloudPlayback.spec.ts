import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { icloudState } from './icloudLibrary'
import {
  prepareCloudPlayback,
  cancelCloudPlayback,
  cloudPlaybackStates,
  icloudDeckForBrowseMode,
  buildIcloudDeckLoad,
  materializeIcloudDeckSong,
  setIcloudDeckLocalizedHandler
} from './icloudPlayback'
import { usePlayerQueueNavigation } from '@renderer/pages/modules/songPlayer/usePlayerQueueNavigation'
import type { ISongInfo } from 'src/types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'
const invoke = vi.fn()
const row = (index: number) =>
  ({
    filePath: `icloud-song:${index}.wav`,
    fileName: `${index}.wav`,
    title: String(index),
    icloudOrigin: {
      relativePath: `${index}.wav`,
      rootToken: 'root',
      key: `icloud-song:${index}.wav`
    }
  }) as ISongInfo
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
        ? `frkb-preview://icloud/song?ticket=${relative}&path=${relative}`
        : true
  }))
})
afterEach(() => {
  cancelCloudPlayback()
  icloudState.value = null
  vi.unstubAllGlobals()
})
it('keeps the complete logical queue and localizes only the chosen next/previous track; natural-end next uses the identical path', async () => {
  const first = await prepareCloudPlayback(row(0))
  const runtime = {
    mainWindowBrowseMode: 'browser',
    playingData: { playingSong: first, playingSongListData: [first, row(1), row(2)] },
    setting: {},
    playerReady: true,
    isSwitchingSong: false
  } as unknown as ReturnType<typeof useRuntimeStore>
  const load = vi.fn(),
    controls = usePlayerQueueNavigation({
      runtime,
      audioPlayer: ref(null),
      isInternalSongChange: ref(false),
      requestLoadSong: load
    })
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'icloud:prepare-play')
      .map(([, relative]) => relative)
  ).toEqual(['0.wav'])
  await controls.nextSong()
  expect(runtime.playingData.playingSong?.icloudOrigin?.relativePath).toBe('1.wav')
  expect(load).toHaveBeenCalledTimes(1)
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'icloud:prepare-play')
      .map(([, relative]) => relative)
  ).toEqual(['0.wav', '1.wav'])
  expect(runtime.playingData.playingSongListData[2].filePath).toBe('icloud-song:2.wav')
  await controls.previousSong()
  expect(runtime.playingData.playingSong?.icloudOrigin?.relativePath).toBe('0.wav')
})
it('does not resume cancelled, stale-root, failed or superseded downloads and reports mode limitation without switching it', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementation((channel: string) =>
    channel === 'icloud:prepare-play'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({ ok: true, value: true })
  )
  const pending = prepareCloudPlayback(row(0))
  cancelCloudPlayback(row(0).filePath)
  finish({ ok: true, value: 'late' })
  expect(await pending).toBe(null)
  expect(cloudPlaybackStates.value[row(0).filePath]).toMatchObject({
    state: 'failed',
    error: 'cancelled'
  })
  expect(
    await prepareCloudPlayback({
      ...row(1),
      icloudOrigin: { ...row(1).icloudOrigin!, rootToken: 'old' }
    })
  ).toBe(null)
  const count = invoke.mock.calls.length
  expect(await prepareCloudPlayback(row(2), 'dj')).toBe(null)
  expect(invoke.mock.calls).toHaveLength(count)
  expect(cloudPlaybackStates.value[row(2).filePath].error).toBe('playbackMode')
  invoke.mockResolvedValue({ ok: false, error: 'timeout' })
  expect(await prepareCloudPlayback(row(1))).toBe(null)
  expect(cloudPlaybackStates.value[row(1).filePath]).toMatchObject({
    state: 'failed',
    error: 'timeout'
  })
})
it('downloads one undownloaded edit-queue song and leaves an already local file untouched', async () => {
  const localized = vi.fn()
  setIcloudDeckLocalizedHandler(localized)
  const cloud = row(3)
  const ready = await materializeIcloudDeckSong(cloud)
  expect(ready?.filePath).toBe('3.wav')
  expect(ready?.icloudOrigin?.relativePath).toBe('3.wav')
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'icloud:prepare-play')
      .map(([, relative]) => relative)
  ).toEqual(['3.wav'])
  invoke.mockClear()
  const local = { ...row(4), filePath: '/tmp/4.wav' }
  expect(await materializeIcloudDeckSong(local)).toBe(local)
  expect(invoke).not.toHaveBeenCalled()
  expect(localized).not.toHaveBeenCalled()
  setIcloudDeckLocalizedHandler(null)
})
it('does not hand the edit deck a cancelled download or a ticket with no local path', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementation((channel: string) =>
    channel === 'icloud:prepare-play'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({ ok: true, value: true })
  )
  const pending = materializeIcloudDeckSong(row(5))
  cancelCloudPlayback(row(5).filePath)
  finish({ ok: true, value: 'frkb-preview://icloud/?path=%2Ftmp%2F5.wav&ticket=1' })
  expect(await pending).toBeNull()
  invoke.mockResolvedValue({
    ok: true,
    value: 'frkb-preview://icloud/?ticket=1'
  })
  expect(await materializeIcloudDeckSong(row(6))).toBeNull()
  expect(cloudPlaybackStates.value[row(6).filePath]).toMatchObject({
    state: 'failed',
    error: 'failed'
  })
})
it('uses the same deck gesture as the rest of the library and hands the deck a local file', async () => {
  expect(await prepareCloudPlayback(row(1), 'horizontal')).toMatchObject({
    filePath: expect.stringContaining('frkb-preview://icloud/')
  })
  expect(invoke).toHaveBeenCalledWith(
    'icloud:prepare-play',
    '1.wav',
    expect.objectContaining({ rootToken: 'root' })
  )
  expect(icloudDeckForBrowseMode('browser', true)).toBeNull()
  expect(icloudDeckForBrowseMode('horizontal', false)).toBe('top')
  expect(icloudDeckForBrowseMode('horizontal', true)).toBe('bottom')
  expect(icloudDeckForBrowseMode('edit', true)).toBe('top')
  const ready = {
    ...row(0),
    filePath: 'frkb-preview://icloud/?path=%2Ftmp%2Fa.wav&ticket=1'
  }
  const loaded = buildIcloudDeckLoad(ready, [row(0), row(1)], row(0).filePath)
  expect(loaded?.song.filePath).toBe('/tmp/a.wav')
  expect(loaded?.queue.map((song) => song.filePath)).toEqual(['/tmp/a.wav', row(1).filePath])
})
it('an asynchronous queue transition cannot replace a new local playback intent', async () => {
  const first = await prepareCloudPlayback(row(0))
  let finish!: (value: unknown) => void
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const runtime = {
      mainWindowBrowseMode: 'browser',
      playingData: { playingSong: first, playingSongListData: [first, row(1)] },
      setting: {},
      playerReady: true,
      isSwitchingSong: false
    } as unknown as ReturnType<typeof useRuntimeStore>,
    load = vi.fn()
  const controls = usePlayerQueueNavigation({
      runtime,
      audioPlayer: ref(null),
      isInternalSongChange: ref(false),
      requestLoadSong: load
    }),
    pending = controls.nextSong()
  const local = { ...row(8), filePath: '/temporary-local.wav', icloudOrigin: undefined }
  runtime.playingData.playingSong = local
  finish({ ok: true, value: 'frkb-preview://icloud/song?ticket=1&path=1.wav' })
  await pending
  expect(runtime.playingData.playingSong).toBe(local)
  expect(load).not.toHaveBeenCalled()
})
