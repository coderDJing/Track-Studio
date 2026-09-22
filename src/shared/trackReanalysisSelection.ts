import { hasExistingBeatGridForStructure } from './songAnalysisCompleteness'

export type TrackReanalysisUserSelection = {
  key: boolean
  beatGrid: boolean
  waveform: boolean
  energy: boolean
  structure: boolean
}

export type TrackReanalysisSongHint = {
  filePath?: unknown
  beatGridStatus?: unknown
  beatGridMap?: unknown
  key?: unknown
  energyScore?: unknown
  songStructure?: unknown
  fileMissing?: boolean
}

export type TrackReanalysisPlan = TrackReanalysisUserSelection

export const DEFAULT_TRACK_REANALYSIS_SELECTION: TrackReanalysisUserSelection = {
  key: true,
  beatGrid: true,
  waveform: true,
  energy: true,
  structure: true
}

const readBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') return value
  if (value === '1' || value === 1) return true
  if (value === '0' || value === 0) return false
  return fallback
}

const normalizeReanalysisFilePath = (value: unknown) => {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .replace(/[/\\]+/g, '\\')
    .toLowerCase()
}

export const hasAnyTrackReanalysisUserSelection = (selection: TrackReanalysisUserSelection) =>
  selection.key ||
  selection.beatGrid ||
  selection.waveform ||
  selection.energy ||
  selection.structure

export const canSelectStructureAloneFromSongs = (
  songs: Array<TrackReanalysisSongHint | null | undefined>,
  filePaths?: string[]
) => {
  const files = new Set((filePaths || []).map(normalizeReanalysisFilePath).filter(Boolean))
  const relevant = songs.filter((song) => {
    if (!song) return false
    if (files.size === 0) return true
    const songPath = normalizeReanalysisFilePath(song.filePath)
    return Boolean(songPath && files.has(songPath))
  })
  return relevant.length > 0 && relevant.every((song) => hasExistingBeatGridForStructure(song))
}

export const resolveTrackReanalysisPlan = (
  selection: TrackReanalysisUserSelection
): TrackReanalysisPlan => ({
  key: selection.key === true,
  beatGrid: selection.beatGrid === true,
  waveform: selection.waveform === true,
  energy: selection.energy === true,
  structure: selection.structure === true
})

export const isFullTrackReanalysisPlan = (plan: TrackReanalysisPlan) =>
  plan.key && plan.beatGrid && plan.waveform && plan.energy && plan.structure

export const isTrackReanalysisBeatGridLocked = (
  selection: TrackReanalysisUserSelection,
  canSelectStructureAlone = false
) => selection.energy === true || (selection.structure === true && canSelectStructureAlone !== true)

export const applyTrackReanalysisSelectionDependencies = (
  selection: TrackReanalysisUserSelection,
  canSelectStructureAlone: boolean
): TrackReanalysisUserSelection => {
  const next: TrackReanalysisUserSelection = {
    key: selection.key === true,
    beatGrid: selection.beatGrid === true,
    waveform: selection.waveform === true,
    energy: selection.energy === true,
    structure: selection.structure === true
  }
  // 能量的结构增强正式依赖网格，勾选能量就必须一起分析网格。
  if (next.energy) {
    next.beatGrid = true
  } else if (next.structure && !canSelectStructureAlone) {
    // 段落依赖网格：没有已有网格时必须一起分析网格。
    next.beatGrid = true
  }
  return next
}

export const normalizeTrackReanalysisSelection = (value: unknown): TrackReanalysisUserSelection => {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const record = input as Partial<Record<keyof TrackReanalysisUserSelection, unknown>> | null
  const next: TrackReanalysisUserSelection = {
    key: readBoolean(record?.key, DEFAULT_TRACK_REANALYSIS_SELECTION.key),
    beatGrid: readBoolean(record?.beatGrid, DEFAULT_TRACK_REANALYSIS_SELECTION.beatGrid),
    waveform: readBoolean(record?.waveform, DEFAULT_TRACK_REANALYSIS_SELECTION.waveform),
    energy: readBoolean(record?.energy, DEFAULT_TRACK_REANALYSIS_SELECTION.energy),
    structure: readBoolean(record?.structure, DEFAULT_TRACK_REANALYSIS_SELECTION.structure)
  }
  if (!hasAnyTrackReanalysisUserSelection(next)) {
    return { ...DEFAULT_TRACK_REANALYSIS_SELECTION }
  }
  return next
}
