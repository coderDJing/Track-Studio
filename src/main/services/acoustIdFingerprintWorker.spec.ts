import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateChromaprintFingerprint } from 'rust_package'
import {
  cancelFingerprintRequests,
  generateFingerprintOffMainThread
} from './acoustIdFingerprintWorker'

// 先 pnpm run build，再 pnpm exec vitest run src/main/services/acoustIdFingerprintWorker.spec.ts。
const mocks = vi.hoisted(() => ({ workerPath: '' }))
vi.mock('../workerPath', () => ({ resolveMainWorkerPath: () => mocks.workerPath }))
vi.mock('../log', () => ({ log: { error: vi.fn() } }))

let testRoot = ''
beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-fingerprint-worker-'))
  mocks.workerPath = path.join(testRoot, 'slow-worker.cjs')
  await fs.writeFile(
    mocks.workerPath,
    `const { parentPort } = require('node:worker_threads')
parentPort.on('message', ({ requestId, filePath, maxLengthSeconds }) => {
  if (filePath === 'crash') process.exit(7)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180)
  if (filePath === 'error') parentPort.postMessage({ requestId, error: 'TEST_NATIVE_ERROR' })
  else parentPort.postMessage({ requestId, result: { fingerprint: filePath, duration: maxLengthSeconds } })
})`
  )
})

afterEach(async () => {
  cancelFingerprintRequests()
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe('AcoustID fingerprint worker', () => {
  it('worker 同步阻塞时主进程仍能执行心跳，并正确关联并发请求', async () => {
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    try {
      const results = await Promise.all([
        generateFingerprintOffMainThread('first', 120),
        generateFingerprintOffMainThread('second', 60)
      ])
      expect(results).toEqual([
        { fingerprint: 'first', duration: 120 },
        { fingerprint: 'second', duration: 60 }
      ])
      expect(ticks).toBeGreaterThanOrEqual(5)
    } finally {
      clearInterval(timer)
    }
  })

  it('取消会结清所有在途请求，下一次调用可重新创建 worker', async () => {
    const first = generateFingerprintOffMainThread('first', 120)
    const second = generateFingerprintOffMainThread('second', 120)
    const assertions = Promise.all([
      expect(first).rejects.toThrow('ACOUSTID_ABORTED'),
      expect(second).rejects.toThrow('ACOUSTID_ABORTED')
    ])
    cancelFingerprintRequests()
    await assertions
    expect(await generateFingerprintOffMainThread('after-cancel', 120)).toEqual({
      fingerprint: 'after-cancel',
      duration: 120
    })
  })

  it('原生异常只拒绝对应请求，后续请求仍可完成', async () => {
    await expect(generateFingerprintOffMainThread('error', 120)).rejects.toThrow(
      'TEST_NATIVE_ERROR'
    )
    expect((await generateFingerprintOffMainThread('next', 120)).fingerprint).toBe('next')
  })

  it('worker 崩溃时拒绝全部请求，后续调用可恢复', async () => {
    const first = generateFingerprintOffMainThread('crash', 120)
    const second = generateFingerprintOffMainThread('queued', 120)
    await Promise.all([
      expect(first).rejects.toThrow('ACOUSTID_WORKER_EXIT:7'),
      expect(second).rejects.toThrow('ACOUSTID_WORKER_EXIT:7')
    ])
    expect((await generateFingerprintOffMainThread('after-crash', 120)).fingerprint).toBe(
      'after-crash'
    )
  })

  it('实际 Rust 模块在 worker 和原调用路径上产生相同指纹', async () => {
    cancelFingerprintRequests()
    mocks.workerPath = path.resolve('out/main/workers/acoustIdFingerprintWorker.js')
    const sampleRate = 44100
    const frames = sampleRate * 12
    const pcmBytes = frames * 2
    const wave = Buffer.alloc(44 + pcmBytes)
    wave.write('RIFF', 0)
    wave.writeUInt32LE(wave.length - 8, 4)
    wave.write('WAVEfmt ', 8)
    wave.writeUInt32LE(16, 16)
    wave.writeUInt16LE(1, 20)
    wave.writeUInt16LE(1, 22)
    wave.writeUInt32LE(sampleRate, 24)
    wave.writeUInt32LE(sampleRate * 2, 28)
    wave.writeUInt16LE(2, 32)
    wave.writeUInt16LE(16, 34)
    wave.write('data', 36)
    wave.writeUInt32LE(pcmBytes, 40)
    for (let frame = 0; frame < frames; frame++) {
      const seconds = frame / sampleRate
      wave.writeInt16LE(
        Math.round(10000 * Math.sin(2 * Math.PI * (220 + seconds * 12) * seconds)),
        44 + frame * 2
      )
    }
    const audioPath = path.join(testRoot, 'sample.wav')
    await fs.writeFile(audioPath, wave)
    const original = generateChromaprintFingerprint(audioPath, 8)
    const threaded = await generateFingerprintOffMainThread(audioPath, 8)
    expect(original.error).toBeFalsy()
    expect(original.fingerprint.length).toBeGreaterThan(0)
    expect(threaded).toEqual(original)
  })
})
