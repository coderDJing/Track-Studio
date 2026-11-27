import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { icloudState } from './icloudLibrary'
import { cancelCloudPlayback } from './icloudPlayback'
import {
  resolveWaveformPreviewPlayUrl,
  shouldSkipPcmWaveformPreview,
  toSafePreviewUrl
} from './icloudWaveformPreviewPlayback'
import type { ISongInfo } from 'src/types/globals'

const invoke = vi.fn()
const ticket = 'frkb-preview://icloud/?path=Folder%2Ftrack.wav&ticket=resident'
const song = {
  filePath: 'icloud-song:Folder/track.wav',
  fileName: 'track.wav',
  title: 'track',
  icloudOrigin: {
    relativePath: 'Folder/track.wav',
    rootToken: 'root',
    key: 'icloud-song:Folder/track.wav'
  }
} as ISongInfo

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
  invoke.mockResolvedValue({ ok: true, value: ticket })
})

afterEach(() => {
  cancelCloudPlayback()
  icloudState.value = null
  vi.unstubAllGlobals()
})

it('never wraps a logical iCloud key as a local preview file and keeps ticket URLs', () => {
  expect(toSafePreviewUrl('icloud-song:Folder/track.wav')).toBe('')
  expect(toSafePreviewUrl(ticket)).toBe(ticket)
  expect(toSafePreviewUrl('frkb-preview://icloud/?path=Folder%2Ftrack.wav')).toBe('')
  expect(toSafePreviewUrl('/Music/track.wav')).toBe(
    'frkb-preview://local/?path=' + encodeURIComponent('/Music/track.wav')
  )
  expect(shouldSkipPcmWaveformPreview('icloud-song:Folder/track.wav')).toBe(true)
  expect(shouldSkipPcmWaveformPreview(ticket)).toBe(true)
  expect(shouldSkipPcmWaveformPreview('/Music/track.wav')).toBe(false)
})

it('resolves a resident iCloud song through prepare-play and rejects a raw filesystem path', async () => {
  expect(await resolveWaveformPreviewPlayUrl(song, song.filePath)).toBe(ticket)
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'icloud:prepare-play')
      .map(([, relative]) => relative)
  ).toEqual(['Folder/track.wav'])
  invoke.mockResolvedValue({ ok: true, value: '/tmp/track.wav' })
  expect(await resolveWaveformPreviewPlayUrl(song, song.filePath)).toBe(null)
})

it('does not open a local file when the song is not yet resident, and surfaces cancel or failure', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementation((channel: string) =>
    channel === 'icloud:prepare-play'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({ ok: true, value: true })
  )
  const pending = resolveWaveformPreviewPlayUrl(song, song.filePath)
  expect(invoke.mock.calls.some(([channel]) => channel === 'mixtape:decode-for-transport')).toBe(
    false
  )
  cancelCloudPlayback(song.filePath)
  finish({ ok: true, value: ticket })
  expect(await pending).toBe(null)
  invoke.mockResolvedValue({ ok: false, error: 'timeout' })
  expect(await resolveWaveformPreviewPlayUrl(song, song.filePath)).toBe(null)
  expect(
    await resolveWaveformPreviewPlayUrl({ ...song, icloudOrigin: undefined }, song.filePath)
  ).toBe(null)
  expect(
    await resolveWaveformPreviewPlayUrl(
      { filePath: '/Music/local.wav' } as ISongInfo,
      '/Music/local.wav'
    )
  ).toBe('/Music/local.wav')
})
