import { parentPort } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'
import { buildBeatThisChildEnv, resolveBeatThisRuntime } from './beatThisRuntime'
import type { BpmFixRuntime } from '../../shared/bpmFix'

// Runtime probes can be expensive. Never run their synchronous subprocesses on
// Electron's main thread while the player and song list are active.
try {
  const resolved = resolveBeatThisRuntime()
  if (!resolved || resolved.candidate.source === 'dev-launcher')
    throw new Error('BPM_FIX_RUNTIME_UNAVAILABLE')
  const runtime: BpmFixRuntime = {
    command: resolved.candidate.command,
    args: resolved.candidate.args,
    env: buildBeatThisChildEnv(resolved.candidate),
    device: resolved.selectedDeviceArg
  }
  // Check the lazy librosa beat module once before accepting a whole batch.
  // Use the same managed site/DLL bootstrap as the audio pipeline.
  const scripts = process.env.FRKB_BPM_FIX_BOOTSTRAP_DIR
  if (!scripts) throw new Error('BPM_FIX_RUNTIME_UNAVAILABLE')
  const probe = spawnSync(
    runtime.command,
    [
      ...runtime.args,
      '-c',
      'import sys;sys.path.insert(0,sys.argv[1]);import beat_this_bridge;from librosa.beat import beat_track',
      scripts
    ],
    {
      env: runtime.env,
      windowsHide: true,
      timeout: 60000,
      encoding: 'utf8'
    }
  )
  if (probe.status !== 0) throw new Error('BPM_FIX_LIBROSA_UNAVAILABLE')
  parentPort?.postMessage({ runtime })
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
}
