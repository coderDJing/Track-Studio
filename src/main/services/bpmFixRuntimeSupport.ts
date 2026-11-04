import { buildStemProcessEnv, runProbeProcess } from './mixtapeStemSeparationShared'
import { resolveBundledFfmpegPath } from '../ffmpeg'

export const hasBpmFixRuntimeSupport = async (pythonPath: string, runtimeDir: string) => {
  const result = await runProbeProcess({
    command: pythonPath,
    args: ['-c', 'from librosa.beat import beat_track'],
    env: buildStemProcessEnv(runtimeDir, resolveBundledFfmpegPath()),
    timeoutMs: 60_000,
    maxStdoutLen: 1000,
    maxStderrLen: 4000
  })
  return !result.timedOut && result.status === 0
}
