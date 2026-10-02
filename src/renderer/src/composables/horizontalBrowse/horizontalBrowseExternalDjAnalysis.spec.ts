import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from 'src/types/globals'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import { mergeHorizontalBrowseSongWithSharedGrid } from './horizontalBrowseShellSongs'
import {
  queueHorizontalBrowseDeckAnalysis,
  resolveExternalDjAnalysisTargets
} from './horizontalBrowseExternalDjAnalysis'
import { isHorizontalBrowseNativeDetailSong } from './loadHorizontalBrowseNativeDetailWaveform'

const makeSong = (kind: 'serato' | 'traktor'): ISongInfo => ({
  filePath: 'C:/Music/Track.mp3',
  fileName: 'Track.mp3',
  fileFormat: 'MP3',
  duration: '03:00',
  cover: null,
  title: 'Track',
  artist: '',
  album: '',
  genre: '',
  label: '',
  bitrate: undefined,
  container: undefined,
  externalLibraryKind: kind
})

describe('external DJ deck waveform analysis', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(['serato', 'traktor'] as const)(
    'analyzes %s waveforms while keeping its native grid',
    (kind) => {
      const grid = createSongBeatGridMapV2FromFixedGrid({
        bpm: 135,
        firstBeatMs: 125,
        downbeatBeatOffset: 0,
        source: kind
      })!
      const song = { ...makeSong(kind), beatGridMap: grid, bpm: 135, timeBasisOffsetMs: 26.122 }
      const send = vi.fn()
      vi.stubGlobal('window', { electron: { ipcRenderer: { send } } })
      queueHorizontalBrowseDeckAnalysis('top', song)
      expect(send).toHaveBeenCalledWith(
        'key-analysis:queue-playing',
        expect.objectContaining({
          filePath: song.filePath,
          analysisTargets: { waveform: true, bpm: false }
        })
      )
      expect(isHorizontalBrowseNativeDetailSong(song)).toBe(false)
      expect(resolveExternalDjAnalysisTargets(makeSong(kind))).toEqual({
        waveform: true,
        bpm: true
      })
      // Cached FRKB grid data may arrive alongside a waveform update; it must not replace the source grid.
      vi.stubGlobal('navigator', { platform: 'Win32' })
      const updated = mergeHorizontalBrowseSongWithSharedGrid(song, {
        filePath: song.filePath,
        timeBasisOffsetMs: 0,
        beatGridMap: createSongBeatGridMapV2FromFixedGrid({ bpm: 120, source: 'analysis' })
      })
      expect(updated.beatGridMap?.signature).toBe(grid.signature)
      expect(updated.bpm).toBe(135)
      expect(updated.timeBasisOffsetMs).toBe(26.122)
    }
  )

  it('keeps Rekordbox on its native detail reader', () => {
    const song = {
      ...makeSong('traktor'),
      externalLibraryKind: undefined,
      externalSourceKind: 'desktop' as const
    }
    const send = vi.fn()
    vi.stubGlobal('window', { electron: { ipcRenderer: { send } } })
    queueHorizontalBrowseDeckAnalysis('top', song)
    expect(send).not.toHaveBeenCalled()
    expect(isHorizontalBrowseNativeDetailSong(song)).toBe(true)
  })
})
