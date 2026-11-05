import type { AnalysisRuntimeFeature } from '../../shared/analysisRuntimeFeatures'
import { buildStemProcessEnv, runProbeProcess } from './mixtapeStemSeparationShared'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import { resolveBpmFixRuntime } from './bpmFixProcess'

// Feature checks run in a managed Python subprocess and are reused across UI entry points.
const checks: Record<AnalysisRuntimeFeature, string> = {
  analysis: 'import beat_this.inference; import soxr',
  horizontal: 'import beat_this.inference; import soxr',
  stem: 'import torch; import torchaudio; import demucs',
  'bpm-fix': 'import beat_this.inference; import soxr; from librosa.beat import beat_track'
}
export const getAnalysisRuntimeFeatureProbeCode = (feature: AnalysisRuntimeFeature) =>
  checks[feature]

const cache = new Map<string, { expiresAt: number; result: Promise<boolean> }>()

export const clearAnalysisRuntimeCapabilityCache = () => cache.clear()

export const hasAnalysisRuntimeFeatureSupport = (
  feature: AnalysisRuntimeFeature,
  pythonPath: string,
  runtimeDir: string
): Promise<boolean> => {
  const code = checks[feature]
  const key = JSON.stringify([pythonPath, runtimeDir, code])
  const existing = cache.get(key)
  if (existing && existing.expiresAt > Date.now()) return existing.result
  const result =
    feature === 'bpm-fix'
      ? resolveBpmFixRuntime({ cancelled: false }).then(
          () => true,
          () => false
        )
      : runProbeProcess({
          command: pythonPath,
          args: ['-c', code],
          env: buildStemProcessEnv(runtimeDir, resolveBundledFfmpegPath()),
          timeoutMs: 60_000,
          maxStdoutLen: 1000,
          maxStderrLen: 4000
        }).then((probe) => !probe.timedOut && probe.status === 0)
  cache.set(key, { expiresAt: Date.now() + 60_000, result })
  return result
}
