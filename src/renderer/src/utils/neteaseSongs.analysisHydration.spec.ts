import { describe, expect, it } from 'vitest'
import {
  applyNeteaseAnalysisToSong,
  mapNeteaseDownloadedRowToSongInfo,
  mapNeteaseTrackToSongInfo
} from './neteaseSongs'
import { buildNeteasePreviewUrl } from '@shared/netease'
import type { ISongInfo } from '../../../types/globals'

const analysis = {
  key: '8A',
  beatGridMap: { signature: 'grid-1' } as ISongInfo['beatGridMap'],
  energyScore: 6
}

describe('mapNeteaseTrackToSongInfo analysis hydration', () => {
  it('keeps the preview filePath and attaches local analysis fields for a downloaded track', () => {
    const song = mapNeteaseTrackToSongInfo({
      songId: '1901371647',
      title: 'Demo',
      artist: 'Artist',
      album: 'Album',
      durationMs: 180000,
      coverUrl: '',
      position: 0,
      downloaded: true,
      localPath: 'E:/lib/library/NeteaseLibrary/.store/1901371647.flac',
      listRoot: 'E:/lib/library/NeteaseLibrary',
      analysis
    })
    expect(song.filePath).toBe(buildNeteasePreviewUrl('1901371647'))
    expect(song.neteaseLocalPath).toBe('E:/lib/library/NeteaseLibrary/.store/1901371647.flac')
    expect(song.waveformPreviewListRoot).toBe('E:/lib/library/NeteaseLibrary')
    expect(song.key).toBe('8A')
    expect(song.energyScore).toBe(6)
    expect(song.beatGridMap?.signature).toBe('grid-1')
  })

  it('leaves analysis columns empty when the track is not downloaded', () => {
    const song = mapNeteaseTrackToSongInfo({
      songId: '99',
      title: 'Stream',
      artist: 'Artist',
      album: '',
      durationMs: 1000,
      coverUrl: '',
      position: 1
    })
    expect(song.filePath).toBe(buildNeteasePreviewUrl('99'))
    expect(song.neteaseLocalPath).toBeUndefined()
    expect(song.waveformPreviewListRoot).toBeUndefined()
    expect(song.key).toBeUndefined()
    expect(song.energyScore).toBeUndefined()
    expect(song.beatGridMap).toBeUndefined()
  })
})

describe('mapNeteaseDownloadedRowToSongInfo analysis hydration', () => {
  it('uses the real .store path and hydrates analysis for 查看已下载 rows', () => {
    const song = mapNeteaseDownloadedRowToSongInfo({
      songId: '1901371647',
      title: 'Demo',
      artist: 'Artist',
      album: 'Album',
      durationMs: 180000,
      absPath: 'E:/lib/library/NeteaseLibrary/.store/1901371647.flac',
      bitDepth: 16,
      sampleRate: 44100,
      sizeBytes: 1000,
      inPlaylist: true,
      listRoot: 'E:/lib/library/NeteaseLibrary',
      analysis
    })
    expect(song.filePath).toBe('E:/lib/library/NeteaseLibrary/.store/1901371647.flac')
    expect(song.neteaseLocalPath).toBe('E:/lib/library/NeteaseLibrary/.store/1901371647.flac')
    expect(song.waveformPreviewListRoot).toBe('E:/lib/library/NeteaseLibrary')
    expect(song.key).toBe('8A')
    expect(song.energyScore).toBe(6)
  })
})

describe('applyNeteaseAnalysisToSong', () => {
  it('does not overwrite the display filePath', () => {
    const song = applyNeteaseAnalysisToSong(
      {
        filePath: buildNeteasePreviewUrl('1'),
        fileName: 'x',
        fileFormat: '',
        cover: null,
        title: 'x',
        duration: '0:01'
      } as ISongInfo,
      {
        localPath: 'C:/store/1.flac',
        listRoot: 'C:/store-root',
        analysis: { key: '1A' }
      }
    )
    expect(song.filePath).toBe(buildNeteasePreviewUrl('1'))
    expect(song.neteaseLocalPath).toBe('C:/store/1.flac')
    expect(song.key).toBe('1A')
  })
})
