import { hasUsableSongEnergyAnalysis } from '../../../shared/songEnergy'
import {
  hasRequiredSongStructureAnalysis,
  hasUsableKeyAnalysis,
  resolveCanonicalSongBeatGridV2
} from '../../../shared/songAnalysisCompleteness'
import type { TrackReanalysisUserSelection } from '../../../shared/trackReanalysisSelection'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '../../../shared/filePathComparison'

export type AnalysisCandidate = {
  filePath?: unknown
  key?: unknown
  keyAnalysisAlgorithmVersion?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  beatGridMap?: unknown
  beatGridStatus?: unknown
  beatGridAlgorithmVersion?: unknown
  energyScore?: unknown
  energyAlgorithmVersion?: unknown
  songStructure?: unknown
  fileMissing?: boolean
}

export type MissingAnalysisOptions = {
  includeSongStructure?: boolean
  missingWaveformFilePaths?: readonly string[]
  missingWaveformFilePathKeys?: ReadonlySet<string>
}

const normalizeFilePathKey = (filePath: string) =>
  normalizeFilePathForComparison(filePath, isCurrentRendererWindowsPathPlatform())

const resolveMissingWaveformFilePathKeys = (options: MissingAnalysisOptions) => {
  if (options.missingWaveformFilePathKeys) return options.missingWaveformFilePathKeys
  if (!options.missingWaveformFilePaths) return undefined
  return new Set(
    options.missingWaveformFilePaths
      .map((filePath) => normalizeFilePathKey(String(filePath || '').trim()))
      .filter(Boolean)
  )
}

const isWaveformMissing = (song: AnalysisCandidate, options: MissingAnalysisOptions) => {
  const filePath = typeof song.filePath === 'string' ? song.filePath.trim() : ''
  if (!filePath) return false
  return resolveMissingWaveformFilePathKeys(options)?.has(normalizeFilePathKey(filePath)) === true
}

export const hasRequiredAnalysis = (
  song: AnalysisCandidate,
  requiresRuntimeAnalysis: boolean,
  options: MissingAnalysisOptions = {}
) => resolveMissingAnalysisReasons(song, requiresRuntimeAnalysis, options).length === 0

export const resolveMissingAnalysisReasons = (
  song: AnalysisCandidate,
  _requiresRuntimeAnalysis: boolean,
  options: MissingAnalysisOptions = {}
) => {
  const reasons: string[] = []
  if (!hasUsableSongEnergyAnalysis(song)) reasons.push('missing-energy-score')
  if (!hasUsableKeyAnalysis(song)) reasons.push('missing-key')
  if (isWaveformMissing(song, options)) reasons.push('missing-waveform')

  const grid = resolveCanonicalSongBeatGridV2(song)
  if (grid.kind === 'no-bpm') return reasons
  if (grid.kind === 'grid') {
    if (options.includeSongStructure && !hasRequiredSongStructureAnalysis(song)) {
      reasons.push('missing-song-structure')
    }
    return reasons
  }

  reasons.push('missing-bpm', 'missing-first-beat', 'missing-downbeat-beat-offset')
  return reasons
}

export const collectMissingAnalysisFilesFromSongs = (
  songs: AnalysisCandidate[],
  requiresRuntimeAnalysis: boolean,
  seen = new Set<string>(),
  options: MissingAnalysisOptions = {}
) => {
  const files: string[] = []
  const resolvedOptions: MissingAnalysisOptions = {
    ...options,
    missingWaveformFilePathKeys: resolveMissingWaveformFilePathKeys(options)
  }
  for (const song of songs) {
    if (song.fileMissing) continue
    const filePath = String(song.filePath || '').trim()
    const key = normalizeFilePathKey(filePath)
    if (!filePath || seen.has(key)) continue
    if (hasRequiredAnalysis(song, requiresRuntimeAnalysis, resolvedOptions)) continue
    seen.add(key)
    files.push(filePath)
  }
  return files
}

export const songNeedsSelectedMissingAnalysis = (
  song: AnalysisCandidate,
  selection: TrackReanalysisUserSelection,
  requiresRuntimeAnalysis: boolean,
  options: MissingAnalysisOptions = {}
) => {
  const reasons = resolveMissingAnalysisReasons(song, requiresRuntimeAnalysis, {
    ...options,
    includeSongStructure: selection.structure === true
  })
  if (selection.key && reasons.includes('missing-key')) return true
  if (selection.energy && reasons.includes('missing-energy-score')) return true
  if (selection.waveform && reasons.includes('missing-waveform')) return true
  if (selection.beatGrid && reasons.includes('missing-bpm')) return true
  if (selection.structure && reasons.includes('missing-song-structure')) return true
  return false
}

export const collectFilesNeedingSelectedAnalysis = (
  songs: AnalysisCandidate[],
  selection: TrackReanalysisUserSelection,
  requiresRuntimeAnalysis: boolean,
  options: MissingAnalysisOptions = {}
) => {
  const files: string[] = []
  const seen = new Set<string>()
  const resolvedOptions: MissingAnalysisOptions = {
    ...options,
    missingWaveformFilePathKeys: resolveMissingWaveformFilePathKeys(options)
  }
  for (const song of songs) {
    if (song.fileMissing) continue
    const filePath = String(song.filePath || '').trim()
    const key = normalizeFilePathKey(filePath)
    if (!filePath || seen.has(key)) continue
    if (
      !songNeedsSelectedMissingAnalysis(song, selection, requiresRuntimeAnalysis, resolvedOptions)
    ) {
      continue
    }
    seen.add(key)
    files.push(filePath)
  }
  return files
}
