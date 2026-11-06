import { app } from 'electron'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import type { BpmFixRuntime } from '../../shared/bpmFix'
import { BpmFixPipeline } from './bpmFixPipeline'
import { resolveMainWorkerPath } from '../workerPath'

export type BpmFixProcessJob = {
  cancelled: boolean
  child?: ChildProcess
  worker?: Worker
  pipeline?: BpmFixPipeline
}

export const resolveBpmFixRuntime = async (job: BpmFixProcessJob): Promise<BpmFixRuntime> => {
  const worker = new Worker(resolveMainWorkerPath(__dirname, 'bpmFixRuntimeWorker.js'), {
    env: {
      ...process.env,
      FRKB_APP_PACKAGED: app.isPackaged ? '1' : '0',
      FRKB_USER_DATA_DIR: app.getPath('userData'),
      FRKB_BPM_FIX_BOOTSTRAP_DIR: app.isPackaged
        ? path.join(process.resourcesPath, 'demucs/bootstrap')
        : path.resolve('scripts')
    }
  })
  job.worker = worker
  try {
    return await new Promise<BpmFixRuntime>((resolve, reject) => {
      worker.once('message', (message: { runtime?: BpmFixRuntime; error?: string }) => {
        if (message.runtime) resolve(message.runtime)
        else reject(new Error(message.error || 'BPM_FIX_RUNTIME_UNAVAILABLE'))
      })
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('BPM_FIX_RUNTIME_UNAVAILABLE')))
    })
  } finally {
    job.worker = undefined
    await worker.terminate()
  }
}

export const runBpmFixPipeline = async (
  job: BpmFixProcessJob,
  runtime: BpmFixRuntime,
  args: string[],
  progress: (stage: string, percent: number) => void,
  analysis?: unknown,
  diagnostic?: (details: Record<string, unknown>) => void
) => {
  if (job.cancelled) throw new Error('BPM_FIX_CANCELLED')
  if (!job.pipeline) {
    job.pipeline = new BpmFixPipeline(runtime, args[0])
    job.child = job.pipeline.child
  }
  return job.pipeline.run(
    [...args.slice(1), '--device', runtime.device],
    analysis,
    progress,
    diagnostic
  )
}

export const closeBpmFixPipeline = async (job: BpmFixProcessJob) => {
  const pipeline = job.pipeline
  job.pipeline = undefined
  job.child = undefined
  await pipeline?.close()
}
