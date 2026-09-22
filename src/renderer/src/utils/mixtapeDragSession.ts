import type { MixtapeDragSessionItem } from '@shared/mixtapeDragSession'
import type { ISongInfo } from 'src/types/globals'

type BuildMixtapeDragSessionItemOptions = {
  song?: ISongInfo | null
  filePath: string
  sourceSongListUUID: string
  originPathSnapshot?: string | null
  sourceItemId?: string | null
}

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const resolveFileNameAndFormat = (filePath: string) => {
  const baseName = filePath.split(/[/\\]/).pop() || ''
  const parts = baseName.split('.')
  const ext = parts.length > 1 ? parts.pop() || '' : ''
  return {
    fileName: baseName,
    fileFormat: ext ? ext.toUpperCase() : ''
  }
}

const buildMixtapeSongSnapshot = (
  filePath: string,
  song?: ISongInfo | null
): Record<string, unknown> => {
  const meta = resolveFileNameAndFormat(filePath)
  return {
    filePath,
    fileName: song?.fileName || meta.fileName,
    fileFormat: song?.fileFormat || meta.fileFormat,
    cover: null,
    title: song?.title ?? meta.fileName,
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
    originalBpm: song?.bpm,
    energyScore: song?.energyScore,
    energyAlgorithmVersion: song?.energyAlgorithmVersion,
    energyAnalysis: song?.energyAnalysis,
    hotCues: Array.isArray(song?.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(song?.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : []
  }
}

export const buildMixtapeDragSessionItem = ({
  song,
  filePath,
  sourceSongListUUID,
  originPathSnapshot,
  sourceItemId
}: BuildMixtapeDragSessionItemOptions): MixtapeDragSessionItem | null => {
  const normalizedFilePath = normalizeText(filePath || song?.filePath)
  if (!normalizedFilePath) return null
  const normalizedSourceListId = normalizeText(sourceSongListUUID)
  const normalizedSourceItemId = normalizeText(sourceItemId)
  return {
    filePath: normalizedFilePath,
    originPlaylistUuid: normalizedSourceListId || null,
    originPathSnapshot: normalizeText(originPathSnapshot) || null,
    info: buildMixtapeSongSnapshot(normalizedFilePath, song),
    sourcePlaylistId: normalizedSourceListId || null,
    sourceItemId: normalizedSourceItemId || null
  }
}

export const createMixtapeDragSessionToken = () => {
  const randomId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `mixtape-drag-${randomId}`
}
