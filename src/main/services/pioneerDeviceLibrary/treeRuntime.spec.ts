import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachPioneerPlaylistRuntime } from './tree'
import { readPioneerBeatGridsInWorker, readPioneerCuesInWorker } from './workerPool'
import type { IPioneerPlaylistTrack } from '../../../types/globals'

vi.mock('../../log', () => ({ log: { error: vi.fn() } }))
vi.mock('./deviceDetection', () => ({ probePioneerDeviceLibraryRoot: vi.fn() }))
vi.mock('./oneLibraryDb', () => ({
  OneLibraryPlaylistNotFoundError: class extends Error {},
  readOneLibraryPlaylistTracks: vi.fn(),
  readOneLibraryPlaylistTree: vi.fn()
}))
vi.mock('../fileExistenceCheck', () => ({
  markMissingFiles: vi.fn(),
  applyMissingFileFlags: (tracks: IPioneerPlaylistTrack[]) => tracks
}))
vi.mock('../audioTimeBasisOffset', () => ({
  resolveAudioTimeBasisOffsetMsForFile: vi.fn(),
  resolveAudioTimeBasisOffsetMsForFiles: vi.fn()
}))
vi.mock('./workerPool', () => ({
  readPioneerBeatGridsInWorker: vi.fn(),
  readPioneerCuesInWorker: vi.fn(),
  readPioneerPlaylistAnlzInWorker: vi.fn(),
  readPioneerPlaylistTracksInWorker: vi.fn(),
  readPioneerPlaylistTreeInWorker: vi.fn()
}))

const makeTrack = (): IPioneerPlaylistTrack => ({
  rowKey: 'pioneer:11:1:1',
  playlistId: 11,
  playlistName: 'Fixture',
  trackId: 1,
  entryIndex: 1,
  title: 'Fixture track',
  artist: '',
  album: '',
  label: '',
  genre: '',
  filePath: 'E:\\Contents\\1.mp3',
  fileName: '1.mp3',
  fileFormat: 'MP3',
  container: 'MP3',
  duration: '03:00',
  durationSec: 180,
  analyzePath: '/PIONEER/USBANLZ/1/ANLZ0000.DAT',
  hotCues: [{ slot: 0, sec: 99, comment: 'Stale cached cue' }],
  memoryCues: [{ sec: 100 }]
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readPioneerBeatGridsInWorker).mockResolvedValue({ total: 1 })
})

describe('strict cue runtime attachment', () => {
  it('does not continue with grid hydration when the cue worker fails', async () => {
    vi.mocked(readPioneerCuesInWorker).mockRejectedValue(new Error('worker crashed'))
    await expect(
      attachPioneerPlaylistRuntime('E:\\', [makeTrack()], {
        includeCues: true,
        requireCues: true
      })
    ).rejects.toThrow('worker crashed')
    expect(readPioneerBeatGridsInWorker).not.toHaveBeenCalled()
  })

  it('keeps confirmed empty cues after grid hydration', async () => {
    vi.mocked(readPioneerCuesInWorker).mockImplementation(async (paths, progress) => {
      progress?.({ analyzeFilePath: paths[0], dump: { hotCues: [], memoryCues: [] } })
      return { total: 1 }
    })
    const result = await attachPioneerPlaylistRuntime('E:\\', [makeTrack()], {
      includeCues: true,
      requireCues: true
    })
    expect(result[0]).toMatchObject({ hotCues: [], memoryCues: [] })
    expect(readPioneerBeatGridsInWorker).toHaveBeenCalledOnce()
  })
})
