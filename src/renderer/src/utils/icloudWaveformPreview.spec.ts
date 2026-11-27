import { afterEach, expect, it, vi } from 'vitest'
import { rememberIcloudAnalysisPath } from './icloudAnalysisRows'
import {
  isIcloudWaveformPath,
  loadIcloudPlayerWaveform,
  loadIcloudWaveformPreviewBatch,
  readIcloudSongListWaveform,
  registerIcloudWaveformPreviewLoader,
  toPlayerCompactWaveform
} from './icloudWaveformPreview'
import { loadWaveformPreviewBatch } from '@renderer/pages/modules/songsArea/SongListRows/loadWaveformPreviewBatch'
import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'

const preview = (peak = 9): WaveformListPreviewData =>
  ({
    surfaceKind: 'listPreview',
    version: 1,
    parameterVersion: 1,
    duration: 2,
    sampleRate: 8000,
    detailRate: 256,
    overviewRate: 256,
    bodyRateDivisor: 1,
    colorRateDivisor: 1,
    detailPeakTop: new Uint8Array(512).fill(peak),
    detailPeakBottom: new Uint8Array(512),
    detailBody: new Uint8Array(512),
    colorIndex: new Uint8Array(512),
    colorLow: new Uint8Array(512),
    colorMid: new Uint8Array(512),
    colorHigh: new Uint8Array(512),
    colorRed: new Uint8Array(512),
    colorGreen: new Uint8Array(512),
    colorBlue: new Uint8Array(512),
    overviewTop: new Uint8Array(512),
    overviewBottom: new Uint8Array(512)
  }) as WaveformListPreviewData

afterEach(() => {
  registerIcloudWaveformPreviewLoader(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('routes only iCloud keys through the safe loader and never calls the library-root cache IPC', async () => {
  const invoke = vi.fn()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  const read = vi.fn(async () => preview(11))
  registerIcloudWaveformPreviewLoader({
    resolve: (filePath) =>
      filePath === 'icloud-song:resident.wav' ? { relative: 'resident.wav', token: 'tok' } : null,
    read,
    cancel: vi.fn()
  })
  const items = await loadWaveformPreviewBatch(
    [
      'icloud-song:resident.wav',
      'icloud-song:cloud.wav',
      'frkb-preview://icloud/?path=%2Ftmp%2Fresident.wav&ticket=1'
    ],
    () => '/library/root'
  )
  expect(items).not.toBeNull()
  if (!items) throw new Error('expected preview items')
  expect(read).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledWith('resident.wav', 'tok', expect.any(String))
  expect(invoke).not.toHaveBeenCalled()
  expect(items).toEqual([
    {
      filePath: 'icloud-song:resident.wav',
      data: expect.objectContaining({ surfaceKind: 'listPreview' })
    },
    { filePath: 'icloud-song:cloud.wav', data: null },
    { filePath: 'frkb-preview://icloud/?path=%2Ftmp%2Fresident.wav&ticket=1', data: null }
  ])
  expect(items[0]?.data?.detailPeakTop[0]).toBe(11)
})

it('drops expired and cancelled responses instead of applying a late preview', async () => {
  let release!: (value: WaveformListPreviewData) => void
  const pending = new Promise<WaveformListPreviewData>((resolve) => {
    release = resolve
  })
  const cancel = vi.fn()
  registerIcloudWaveformPreviewLoader({
    resolve: () => ({ relative: 'resident.wav', token: 'tok' }),
    read: () => pending,
    cancel
  })
  const request = loadIcloudWaveformPreviewBatch(['icloud-song:resident.wav'])
  registerIcloudWaveformPreviewLoader(null)
  release(preview(15))
  expect(await request).toEqual([{ filePath: 'icloud-song:resident.wav', data: null }])
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('gives the main player the list-preview peaks for the song that is already playing', async () => {
  const read = vi.fn(async () => preview(40))
  registerIcloudWaveformPreviewLoader({
    resolve: () => null,
    read,
    cancel: vi.fn()
  })
  const song = {
    filePath: 'frkb-preview://icloud/?path=Folder%2Ftrack.wav&ticket=playing',
    icloudOrigin: {
      relativePath: 'Folder/track.wav',
      rootToken: 'root',
      key: 'icloud-song:Folder/track.wav'
    }
  }
  const data = await loadIcloudPlayerWaveform(song)
  expect(read).toHaveBeenCalledWith('Folder/track.wav', 'root', expect.any(String))
  expect(data?.detailPeakTop[0]).toBe(40)
  expect(data).not.toHaveProperty('surfaceKind')
  expect(
    await loadIcloudPlayerWaveform({ ...song, filePath: 'icloud-song:Folder/track.wav' })
  ).toBe(null)
  expect(read).toHaveBeenCalledTimes(1)
})

it('returns no player waveform when the preview has no peaks', () => {
  expect(toPlayerCompactWaveform(null)).toBeNull()
  expect(toPlayerCompactWaveform({ ...preview(), detailPeakTop: new Uint8Array() })).toBeNull()
})

it('shows the analyzed waveform in the list column instead of the wav-only preview', async () => {
  const invoke = vi.fn(async (channel: string): Promise<unknown> =>
    channel === 'waveform-list-preview-cache:load' ? { status: 'ready', data: preview(21) } : null
  )
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  const paths = new Map<string, string>()
  rememberIcloudAnalysisPath(paths, '/tmp/Track.mp3', 'Track.mp3')
  const data = await readIcloudSongListWaveform(paths, 'Track.mp3', 'tok', 'id')
  expect(data?.detailPeakTop[0]).toBe(21)
  expect(invoke).toHaveBeenCalledTimes(1)
  invoke.mockImplementation(async (channel: string) =>
    channel === 'icloud:waveform-preview' ? { ok: true, value: preview(4) } : null
  )
  const fallback = await readIcloudSongListWaveform(new Map(), 'Track.mp3', 'tok', 'id')
  expect(fallback?.detailPeakTop[0]).toBe(4)
})
it('classifies iCloud logical keys and playback tickets, but not ordinary library paths', () => {
  expect(isIcloudWaveformPath('icloud-song:a.wav')).toBe(true)
  expect(isIcloudWaveformPath('frkb-preview://icloud/?ticket=1')).toBe(true)
  expect(isIcloudWaveformPath('/Users/me/Music/song.wav')).toBe(false)
})
