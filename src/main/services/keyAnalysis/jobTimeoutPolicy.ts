import {
  KEY_ANALYSIS_ANALYZE_STAGE_TIMEOUT_MS,
  KEY_ANALYSIS_DECODE_STAGE_TIMEOUT_MS,
  KEY_ANALYSIS_JOB_TIMEOUT_MS,
  KEY_ANALYSIS_STAGE_TIMEOUT_MAX_MS,
  KEY_ANALYSIS_WAVEFORM_STAGE_TIMEOUT_MS,
  type KeyAnalysisJob,
  type KeyAnalysisProgress
} from './types'

export const clampKeyAnalysisStageTimeoutMs = (timeoutMs: number): number => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return KEY_ANALYSIS_JOB_TIMEOUT_MS
  return Math.max(1000, Math.min(Math.round(timeoutMs), KEY_ANALYSIS_STAGE_TIMEOUT_MAX_MS))
}

export const getEstimatedAnalysisDurationSec = (job: KeyAnalysisJob): number | undefined => {
  const probeDuration = Number(job.probe?.durationSec)
  if (Number.isFinite(probeDuration) && probeDuration > 0) {
    return probeDuration
  }
  const trace = job.trace
  const framesToProcess = Number(trace?.framesToProcess)
  const sampleRate = Number(trace?.sampleRate)
  if (
    Number.isFinite(framesToProcess) &&
    framesToProcess > 0 &&
    Number.isFinite(sampleRate) &&
    sampleRate > 0
  ) {
    return framesToProcess / sampleRate
  }
  const totalFrames = Number(trace?.totalFrames)
  if (
    Number.isFinite(totalFrames) &&
    totalFrames > 0 &&
    Number.isFinite(sampleRate) &&
    sampleRate > 0
  ) {
    return totalFrames / sampleRate
  }
  return undefined
}

export const getKeyAnalysisStageTimeoutMs = (
  job: KeyAnalysisJob,
  stage?: KeyAnalysisProgress['stage']
): number => {
  const estimatedDurationSec = getEstimatedAnalysisDurationSec(job)
  const hasDuration = Number.isFinite(estimatedDurationSec) && Number(estimatedDurationSec) > 0
  const durationSec = hasDuration ? Number(estimatedDurationSec) : 0
  if (stage === 'decode-start') {
    let timeoutMs = KEY_ANALYSIS_DECODE_STAGE_TIMEOUT_MS
    if (hasDuration) {
      timeoutMs = Math.max(timeoutMs, durationSec * 1000 * 1.25 + 120000)
    } else {
      const fileSizeMb = Math.max(0, Number(job.fileSize || 0)) / (1024 * 1024)
      timeoutMs = Math.max(timeoutMs, 120000 + fileSizeMb * 12000)
    }
    return clampKeyAnalysisStageTimeoutMs(timeoutMs)
  }

  if (stage === 'analyze-start') {
    const timeoutMs = hasDuration
      ? Math.max(KEY_ANALYSIS_ANALYZE_STAGE_TIMEOUT_MS, durationSec * 1000 * 0.6 + 30000)
      : KEY_ANALYSIS_ANALYZE_STAGE_TIMEOUT_MS
    return clampKeyAnalysisStageTimeoutMs(timeoutMs)
  }

  if (stage === 'waveform-start') {
    const timeoutMs = hasDuration
      ? Math.max(KEY_ANALYSIS_WAVEFORM_STAGE_TIMEOUT_MS, durationSec * 1000 * 0.25 + 20000)
      : KEY_ANALYSIS_WAVEFORM_STAGE_TIMEOUT_MS
    return clampKeyAnalysisStageTimeoutMs(timeoutMs)
  }

  return KEY_ANALYSIS_JOB_TIMEOUT_MS
}
