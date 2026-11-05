export const ANALYSIS_RUNTIME_FEATURES = ['analysis', 'horizontal', 'stem', 'bpm-fix'] as const

export type AnalysisRuntimeFeature = (typeof ANALYSIS_RUNTIME_FEATURES)[number]

export const normalizeAnalysisRuntimeFeature = (value: unknown): AnalysisRuntimeFeature => {
  if (value === undefined || value === false) return 'analysis'
  if (value === true) return 'bpm-fix'
  const feature = ANALYSIS_RUNTIME_FEATURES.find((item) => item === value)
  if (!feature) throw new Error('Unknown analysis runtime feature')
  return feature
}
