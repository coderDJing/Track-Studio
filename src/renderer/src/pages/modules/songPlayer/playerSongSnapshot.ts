import type { ISongInfo } from 'src/types/globals'
import { projectSongBeatGridMapV2ToFixedGrid } from '@shared/songBeatGridMapV2'

export const buildPlayerSongSnapshot = (filePath: string, song: ISongInfo) => {
  const baseName =
    String(filePath || '')
      .split(/[/\\]/)
      .pop() || ''
  const parts = baseName.split('.')
  const ext = parts.length > 1 ? parts.pop() || '' : ''
  const fileFormat = ext ? ext.toUpperCase() : ''
  return {
    filePath,
    fileName: song?.fileName || baseName,
    fileFormat: song?.fileFormat || fileFormat,
    cover: null,
    title: song?.title ?? baseName,
    artist: song?.artist,
    album: song?.album,
    duration: song?.duration ?? '',
    genre: song?.genre,
    label: song?.label,
    bitrate: song?.bitrate,
    container: song?.container,
    key: song?.key,
    keyAnalysisAlgorithmVersion: song?.keyAnalysisAlgorithmVersion,
    originalKey: song?.key,
    originalBpm: projectSongBeatGridMapV2ToFixedGrid(song?.beatGridMap)?.bpm,
    energyScore: song?.energyScore,
    energyAlgorithmVersion: song?.energyAlgorithmVersion,
    energyAnalysis: song?.energyAnalysis,
    hotCues: Array.isArray(song?.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(song?.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
  }
}
