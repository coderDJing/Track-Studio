import { describe, expect, it } from 'vitest'
import type { ISongInfo } from '../../types/globals'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'
import { prepareFullMetadataCacheInfo, preserveCachedGridAnalysisFields } from './scanSongs'

const createGrid = () => {
  const grid = createSongBeatGridMapV2FromFixedGrid({
    bpm: 134,
    firstBeatMs: 426.807,
    downbeatBeatOffset: 0,
    source: 'analysis'
  })
  if (!grid) throw new Error('grid fixture creation failed')
  return grid
}

const createSong = (): ISongInfo => ({
  filePath: 'D:/music/dhea.mp3',
  fileName: 'dhea.mp3',
  fileFormat: 'MP3',
  cover: null,
  title: 'DHEA',
  artist: undefined,
  album: undefined,
  duration: '06:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined
})

describe('preserveCachedGridAnalysisFields', () => {
  it('keeps grid time basis and algorithm version when an analysis-only song is scanned', () => {
    const target = createSong()
    const cached: ISongInfo = {
      ...createSong(),
      analysisOnly: true,
      beatGridMap: createGrid(),
      timeBasisOffsetMs: 25.057,
      timeBasisOffsetAlgorithmVersion: 1,
      beatGridAlgorithmVersion: 9
    }

    preserveCachedGridAnalysisFields(target, cached)

    expect(target.beatGridMap).toEqual(cached.beatGridMap)
    expect(target.timeBasisOffsetMs).toBe(25.057)
    expect(target.timeBasisOffsetAlgorithmVersion).toBe(1)
    expect(target.beatGridAlgorithmVersion).toBe(9)
  })

  it('does not replace a fresh grid time basis with an older cached value', () => {
    const target: ISongInfo = {
      ...createSong(),
      beatGridMap: createGrid(),
      timeBasisOffsetMs: 0,
      beatGridAlgorithmVersion: 10
    }
    const cached: ISongInfo = {
      ...createSong(),
      beatGridMap: createGrid(),
      timeBasisOffsetMs: 25.057,
      beatGridAlgorithmVersion: 9
    }

    preserveCachedGridAnalysisFields(target, cached)

    expect(target.timeBasisOffsetMs).toBe(0)
    expect(target.beatGridAlgorithmVersion).toBe(10)
  })

  it('does not attach a cached offset version to a different target offset', () => {
    const target: ISongInfo = {
      ...createSong(),
      beatGridMap: createGrid(),
      timeBasisOffsetMs: 0
    }
    const cached: ISongInfo = {
      ...createSong(),
      beatGridMap: createGrid(),
      timeBasisOffsetMs: 25.057,
      timeBasisOffsetAlgorithmVersion: 1
    }

    preserveCachedGridAnalysisFields(target, cached)

    expect(target.timeBasisOffsetMs).toBe(0)
    expect(target.timeBasisOffsetAlgorithmVersion).toBeUndefined()
  })
})

describe('prepareFullMetadataCacheInfo', () => {
  it('turns an analysis-only cache entry into a regular cache hit after metadata parsing', () => {
    const cached: ISongInfo = {
      ...createSong(),
      analysisOnly: true,
      key: '8A',
      beatGridMap: createGrid(),
      energyScore: 74,
      energyAlgorithmVersion: 1
    }

    const result = prepareFullMetadataCacheInfo(createSong(), cached, true)

    expect(result.analysisOnly).toBe(false)
    expect(result.key).toBe('8A')
    expect(result.beatGridMap).toEqual(cached.beatGridMap)
    expect(result.energyScore).toBe(74)
  })
})
