import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromFixedGrid } from './songBeatGridMapV2'
import {
  DEFAULT_TRACK_REANALYSIS_SELECTION,
  applyTrackReanalysisSelectionDependencies,
  canSelectStructureAloneFromSongs,
  isFullTrackReanalysisPlan,
  isTrackReanalysisBeatGridLocked,
  normalizeTrackReanalysisSelection,
  resolveTrackReanalysisPlan
} from './trackReanalysisSelection'

describe('trackReanalysisSelection', () => {
  it('缺省和全空值都回退到五项全选', () => {
    expect(normalizeTrackReanalysisSelection(undefined)).toEqual(DEFAULT_TRACK_REANALYSIS_SELECTION)
    expect(
      normalizeTrackReanalysisSelection({
        key: false,
        beatGrid: false,
        waveform: false,
        energy: false,
        structure: false
      })
    ).toEqual(DEFAULT_TRACK_REANALYSIS_SELECTION)
  })

  it('已有网格时允许只勾段落', () => {
    const selection = normalizeTrackReanalysisSelection({
      key: false,
      beatGrid: false,
      waveform: false,
      energy: false,
      structure: true
    })
    expect(selection.structure).toBe(true)
    expect(resolveTrackReanalysisPlan(selection)).toEqual({
      key: false,
      beatGrid: false,
      waveform: false,
      energy: false,
      structure: true
    })
    expect(applyTrackReanalysisSelectionDependencies(selection, true)).toMatchObject({
      beatGrid: false,
      structure: true
    })
  })

  it('勾选段落会锁定网格；没有已有网格时会一起勾选网格', () => {
    expect(
      applyTrackReanalysisSelectionDependencies(
        {
          key: false,
          beatGrid: false,
          waveform: false,
          energy: false,
          structure: true
        },
        false
      )
    ).toMatchObject({ beatGrid: true, structure: true })
    expect(
      isTrackReanalysisBeatGridLocked(
        {
          key: false,
          beatGrid: false,
          waveform: false,
          energy: false,
          structure: true
        },
        false
      )
    ).toBe(true)
    expect(
      isTrackReanalysisBeatGridLocked(
        {
          key: false,
          beatGrid: false,
          waveform: false,
          energy: false,
          structure: true
        },
        true
      )
    ).toBe(false)
    expect(
      resolveTrackReanalysisPlan({
        key: false,
        beatGrid: true,
        waveform: false,
        energy: false,
        structure: false
      }).structure
    ).toBe(false)
  })

  it('勾选能量会始终关联并锁定网格分析', () => {
    const selection = {
      key: false,
      beatGrid: false,
      waveform: false,
      energy: true,
      structure: false
    }
    expect(applyTrackReanalysisSelectionDependencies(selection, true)).toMatchObject({
      beatGrid: true,
      energy: true
    })
    expect(isTrackReanalysisBeatGridLocked(selection, true)).toBe(true)
    expect(
      resolveTrackReanalysisPlan(applyTrackReanalysisSelectionDependencies(selection, true))
    ).toMatchObject({ beatGrid: true, energy: true })
  })

  it('只勾波形不会连带网格或段落', () => {
    expect(
      applyTrackReanalysisSelectionDependencies(
        {
          key: false,
          beatGrid: false,
          waveform: true,
          energy: false,
          structure: false
        },
        false
      )
    ).toMatchObject({ beatGrid: false, waveform: true, structure: false })
  })

  it('只根据实际要重算的曲目判断能否单独勾选段落', () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 0,
      downbeatBeatOffset: 0,
      source: 'manual'
    })
    if (!beatGridMap) throw new Error('v2 grid fixture failed')
    const withGrid = {
      filePath: 'D:/library/a.wav',
      beatGridMap
    }
    const withoutGrid = { filePath: 'D:/library/b.wav' }
    expect(canSelectStructureAloneFromSongs([withGrid, withoutGrid], ['D:/library/b.wav'])).toBe(
      false
    )
    expect(canSelectStructureAloneFromSongs([withGrid, withoutGrid], ['D:/library/a.wav'])).toBe(
      true
    )
    expect(
      canSelectStructureAloneFromSongs(
        [withGrid, withoutGrid],
        ['D:/library/a.wav', 'D:/library/b.wav']
      )
    ).toBe(false)
  })

  it('四项分析加段落都选中才视为完整重算', () => {
    expect(
      isFullTrackReanalysisPlan(resolveTrackReanalysisPlan(DEFAULT_TRACK_REANALYSIS_SELECTION))
    ).toBe(true)
    expect(
      isFullTrackReanalysisPlan(
        resolveTrackReanalysisPlan({
          key: true,
          beatGrid: true,
          waveform: true,
          energy: false,
          structure: true
        })
      )
    ).toBe(false)
  })
})
