import { spawn, type ChildProcess } from 'node:child_process'
import type { BpmFixRuntime } from '../../shared/bpmFix'
import { registerChildProcess, terminateChildProcess } from './childProcessRegistry'
import { lowerAnalysisProcessPriority } from '../workers/analysisRuntimeTuning'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
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
type Request = {
  id: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  progress: (stage: string, percent: number) => void
  diagnostic?: (details: Record<string, unknown>) => void
}

// One sequential worker per active batch. Release it while the user reviews
// analysis, on completion, on cancellation, and when the owner closes.
export class BpmFixPipeline {
  readonly child: ChildProcess
  private pending?: Request
  private sequence = 0
  private buffer = ''
  private stderr = ''
  private stopped = false
  private closed: Promise<void>

  constructor(runtime: BpmFixRuntime, script: string) {
    this.child = spawn(runtime.command, [...runtime.args, script, '--worker'], {
      env: runtime.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const unregister = registerChildProcess(this.child, 'bpm-fix')
    lowerAnalysisProcessPriority(this.child)
    this.closed = new Promise((resolve) => {
      this.child.once('close', () => {
        this.fail(new Error(this.stderr || 'BPM_FIX_WORKER_EXITED'))
        unregister()
        resolve()
      })
    })
    this.child.once('error', (error) => this.fail(error))
    this.child.stdin?.on('error', (error) => this.fail(error))
    this.child.stderr?.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString('utf8')).slice(-6000)
    })
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (data: string) => this.receive(data))
  }

  private fail(error: Error) {
    this.stopped = true
    const pending = this.pending
    this.pending = undefined
    pending?.reject(error)
  }

  private receive(data: string) {
    this.buffer += data
    if (this.buffer.length > 2_000_000) {
      this.fail(new Error('BPM_FIX_INVALID_RESULT'))
      terminateChildProcess(this.child, 'bpm-fix')
      return
    }
    let end: number
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const pending = this.pending
      if (!pending || !isRecord(message) || message.requestId !== pending.id) continue
      if (
        message.type === 'progress' &&
        typeof message.stage === 'string' &&
        stages.has(message.stage)
      ) {
        pending.progress(message.stage, Number(message.percent) || 0)
      } else if (
        message.type === 'diagnostic' &&
        message.event === 'verification' &&
        isRecord(message.details)
      ) {
        pending.diagnostic?.(message.details)
      } else if (message.type === 'result' || message.type === 'error') {
        this.pending = undefined
        if (message.type === 'error')
          pending.reject(new Error(String(message.error || 'BPM_FIX_FAILED')))
        else if (!isRecord(message.result)) pending.reject(new Error('BPM_FIX_INVALID_RESULT'))
        else pending.resolve(message.result)
      }
    }
  }

  run(
    args: string[],
    analysis: unknown,
    progress: Request['progress'],
    diagnostic?: Request['diagnostic']
  ) {
    if (this.stopped) return Promise.reject(new Error('BPM_FIX_WORKER_EXITED'))
    if (this.pending) return Promise.reject(new Error('BPM_FIX_BUSY'))
    this.stderr = ''
    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.sequence
      this.pending = { id, resolve, reject, progress, diagnostic }
      this.child.stdin!.write(JSON.stringify({ requestId: id, args, analysis }) + '\n', (error) => {
        if (error) this.fail(error)
      })
    })
  }

  async close() {
    this.fail(new Error('BPM_FIX_CANCELLED'))
    this.child.stdin?.end()
    const timer = setTimeout(() => terminateChildProcess(this.child, 'bpm-fix'), 2000)
    try {
      await this.closed
    } finally {
      clearTimeout(timer)
    }
  }
}
