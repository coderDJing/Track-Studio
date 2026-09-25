import { describe, expect, it } from 'vitest'
import { CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION } from './songStructure'
import {
  hasRequiredSongStructureAnalysis,
  hasUsableCoreSongAnalysis,
  hasUsableKeyAnalysis,
  resolveCanonicalSongBeatGridV2,
  resolveUsableSongBeatGrid
} from './songAnalysisCompleteness'
import {
  createSongBeatGridMapV2FromClips,
  createSongBeatGridMapV2FromFixedGrid
} from './songBeatGridMapV2'

const GRID = { bpm: 128, firstBeatMs: 125, barBeatOffset: 0 }

const createFixedGrid = (downbeatBeatOffset = 0) => {
  const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
    bpm: GRID.bpm,
    firstBeatMs: GRID.firstBeatMs,
    downbeatBeatOffset,
    source: 'analysis'
  })
  if (!beatGridMap) throw new Error('v2 fixed grid fixture failed')
  return beatGridMap
}

const createStructure = (beatGridSignature: string, algorithmVersion: number) => ({
  formatVersion: 2,
  algorithmVersion,
  source: 'algorithmic',
  durationSec: 60,
  beatGridSignature,
  sections: [
    {
      startSec: 0,
      endSec: 60,
      startDownbeatOrdinal: 0,
      endDownbeatOrdinal: 32,
      kind: 'groove',
      confidence: 0.6,
      energy: 0.6,
      low: 0.6,
      high: 0.4,
      novelty: 0.2
    }
  ]
})

describe('song analysis completeness', () => {
  it('treats a valid key and energy score as usable without algorithm versions', () => {
    expect(hasUsableKeyAnalysis({ key: '8A' })).toBe(true)
    expect(
      hasUsableCoreSongAnalysis(
        {
          key: '8A',
          energyScore: 72,
          beatGridMap: createFixedGrid()
        },
        { waveformAvailable: true }
      )
    ).toBe(true)
  })

  it('accepts a valid dynamic v2 grid without a Beat Grid algorithm version', () => {
    const beatGridMap = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0.125, bpm: 128, downbeatBeatOffset: 0 },
        { startSec: 32, anchorSec: 32.25, bpm: 130, downbeatBeatOffset: 0 }
      ],
      'analysis'
    )
    expect(beatGridMap).not.toBeNull()
    expect(resolveUsableSongBeatGrid({ beatGridMap })).toMatchObject({
      kind: 'grid',
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 0
    })
  })

  it('exposes only a canonical v2 grid to new consumers', () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 3,
      source: 'analysis'
    })
    expect(resolveCanonicalSongBeatGridV2({ beatGridMap })).toMatchObject({
      kind: 'grid',
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 3
    })
    expect(resolveCanonicalSongBeatGridV2({ ...GRID, beatGridMap: undefined }).kind).toBe('missing')
  })

  it('prefers a usable grid over a stray no-bpm marker', () => {
    expect(
      resolveUsableSongBeatGrid({ beatGridMap: createFixedGrid(), beatGridStatus: 'no-bpm' }).kind
    ).toBe('grid')
  })

  it('treats no-bpm as a completed grid and does not require structure', () => {
    const info = { key: '8A', energyScore: 50, beatGridStatus: 'no-bpm' }
    expect(resolveUsableSongBeatGrid(info).kind).toBe('no-bpm')
    expect(hasRequiredSongStructureAnalysis(info)).toBe(true)
    expect(
      hasUsableCoreSongAnalysis(info, { includeStructure: true, waveformAvailable: true })
    ).toBe(true)
  })

  it('无 BPM 歌曲不需要无法计算的能量值也算完成', () => {
    expect(
      hasUsableCoreSongAnalysis(
        { key: '8A', beatGridStatus: 'no-bpm' },
        { includeStructure: true, waveformAvailable: true }
      )
    ).toBe(true)
    expect(
      hasUsableCoreSongAnalysis(
        { key: '8A', beatGridMap: createFixedGrid() },
        { waveformAvailable: true }
      )
    ).toBe(false)
  })

  it('keeps a same-grid structure usable across algorithm upgrades', () => {
    const beatGridMap = createFixedGrid()
    const info = {
      key: '8A',
      energyScore: 72,
      beatGridMap,
      songStructure: createStructure(
        beatGridMap.signature,
        CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1
      )
    }
    expect(hasRequiredSongStructureAnalysis(info)).toBe(true)
    expect(
      hasUsableCoreSongAnalysis(info, { includeStructure: true, waveformAvailable: true })
    ).toBe(true)
  })

  it('requires structure replacement when its grid dependency no longer matches', () => {
    const originalGrid = createFixedGrid()
    const info = {
      key: '8A',
      energyScore: 72,
      beatGridMap: createFixedGrid(1),
      songStructure: createStructure(
        originalGrid.signature,
        CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION
      )
    }
    expect(hasRequiredSongStructureAnalysis(info)).toBe(false)
    expect(
      hasUsableCoreSongAnalysis(info, { includeStructure: true, waveformAvailable: true })
    ).toBe(false)
  })

  it('matches dynamic-grid structure by signature across algorithm upgrades', () => {
    const beatGridMap = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0.125, bpm: 128, downbeatBeatOffset: 0 },
        { startSec: 32, anchorSec: 32.25, bpm: 130, downbeatBeatOffset: 0 }
      ],
      'analysis'
    )
    expect(beatGridMap).not.toBeNull()
    const structure = {
      ...createStructure(beatGridMap!.signature, CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1)
    }
    expect(hasRequiredSongStructureAnalysis({ beatGridMap, songStructure: structure })).toBe(true)
    expect(
      hasRequiredSongStructureAnalysis({
        beatGridMap,
        songStructure: { ...structure, beatGridSignature: 'sbgm_changed' }
      })
    ).toBe(false)
  })

  it('still reports a genuinely missing result as incomplete', () => {
    expect(
      hasUsableCoreSongAnalysis(
        {
          key: '8A',
          beatGridMap: createFixedGrid()
        },
        { waveformAvailable: true }
      )
    ).toBe(false)
    expect(
      hasUsableCoreSongAnalysis(
        {
          key: '8A',
          energyScore: 72,
          beatGridMap: createFixedGrid()
        },
        { waveformAvailable: false }
      )
    ).toBe(false)
  })
})
