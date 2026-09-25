import {
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid,
  type SongBeatGridMapV2
} from './songBeatGridMapV2'
import { hasUsableSongEnergyAnalysis } from './songEnergy'
import { hasUsableSongStructureAnalysis } from './songStructure'

export type SongAnalysisCompletenessInfo = {
  key?: unknown
  beatGridStatus?: unknown
  beatGridMap?: unknown
  energyScore?: unknown
  songStructure?: unknown
}

export type CanonicalSongBeatGridV2 =
  | {
      kind: 'grid'
      beatGridMap: SongBeatGridMapV2
      bpm: number
      firstBeatMs: number
      downbeatBeatOffset: number
    }
  | { kind: 'no-bpm' }
  | { kind: 'missing' }

export type UsableSongBeatGrid = CanonicalSongBeatGridV2

export const hasUsableKeyAnalysis = (
  info: Pick<SongAnalysisCompletenessInfo, 'key'> | null | undefined
) => typeof info?.key === 'string' && info.key.trim().length > 0

export const resolveCanonicalSongBeatGridV2 = (
  info: SongAnalysisCompletenessInfo | null | undefined
): CanonicalSongBeatGridV2 => {
  const beatGridMap = normalizeSongBeatGridMapV2(info?.beatGridMap, { allowSingleClip: true })
  const projection = projectSongBeatGridMapV2ToFixedGrid(beatGridMap)
  if (beatGridMap && projection) {
    return { kind: 'grid', beatGridMap, ...projection }
  }
  if (info?.beatGridStatus === 'no-bpm') return { kind: 'no-bpm' }
  return { kind: 'missing' }
}

export const resolveUsableSongBeatGrid = (
  info: SongAnalysisCompletenessInfo | null | undefined
): UsableSongBeatGrid => resolveCanonicalSongBeatGridV2(info)

export const hasUsableSongBeatGridAnalysis = (
  info: SongAnalysisCompletenessInfo | null | undefined
) => resolveUsableSongBeatGrid(info).kind !== 'missing'

export const hasExistingBeatGridForStructure = (
  info: SongAnalysisCompletenessInfo | null | undefined
) => resolveCanonicalSongBeatGridV2(info).kind === 'grid'

export const hasUsableNoBpmBeatGridResult = (
  info: SongAnalysisCompletenessInfo | null | undefined
) => resolveUsableSongBeatGrid(info).kind === 'no-bpm'

export const hasRequiredSongStructureAnalysis = (
  info: SongAnalysisCompletenessInfo | null | undefined
) => {
  const grid = resolveUsableSongBeatGrid(info)
  if (grid.kind === 'no-bpm') return true
  if (grid.kind === 'missing') return false
  return hasUsableSongStructureAnalysis({
    beatGridMap: grid.beatGridMap,
    songStructure: info?.songStructure
  })
}

export const hasRequiredSongEnergyAnalysis = (
  info: SongAnalysisCompletenessInfo | null | undefined
) => resolveCanonicalSongBeatGridV2(info).kind === 'no-bpm' || hasUsableSongEnergyAnalysis(info)

export const hasUsableCoreSongAnalysis = (
  info: SongAnalysisCompletenessInfo | null | undefined,
  options: { includeStructure?: boolean; waveformAvailable?: boolean } = {}
) => {
  if (!hasUsableKeyAnalysis(info) || !hasRequiredSongEnergyAnalysis(info)) return false
  if (options.waveformAvailable === false) return false
  const grid = resolveUsableSongBeatGrid(info)
  if (grid.kind === 'missing') return false
  if (options.includeStructure && !hasRequiredSongStructureAnalysis(info)) return false
  return true
}
