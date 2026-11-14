type AnalysisRuntimeDisplayState = {
  status?: unknown
  percent?: unknown
}

const clampAnalysisRuntimePercent = (value: unknown) =>
  Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 10) / 10))

export const isAnalysisRuntimeDownloadActiveStatus = (value: unknown) =>
  value === 'downloading' || value === 'extracting'

export const formatAnalysisRuntimeBytes = (bytes: unknown) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, Number(bytes) || 0)
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = unitIndex === 0 ? 0 : unitIndex === 1 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

export const resolveAnalysisRuntimeDownloadPercent = (state: AnalysisRuntimeDisplayState) =>
  clampAnalysisRuntimePercent(state.percent)
