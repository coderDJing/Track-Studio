import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'

const ANALYSIS_FIELD_KEYS = [
  'key',
  'keyAnalysisAlgorithmVersion',
  'energyScore',
  'energyAlgorithmVersion',
  'energyAnalysis'
] as const

type SongAnalysisFieldKey = (typeof ANALYSIS_FIELD_KEYS)[number]
type SongCueSource = Pick<ISongInfo, SongAnalysisFieldKey> & {
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
}

export type SongCueCopyEntry = {
  targetFilePath?: string | null
  sourceSong?: SongCueSource | null
}

export type SongCueCopySummary = {
  targetCount: number
  hotCueTargetCount: number
  memoryCueTargetCount: number
  hotCueUpdated: number
  memoryCueUpdated: number
  analysisTargetCount: number
  analysisUpdated: number
}

const normalizeFilePath = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const toIpcSafeValue = <T>(value: T): T | undefined => {
  try {
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string') return undefined
    return JSON.parse(serialized) as T
  } catch {
    return undefined
  }
}

const toIpcSafeArray = <T>(value: T[]) => toIpcSafeValue(value) || []

const pickAnalysisFields = (sourceSong?: Partial<SongCueSource> | null) => {
  const result: Partial<Pick<ISongInfo, SongAnalysisFieldKey>> = {}
  if (!sourceSong || typeof sourceSong !== 'object') return result
  for (const key of ANALYSIS_FIELD_KEYS) {
    const value = sourceSong[key]
    if (value !== undefined) {
      result[key] = value as never
    }
  }
  return result
}

const hasAnalysisFields = (value: Partial<Pick<ISongInfo, SongAnalysisFieldKey>>) =>
  ANALYSIS_FIELD_KEYS.some((key) => value[key] !== undefined)

export const copySongCueDefinitionsToTargets = async (
  entries: SongCueCopyEntry[]
): Promise<SongCueCopySummary> => {
  const normalizedEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const filePath = normalizeFilePath(entry?.targetFilePath)
      const hotCues = Array.isArray(entry?.sourceSong?.hotCues)
        ? toIpcSafeArray(entry.sourceSong.hotCues.map((cue) => ({ ...cue })))
        : []
      const memoryCues = Array.isArray(entry?.sourceSong?.memoryCues)
        ? toIpcSafeArray(entry.sourceSong.memoryCues.map((cue) => ({ ...cue })))
        : []
      if (!filePath) return null
      return {
        filePath,
        hotCues,
        memoryCues,
        analysisFields: toIpcSafeValue(pickAnalysisFields(entry?.sourceSong)) || {}
      }
    })
    .filter(
      (
        entry
      ): entry is {
        filePath: string
        hotCues: ISongHotCue[]
        memoryCues: ISongMemoryCue[]
        analysisFields: Partial<Pick<ISongInfo, SongAnalysisFieldKey>>
      } => Boolean(entry)
    )
  const cueEntries = normalizedEntries.filter(
    (entry) => entry.hotCues.length > 0 || entry.memoryCues.length > 0
  )
  const analysisEntries = normalizedEntries.filter((entry) =>
    hasAnalysisFields(entry.analysisFields)
  )

  const baseSummary: SongCueCopySummary = {
    targetCount: cueEntries.length,
    hotCueTargetCount: cueEntries.filter((entry) => entry.hotCues.length > 0).length,
    memoryCueTargetCount: cueEntries.filter((entry) => entry.memoryCues.length > 0).length,
    hotCueUpdated: 0,
    memoryCueUpdated: 0,
    analysisTargetCount: analysisEntries.length,
    analysisUpdated: 0
  }

  if (normalizedEntries.length === 0) return baseSummary
  const [cueResult, analysisResult] = await Promise.all([
    cueEntries.length > 0
      ? window.electron.ipcRenderer.invoke('song:copy-cue-definitions-by-file-path', {
          entries: cueEntries
        })
      : Promise.resolve(undefined),
    analysisEntries.length > 0
      ? window.electron.ipcRenderer.invoke('song:copy-analysis-fields-by-file-path', {
          entries: analysisEntries.map((entry) => ({
            filePath: entry.filePath,
            sourceSong: entry.analysisFields
          }))
        })
      : Promise.resolve(undefined)
  ])
  const cueSummary = cueResult as
    | Partial<Pick<SongCueCopySummary, 'hotCueUpdated' | 'memoryCueUpdated'>>
    | undefined
  const analysisSummary = analysisResult as
    | Partial<Pick<SongCueCopySummary, 'analysisUpdated'>>
    | undefined

  return {
    ...baseSummary,
    hotCueUpdated: Number(cueSummary?.hotCueUpdated) || 0,
    memoryCueUpdated: Number(cueSummary?.memoryCueUpdated) || 0,
    analysisUpdated: Number(analysisSummary?.analysisUpdated) || 0
  }
}
