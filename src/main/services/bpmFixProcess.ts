import { app } from 'electron'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import type { BpmFixRuntime } from '../../shared/bpmFix'
import { registerChildProcess, terminateChildProcess } from './childProcessRegistry'
import { lowerAnalysisProcessPriority } from '../workers/analysisRuntimeTuning'
import { resolveMainWorkerPath } from '../workerPath'

export type BpmFixProcessJob = { cancelled: boolean; child?: ChildProcess; worker?: Worker }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

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
  analysis?: unknown
) => {
  if (job.cancelled) throw new Error('BPM_FIX_CANCELLED')
  const child = spawn(runtime.command, [...runtime.args, ...args, '--device', runtime.device], {
    env: runtime.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(analysis ? JSON.stringify(analysis) + '\n' : '')
  job.child = child
  const unregister = registerChildProcess(child, 'bpm-fix')
  lowerAnalysisProcessPriority(child)
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let buffer = ''
      let stderr = ''
      let result: unknown
      let failure = ''
      const stages = new Set([
        'loading',
        'decoding',
        'analyzing',
        'crosschecking',
        'planning',
        'rendering',
        'encoding',
        'verifying',
        'saving'
      ])
      child.stderr?.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString('utf8')).slice(-6000)
      })
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (data: string) => {
        buffer += data
        if (buffer.length > 2_000_000) {
          failure = 'BPM_FIX_INVALID_RESULT'
          terminateChildProcess(child, 'bpm-fix')
          return
        }
        let end: number
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          try {
            const message: unknown = JSON.parse(line)
            if (!isRecord(message)) continue
            if (
              message.type === 'progress' &&
              typeof message.stage === 'string' &&
              stages.has(message.stage)
            ) {
              progress(message.stage, Number(message.percent) || 0)
            } else if (message.type === 'error' && typeof message.error === 'string') {
              failure = message.error
            } else if (message.type === 'result') {
              result = message.result
            }
          } catch (error) {
            if (error instanceof Error && error.message === 'BPM_FIX_INVALID_RESULT')
              failure = error.message
          }
        }
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (job.cancelled) reject(new Error('BPM_FIX_CANCELLED'))
        else if (code !== 0 || !result || failure)
          reject(new Error(failure || stderr || 'BPM_FIX_FAILED'))
        else resolve(result)
      })
    })
  } finally {
    unregister()
    job.child = undefined
  }
}
