import { describe, expect, it } from 'vitest'
import type { ISongInfo } from '../types/globals'
import { planSongListMerge } from './playlistViewMerge'
import { createSongListItemComparator } from './songListItemCompare'

const createSong = (): ISongInfo => ({
  filePath: 'C:/Music/song.mp3',
  fileName: 'song.mp3',
  fileFormat: 'MP3',
  cover: null,
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: 320,
  container: 'MPEG',
  key: '8A',
  bpm: 128,
  beatGridSource: 'analysis',
  beatGridAlgorithmVersion: 2,
  timeBasisOffsetMs: 0,
  timeBasisOffsetAlgorithmVersion: 1,
  analysisOnly: false,
  autoFilled: false,
  fileMissing: false
})

const comparator = createSongListItemComparator({
  caseInsensitiveFileName: true,
  caseInsensitiveFilePath: true
})

describe('song list item comparator', () => {
  it('detects analysis and playback fields that change row behavior', () => {
    const left = createSong()
    const right = {
      ...left,
      keyAnalysisAlgorithmVersion: 4,
      timeBasisOffsetMs: 25,
      beatGridSource: 'manual' as const,
      fileMissing: true
    }

    expect(comparator.isEquivalentSongInfo(left, right)).toBe(false)
    expect(comparator.getSongInfoDiffFields(left, right)).toEqual(
      expect.arrayContaining([
        'keyAnalysisAlgorithmVersion',
        'timeBasisOffsetMs',
        'beatGridSource',
        'fileMissing'
      ])
    )
  })

  it('makes merge replace the row when a previously omitted field changes', async () => {
    const current = createSong()
    const next = { ...current, timeBasisOffsetMs: 25 }

    const result = await planSongListMerge({
      current: [current],
      next: [next],
      comparator
    })

    expect(result.changed).toBe(true)
    expect(result.updatedCount).toBe(1)
    expect(result.items[0]).toBe(next)
  })

  it('uses platform case rules while treating slash styles as equivalent', () => {
    const windowsComparator = createSongListItemComparator({
      caseInsensitiveFileName: true,
      caseInsensitiveFilePath: true
    })
    const macComparator = createSongListItemComparator({
      caseInsensitiveFileName: false,
      caseInsensitiveFilePath: false
    })
    const upper = createSong()
    const slashVariant = { ...upper, filePath: 'C:\\Music\\song.mp3' }
    const caseVariant = { ...upper, filePath: 'C:/Music/Song.mp3', fileName: 'Song.mp3' }

    expect(windowsComparator.isEquivalentSongInfo(upper, slashVariant)).toBe(true)
    expect(windowsComparator.isEquivalentSongInfo(upper, caseVariant)).toBe(true)
    expect(macComparator.isEquivalentSongInfo(upper, slashVariant)).toBe(true)
    expect(macComparator.isEquivalentSongInfo(upper, caseVariant)).toBe(false)
  })
})
