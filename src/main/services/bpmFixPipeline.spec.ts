import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BpmFixPipeline } from './bpmFixPipeline'
import { spawn } from 'node:child_process'
import { terminateChildProcess } from './childProcessRegistry'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('./childProcessRegistry', () => ({
  registerChildProcess: vi.fn(() => vi.fn()),
  terminateChildProcess: vi.fn()
}))
vi.mock('../workers/analysisRuntimeTuning', () => ({ lowerAnalysisProcessPriority: vi.fn() }))

const runtime = { command: 'managed-python', args: [], env: {}, device: 'cpu' }
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
let requests: Array<{ requestId: number; args: string[]; analysis?: unknown }>
beforeEach(() => {
  vi.clearAllMocks()
  requests = []
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  child.stdin.on('data', (data: Buffer) => requests.push(JSON.parse(data.toString())))
  child.stdin.on('finish', () => child.emit('close', 0))
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess)
})
const respond = (
  type: 'result' | 'error',
  result: unknown,
  requestId = requests.at(-1)!.requestId
) => {
  child.stdout.write(JSON.stringify({ requestId, type, result, error: result }) + '\n')
}

describe('sequential BPM model worker', () => {
  it('reuses the process after successes and recoverable per-song failures', async () => {
    const worker = new BpmFixPipeline(runtime, 'bpm_fix.py')
    for (const succeeds of [true, false, true]) {
      const result = worker.run(['--input', 'song'], { beats: [1, 2] }, vi.fn())
      const assertion = succeeds
        ? expect(result).resolves.toEqual({ public: {} })
        : expect(result).rejects.toThrow('BAD_TRACK')
      respond(succeeds ? 'result' : 'error', succeeds ? { public: {} } : 'BAD_TRACK')
      await assertion
    }
    expect(spawn).toHaveBeenCalledOnce()
    expect(requests.map((request) => request.requestId)).toEqual([1, 2, 3])
    expect(requests[0].analysis).toEqual({ beats: [1, 2] })
    await worker.close()
  })

  it('routes progress and ignores stale responses without completing the next song', async () => {
    const worker = new BpmFixPipeline(runtime, 'bpm_fix.py')
    const progress = vi.fn()
    const result = worker.run([], undefined, progress)
    respond('result', { wrong: true }, 999)
    child.stdout.write(
      JSON.stringify({ requestId: 1, type: 'progress', stage: 'rendering', percent: 50 }) + '\n'
    )
    await expect(worker.run([], undefined, vi.fn())).rejects.toThrow('BPM_FIX_BUSY')
    respond('result', { good: true })
    await expect(result).resolves.toEqual({ good: true })
    expect(progress).toHaveBeenCalledWith('rendering', 50)
    await worker.close()
  })

  it('rejects an active song on exit and never silently starts a replacement process', async () => {
    const worker = new BpmFixPipeline(runtime, 'bpm_fix.py')
    const result = worker.run([], undefined, vi.fn())
    const assertion = expect(result).rejects.toThrow('BPM_FIX_WORKER_EXITED')
    child.emit('close', 1)
    await assertion
    await expect(worker.run([], undefined, vi.fn())).rejects.toThrow('BPM_FIX_WORKER_EXITED')
    expect(spawn).toHaveBeenCalledOnce()
    await worker.close()
  })

  it('cancels active requests and releases the worker', async () => {
    const worker = new BpmFixPipeline(runtime, 'bpm_fix.py')
    const result = worker.run([], undefined, vi.fn())
    const assertion = expect(result).rejects.toThrow('BPM_FIX_CANCELLED')
    await worker.close()
    await assertion
    expect(terminateChildProcess).not.toHaveBeenCalled()
  })
})
