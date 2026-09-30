import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { buildMixtapeDragSessionItem } from './mixtapeDragSession'

describe('buildMixtapeDragSessionItem', () => {
  it('将响应式歌曲的嵌套数据转为可通过 IPC 传输的快照', () => {
    const song = reactive<ISongInfo>({
      filePath: 'C:\\Music\\Track.mp3',
      fileName: 'Track.mp3',
      fileFormat: 'MP3',
      cover: null,
      title: 'Track',
      artist: 'Artist',
      album: undefined,
      duration: '03:00',
      genre: undefined,
      label: undefined,
      bitrate: undefined,
      container: undefined,
      energyAnalysis: {
        version: 11,
        model: 'musicnn-deam-emomusic-structure-v11',
        sustainedScore: 5,
        averageScore: 5,
        medianScore: 5,
        peakScore: 7,
        rangeScore: 2,
        confidence: 0.9,
        patchCount: 2,
        energyCurve: [{ timeMs: 0, score: 5, role: 'intro' }]
      },
      hotCues: [{ slot: 0, sec: 12, label: 'Start' }]
    })
    expect(() => structuredClone(song.energyAnalysis)).toThrow()

    const item = buildMixtapeDragSessionItem({
      song,
      filePath: song.filePath,
      sourceSongListUUID: 'playlist-1'
    })

    expect(item?.info?.energyAnalysis).toEqual(song.energyAnalysis)
    expect(item?.info?.hotCues).toEqual([{ slot: 0, sec: 12, label: 'Start' }])
    expect(() => structuredClone({ token: 'drag-1', items: [item] })).not.toThrow()
  })
})
