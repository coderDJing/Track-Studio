import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromFixedGrid } from '../../../shared/songBeatGridMapV2'
import { CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION } from '../../../shared/songStructure'
import {
  collectFilesNeedingSelectedAnalysis,
  collectMissingAnalysisFilesFromSongs,
  resolveMissingAnalysisReasons,
  songNeedsSelectedMissingAnalysis
} from './manualKeyAnalysisCompleteness'

const FIXED_GRID_V2 = createSongBeatGridMapV2FromFixedGrid({
  bpm: 128,
  firstBeatMs: 125,
  downbeatBeatOffset: 0,
  source: 'analysis'
})

describe('manual key analysis completeness', () => {
  it('treats a missing v23 structure result as pending analysis', () => {
    const filePath = 'D:\\music\\stale-techno.wav'
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath,
          key: '8A',
          keyAnalysisAlgorithmVersion: 1,
          energyScore: 72,
          energyAlgorithmVersion: 1,
          beatGridAlgorithmVersion: 1,
          beatGridMap: FIXED_GRID_V2 ?? undefined
        },
        true,
        { includeSongStructure: true, missingWaveformFilePaths: [] }
      )
    ).toEqual(['missing-song-structure'])
  })

  it('accepts a current v23 structure result bound to the canonical grid', () => {
    const filePath = 'D:\\music\\current-structure.wav'
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath,
          key: '8A',
          energyScore: 72,
          beatGridMap: FIXED_GRID_V2 ?? undefined,
          songStructure: {
            formatVersion: 2,
            algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
            source: 'algorithmic',
            durationSec: 64,
            beatGridSignature: FIXED_GRID_V2?.signature,
            sections: [
              {
                startSec: 0,
                endSec: 64,
                startDownbeatOrdinal: 0,
                endDownbeatOrdinal: 32,
                kind: 'groove',
                confidence: 0.8,
                energy: 0.7,
                low: 0.7,
                high: 0.5,
                novelty: 0.2
              }
            ]
          }
        },
        true,
        { includeSongStructure: true, missingWaveformFilePaths: [] }
      )
    ).toEqual([])
  })

  it('accepts an older complete structure result bound to the same grid', () => {
    const filePath = 'D:\\music\\older-structure.wav'
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath,
          key: '8A',
          energyScore: 72,
          beatGridMap: FIXED_GRID_V2 ?? undefined,
          songStructure: {
            formatVersion: 2,
            algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1,
            source: 'algorithmic',
            durationSec: 64,
            beatGridSignature: FIXED_GRID_V2?.signature,
            sections: [
              {
                startSec: 0,
                endSec: 64,
                startDownbeatOrdinal: 0,
                endDownbeatOrdinal: 32,
                kind: 'groove',
                confidence: 0.8,
                energy: 0.7,
                low: 0.7,
                high: 0.5,
                novelty: 0.2
              }
            ]
          }
        },
        true,
        { includeSongStructure: true, missingWaveformFilePaths: [] }
      )
    ).toEqual([])
  })

  it('reports waveform as the fifth independently missing result', () => {
    const filePath = 'D:\\music\\missing-waveform.wav'
    const song = {
      filePath,
      key: '8A',
      energyScore: 72,
      beatGridMap: FIXED_GRID_V2 ?? undefined
    }
    expect(
      resolveMissingAnalysisReasons(song, true, {
        missingWaveformFilePaths: [filePath]
      })
    ).toEqual(['missing-waveform'])
    expect(
      collectMissingAnalysisFilesFromSongs([song], true, new Set(), {
        missingWaveformFilePaths: [filePath]
      })
    ).toEqual([filePath])
  })

  it('只勾选 Key 时，已有 Key 但缺波形的曲目不再算待分析', () => {
    const filePath = 'D:\\music\\has-key-missing-waveform.wav'
    const song = {
      filePath,
      key: '8A',
      energyScore: 72,
      beatGridMap: FIXED_GRID_V2 ?? undefined
    }
    expect(
      songNeedsSelectedMissingAnalysis(
        song,
        {
          key: true,
          beatGrid: false,
          waveform: false,
          energy: false,
          structure: false
        },
        true,
        { missingWaveformFilePaths: [filePath] }
      )
    ).toBe(false)
    expect(
      songNeedsSelectedMissingAnalysis(
        song,
        {
          key: false,
          beatGrid: false,
          waveform: true,
          energy: false,
          structure: false
        },
        true,
        { missingWaveformFilePaths: [filePath] }
      )
    ).toBe(true)
  })

  it('只勾选 Key 时，路径斜杠不同也仍能按曲目匹配待分析项', () => {
    const song = {
      filePath: 'D:\\music\\slash-key.wav',
      key: undefined,
      energyScore: 72,
      beatGridMap: FIXED_GRID_V2 ?? undefined
    }
    expect(
      collectFilesNeedingSelectedAnalysis(
        [song],
        {
          key: true,
          beatGrid: false,
          waveform: false,
          energy: false,
          structure: false
        },
        true
      )
    ).toEqual(['D:\\music\\slash-key.wav'])
  })

  it('accepts a canonical v2 manual grid without requiring structure by default', () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 0,
      source: 'manual'
    })
    expect(beatGridMap).not.toBeNull()
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath: 'D:\\music\\dynamic.wav',
          key: '8A',
          energyScore: 68,
          beatGridMap
        },
        true
      )
    ).toEqual([])
  })

  it('treats no-bpm as complete without requiring a structure result', () => {
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath: 'D:\\music\\ambient.wav',
          key: '2A',
          energyScore: 20,
          beatGridStatus: 'no-bpm'
        },
        true,
        { includeSongStructure: true }
      )
    ).toEqual([])
  })

  it('does not repeatedly prompt for three analyzed no-bpm tracks without energy results', () => {
    const songs = Array.from({ length: 3 }, (_, index) => ({
      filePath: `D:\\music\\ambient-${index}.wav`,
      key: '2A',
      beatGridStatus: 'no-bpm'
    }))
    expect(
      collectMissingAnalysisFilesFromSongs(songs, true, new Set(), {
        includeSongStructure: true,
        missingWaveformFilePaths: []
      })
    ).toEqual([])
    expect(
      collectFilesNeedingSelectedAnalysis(
        songs,
        { key: false, beatGrid: false, waveform: false, energy: true, structure: false },
        true
      )
    ).toEqual([])
  })

  it('still prompts for missing key and waveform on an analyzed no-bpm track', () => {
    const song = { filePath: 'D:\\music\\ambient-missing.wav', beatGridStatus: 'no-bpm' }
    expect(resolveMissingAnalysisReasons(song, true)).toEqual(['missing-key'])
    expect(
      resolveMissingAnalysisReasons({ ...song, key: '2A' }, true, {
        missingWaveformFilePaths: [song.filePath]
      })
    ).toEqual(['missing-waveform'])
    expect(
      resolveMissingAnalysisReasons(song, true, {
        includeSongStructure: true,
        missingWaveformFilePaths: [song.filePath]
      })
    ).toEqual(['missing-key', 'missing-waveform'])
    expect(
      collectMissingAnalysisFilesFromSongs([song], true, new Set(), {
        missingWaveformFilePaths: [song.filePath]
      })
    ).toEqual([song.filePath])
  })

  it.each([undefined, 'no-bpm'])(
    'requires energy for a valid grid despite status %s',
    (beatGridStatus) => {
      const song = {
        filePath: 'D:\\music\\grid-missing-energy.wav',
        key: '2A',
        beatGridMap: FIXED_GRID_V2,
        beatGridStatus
      }
      expect(resolveMissingAnalysisReasons(song, true)).toEqual(['missing-energy-score'])
      expect(collectMissingAnalysisFilesFromSongs([song], true)).toEqual([song.filePath])
    }
  )

  it('keeps a missing Beat Grid incomplete even when the runtime is unavailable', () => {
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath: 'D:\\music\\runtime-missing.wav',
          key: '2A',
          energyScore: 20
        },
        false,
        { includeSongStructure: true }
      )
    ).toEqual(['missing-bpm', 'missing-first-beat', 'missing-downbeat-beat-offset'])
  })
})
