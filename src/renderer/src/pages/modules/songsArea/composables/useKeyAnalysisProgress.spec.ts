import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import { hasCompleteKeyAnalysis, useKeyAnalysisProgress } from './useKeyAnalysisProgress'

const songFor = (index: number, fields: Partial<ISongInfo> = {}): ISongInfo => ({
  filePath: `D:\\music\\ambient-${index}.wav`,
  fileName: `ambient-${index}.wav`,
  fileFormat: 'wav',
  cover: null,
  title: undefined,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
  key: '2A',
  beatGridStatus: 'no-bpm',
  ...fields
})

describe('visible song analysis completeness', () => {
  it('does not show pending analysis for three no-bpm tracks without energy or structure', () => {
    const songs = Array.from({ length: 3 }, (_, index) => songFor(index))
    const progress = useKeyAnalysisProgress({
      visibleSongsWithIndex: ref(songs.map((song, idx) => ({ song, idx }))),
      requiresRuntimeAnalysis: ref(true)
    })
    for (const song of songs) {
      expect(hasCompleteKeyAnalysis(song)).toBe(true)
      expect(progress.isSongNeedsAnalysis(song.filePath)).toBe(false)
      expect(progress.getAnalysisProgress(song.filePath)).toBeNull()
    }
  })

  it('still shows missing key on a no-bpm track', () => {
    const song = songFor(0, { key: undefined })
    const progress = useKeyAnalysisProgress({
      visibleSongsWithIndex: ref([{ song, idx: 0 }]),
      requiresRuntimeAnalysis: ref(true)
    })
    expect(hasCompleteKeyAnalysis(song)).toBe(false)
    expect(progress.isSongNeedsAnalysis(song.filePath)).toBe(true)
  })

  it.each([undefined, 'no-bpm'] as const)(
    'still requires energy for a valid grid despite status %s',
    (beatGridStatus) => {
      const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
        bpm: 128,
        firstBeatMs: 125,
        downbeatBeatOffset: 0,
        source: 'analysis'
      })
      expect(beatGridMap).not.toBeNull()
      const song = songFor(0, { beatGridMap: beatGridMap ?? undefined, beatGridStatus })
      const progress = useKeyAnalysisProgress({
        visibleSongsWithIndex: ref([{ song, idx: 0 }])
      })
      expect(hasCompleteKeyAnalysis(song)).toBe(false)
      expect(progress.isSongNeedsAnalysis(song.filePath)).toBe(true)
    }
  )
})
