import { describe, expect, it } from 'vitest'
import type { ISongInfo } from '../../../types/globals'
import { getSongListFieldDisplayValue, getSongListFieldRawValue } from './songListFieldDisplay'

const buildSong = (): ISongInfo => ({
  filePath: 'D:\\music\\track.mp3',
  fileName: 'track.mp3',
  fileFormat: 'MP3',
  cover: null,
  title: 'Track',
  artist: 'Artist',
  album: undefined,
  duration: '03:30',
  genre: undefined,
  label: undefined,
  bitrate: 320,
  container: 'MPEG',
  energyScore: 74,
  energyAlgorithmVersion: 6,
  energyAnalysis: {
    version: 6,
    model: 'musicnn-deam-emomusic-acoustic-v6',
    sustainedScore: 74,
    averageScore: 68,
    medianScore: 67,
    peakScore: 91,
    rangeScore: 42,
    confidence: 73,
    patchCount: 32,
    danceabilityScore: 90,
    dancefloorScore: 71,
    dropScore: 0,
    breakdownScore: 35,
    rhythmicScore: 82
  }
})

const displayOptions = {
  keyDisplayStyle: 'Camelot' as const,
  isDesktopRekordboxSong: false
}

describe('songListFieldDisplay energy detail columns', () => {
  it('reads detailed scores from nested energy analysis', () => {
    const song = buildSong()

    expect(getSongListFieldRawValue(song, 'dancefloorScore')).toBe(71)
    expect(getSongListFieldDisplayValue(song, 'danceabilityScore', displayOptions)).toBe(90)
  })

  it('keeps a zero diagnostic score visible', () => {
    expect(getSongListFieldDisplayValue(buildSong(), 'dropScore', displayOptions)).toBe(0)
  })

  it('leaves unavailable v5-only diagnostics blank', () => {
    const song = buildSong()
    song.energyAlgorithmVersion = 5
    song.energyAnalysis = {
      version: 5,
      model: 'musicnn-deam-emomusic',
      sustainedScore: 72,
      averageScore: 68,
      medianScore: 67,
      peakScore: 90,
      rangeScore: 40,
      confidence: 70,
      patchCount: 32
    }

    expect(getSongListFieldDisplayValue(song, 'dancefloorScore', displayOptions)).toBe('')
    expect(getSongListFieldDisplayValue(song, 'peakScore', displayOptions)).toBe(90)
  })
})
