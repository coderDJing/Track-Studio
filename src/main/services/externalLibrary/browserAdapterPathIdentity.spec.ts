import { describe, expect, it, vi } from 'vitest'
import { buildSeratoWaveformOverviews } from './browserAdapter'
import type { ExternalLibrarySnapshot } from '../../../shared/externalLibrary'

const state = vi.hoisted(() => ({ platform: 'win32' }))
vi.mock('../../filePathComparison', async (original) => {
  const actual = await original<typeof import('../../filePathComparison')>()
  return {
    ...actual,
    mainFilePathKey: (value: string) => actual.mainFilePathKey(value, state.platform)
  }
})

const overview = Uint8Array.from([1, 5, ...Array.from({ length: 16 }, () => 24)])
const snapshot = (paths: string[]): ExternalLibrarySnapshot => ({
  kind: 'serato',
  rootPath: '/Music',
  libraryPath: '/Music/_Serato_',
  playlists: [],
  warnings: [],
  tracks: paths.map((filePath, index) => ({
    id: String(index),
    filePath,
    cues: [],
    waveformOverview: overview
  }))
})

describe('external waveform source identity', () => {
  it('matches Windows slash and Unicode case aliases', () => {
    state.platform = 'win32'
    const result = buildSeratoWaveformOverviews(snapshot(['G:\\音乐\\Ä Track.mp3']), [
      'g:/音乐/ä track.mp3'
    ])
    expect(result[0].data).toMatchObject({ columnCount: 1, rowCount: 16 })
  })

  it('does not return another macOS file waveform for a case distinct path', () => {
    state.platform = 'darwin'
    const result = buildSeratoWaveformOverviews(snapshot(['/Music/Track.mp3']), [
      '/Music/track.mp3',
      '/Music/Track.mp3'
    ])
    expect(result[0].data).toBeNull()
    expect(result[1].data).toMatchObject({ columnCount: 1 })
  })
})
