// 歌曲列表演示用的曲目数据：按 ISongInfo 格式填，波形预览由 list-previews.json 提供
//（生成脚本用应用的 buildWaveformSurfaceCacheDataFromUnifiedDisplay 产出）。
import type { ISongInfo } from 'src/types/globals'
import {
  normalizeWaveformSurfaceData,
  type WaveformListPreviewData
} from '@shared/waveformSurfaceCache'
import { LIST_TRACKS } from './demoTrackSpecs'
import { registerDemoListPreview } from './demoIpc'
import { DEMO_TRACKS } from './demoSongs'

const ROOT = 'D:/Music/Track Studio/library/FilterLibrary/2026-09 新歌/Beatport 周榜'
const GENRES = [
  'Techno',
  'Techno',
  'Techno',
  'Deep House',
  'Techno',
  'Melodic House',
  'Deep House',
  'Tech House'
]
const LABELS = [
  'Night Transit',
  'Signal Rec.',
  'Parallel',
  'Weightless',
  'Signal Rec.',
  'Tidal',
  'Night Transit',
  'Pressure'
]
// 与应用曲目元数据一致：比特率 kbps、编码格式
const BITRATE: Record<string, number> = { FLAC: 1411, WAV: 1411, AIFF: 1411, MP3: 320 }
const CONTAINER: Record<string, string> = {
  FLAC: 'FLAC',
  WAV: 'PCM',
  AIFF: 'PCM',
  MP3: 'MPEG-1 Layer 3'
}

export const DEMO_LIBRARY_SONGS: ISongInfo[] = LIST_TRACKS.map((track, index) => {
  const fileName = `${track.artist} - ${track.title}.${track.format.toLowerCase()}`
  const song: Partial<ISongInfo> & Record<string, unknown> = {
    filePath: `${ROOT}/${fileName}`,
    fileName,
    fileFormat: track.format,
    container: CONTAINER[track.format] ?? track.format,
    bitrate: BITRATE[track.format] ?? 320,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: GENRES[index % GENRES.length],
    label: LABELS[index % LABELS.length],
    duration: track.durationText,
    bpm: track.bpm,
    key: track.keyText,
    energyScore: track.energy,
    dancefloorScore: Math.min(100, track.energy + 6),
    danceabilityScore: Math.max(40, track.energy - 9),
    rhythmicScore: Math.max(40, track.energy - 4),
    trackNumber: index + 1,
    addedAtMs: Date.UTC(2026, 8, 28 - index, 10, 12)
  }
  return song as ISongInfo
})

export const DEMO_EXTERNAL_SONGS: ISongInfo[] = DEMO_LIBRARY_SONGS.map((song) => ({
  ...song,
  filePath: `E:/PIONEER/Contents/${song.fileName}`
}))

export const DEMO_PLAYER_SONGS: ISongInfo[] = [
  DEMO_TRACKS[0].song,
  ...DEMO_LIBRARY_SONGS.slice(0, 7)
]

let loaded: Promise<void> | null = null
// 把每首歌的 listPreview 登记给 IPC 替身，SongListRows 通过 waveform-list-preview-cache:batch 取
export const loadDemoLibraryPreviews = (baseUrl: string) => {
  if (!loaded) {
    loaded = fetch(`${baseUrl}list-previews.json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`list previews ${res.status}`)
        const previews = (await res.json()) as Record<string, Record<string, unknown>>
        LIST_TRACKS.forEach((track, index) => {
          const raw = previews[track.id]
          if (!raw) return
          // JSON 里的数组还原成 Uint8Array，再按应用的规范化函数读一遍
          const revived = Object.fromEntries(
            Object.entries(raw).map(([key, value]) => [
              key,
              Array.isArray(value) ? Uint8Array.from(value as number[]) : value
            ])
          )
          const data = normalizeWaveformSurfaceData<WaveformListPreviewData>(revived, 'listPreview')
          if (data) {
            registerDemoListPreview(DEMO_LIBRARY_SONGS[index].filePath, data)
            registerDemoListPreview(DEMO_EXTERNAL_SONGS[index].filePath, data)
          }
        })
      })
      .catch((error: unknown) => {
        console.error('Failed to load list previews:', error)
      })
  }
  return loaded
}
