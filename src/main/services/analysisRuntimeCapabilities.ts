import type { AnalysisRuntimeFeature } from '../../shared/analysisRuntimeFeatures'
import { buildStemProcessEnv, runProbeProcess } from './mixtapeStemSeparationShared'
import { log } from '../log'
import { resolveLoggedRuntimePath, truncateProbeLogText } from './mixtapeStemDeviceProbeResult'
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

export const ANALYSIS_RUNTIME_FEATURE_PROBE_TIMEOUT_MS = 60_000
export const ANALYSIS_RUNTIME_FEATURE_PROBE_CACHE_TTL_MS = 60_000

export const hasAnalysisRuntimeFeatureSupport = (
  feature: AnalysisRuntimeFeature,
  pythonPath: string,
  runtimeDir: string
): Promise<boolean> => {
  const code = checks[feature]
  const key = JSON.stringify([pythonPath, runtimeDir, code])
  const existing = cache.get(key)
  if (existing && existing.expiresAt > Date.now()) return existing.result
  const startedAt = Date.now()
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
          timeoutMs: ANALYSIS_RUNTIME_FEATURE_PROBE_TIMEOUT_MS,
          maxStdoutLen: 1000,
          maxStderrLen: 4000
        }).then((probe) => {
          const ok = !probe.timedOut && probe.status === 0
          log[ok ? 'info' : 'warn']('[analysis-runtime-probe]', {
            event: 'feature-probe',
            feature,
            pythonPath: resolveLoggedRuntimePath(pythonPath),
            elapsedMs: Date.now() - startedAt,
            exit: probe.status,
            timedOut: probe.timedOut,
            ok,
            error: ok ? '' : truncateProbeLogText(probe.error || probe.stderr || probe.stdout, 400)
          })
          return ok
        })
  cache.set(key, { expiresAt: Date.now() + ANALYSIS_RUNTIME_FEATURE_PROBE_CACHE_TTL_MS, result })
  void result.then(
    (ok) => {
      const current = cache.get(key)
      if (!current || current.result !== result) return
      if (ok) {
        current.expiresAt = Date.now() + ANALYSIS_RUNTIME_FEATURE_PROBE_CACHE_TTL_MS
        return
      }
      cache.delete(key)
    },
    () => {
      const current = cache.get(key)
      if (!current || current.result !== result) return
      cache.delete(key)
    }
  )
  return result
}
