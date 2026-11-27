import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
vi.mock('electron', () => ({ app: {} }))
import { localizeSong, parseNativeLocalizeEvent, type NativeLocalizer } from './localization'
let root: string
let resident: boolean
let controller: AbortController
let native: ReturnType<typeof vi.fn<NativeLocalizer>>
const residency = async (file: string) =>
  file === root || resident ? ('local' as const) : ('cloud' as const)
const run = (relative = 'song.mp3', timeoutMs = 1000) =>
  localizeSong({
    root,
    relative,
    residency,
    native,
    signal: controller.signal,
    status: status,
    timeoutMs
  })
const status = vi.fn()
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-cloud-localize-')))
  await fs.writeFile(path.join(root, 'song.mp3'), 'fixture only')
  resident = false
  controller = new AbortController()
  status.mockClear()
  native = vi.fn(async () => {
    resident = true
  })
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
describe('documented native download bridge orchestration', () => {
  it('never requests a native download for an already-local song', async () => {
    resident = true
    expect(await run()).toBe('song.mp3')
    expect(native).not.toHaveBeenCalled()
  })
  it('requests exactly the selected cloud song and rechecks residency before declaring readiness', async () => {
    expect(await run()).toBe('song.mp3')
    expect(native).toHaveBeenCalledWith(root, 'song.mp3', expect.any(AbortSignal), status)
    expect(status.mock.calls.map(([state]) => state)).toEqual(['waiting', 'ready'])
  })
  it('forwards the helper’s real percent to the existing status callback', async () => {
    native.mockImplementation(async (_root, _relative, _signal, report) => {
      report('downloading', 37)
      resident = true
    })
    expect(await run()).toBe('song.mp3')
    expect(status).toHaveBeenCalledWith('downloading', 37)
  })
  it('fails closed if native reports success but the file remains a placeholder', async () => {
    native.mockImplementation(async () => {})
    await expect(run()).rejects.toThrow('download')
    expect(status).not.toHaveBeenCalledWith('ready')
  })
  it('aborts waiting immediately and ignores a later native completion', async () => {
    let finish!: () => void
    native.mockImplementation(async (_root, _relative, signal) => {
      queueMicrotask(() => controller.abort())
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      expect(signal.aborted).toBe(true)
      resident = true
    })
    await expect(run()).rejects.toThrow('cancelled')
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(status).not.toHaveBeenCalledWith('ready')
  })
  it('times out without claiming readiness and allows a fresh retry', async () => {
    native.mockImplementation(() => new Promise(() => {}))
    await expect(run('song.mp3', 10)).rejects.toThrow('timeout')
    expect(status).not.toHaveBeenCalledWith('ready')
    native.mockImplementation(async () => {
      resident = true
    })
    expect(await run()).toBe('song.mp3')
  })
  it.each(['offline', 'nativeUnavailable', 'downloadFailed'])(
    'preserves actionable %s errors without fake readiness',
    async (error) => {
      native.mockRejectedValue(new Error(error))
      await expect(run()).rejects.toThrow(error)
      expect(status).not.toHaveBeenCalledWith('ready')
    }
  )
  it('rejects pre-cancelled, escaping and symbolic-link requests before any native call', async () => {
    controller.abort()
    await expect(run()).rejects.toThrow('cancelled')
    controller = new AbortController()
    await expect(run('../outside.mp3')).rejects.toThrow('boundary')
    await fs.symlink(path.join(root, 'song.mp3'), path.join(root, 'link.mp3'))
    await expect(run('link.mp3')).rejects.toThrow('boundary')
    expect(native).not.toHaveBeenCalled()
  })
  it('handles a legacy .icloud stub becoming the logical file and retries after the stub disappears', async () => {
    await fs.writeFile(path.join(root, '.legacy.mp3.icloud'), '')
    native.mockImplementation(async () => {
      await fs.writeFile(path.join(root, 'legacy.mp3'), 'download fixture')
      await fs.unlink(path.join(root, '.legacy.mp3.icloud'))
      resident = true
    })
    expect(await run('.legacy.mp3.icloud')).toBe('legacy.mp3')
    expect(await run('.legacy.mp3.icloud')).toBe('legacy.mp3')
    expect(native).toHaveBeenCalledTimes(1)
  })
})

describe('native helper progress events', () => {
  it('forwards a real 0–100 percent on downloading and omits missing or illegal values', () => {
    expect(parseNativeLocalizeEvent({ state: 'downloading', percent: 37 })).toEqual({
      kind: 'status',
      state: 'downloading',
      percent: 37
    })
    expect(parseNativeLocalizeEvent({ state: 'downloading', percent: 0 })).toEqual({
      kind: 'status',
      state: 'downloading',
      percent: 0
    })
    expect(parseNativeLocalizeEvent({ state: 'waiting' })).toEqual({
      kind: 'status',
      state: 'waiting'
    })
    expect(parseNativeLocalizeEvent({ state: 'downloading' })).toEqual({
      kind: 'status',
      state: 'downloading'
    })
    expect(parseNativeLocalizeEvent({ state: 'downloading', percent: Number.NaN })).toEqual({
      kind: 'status',
      state: 'downloading'
    })
    expect(parseNativeLocalizeEvent({ state: 'downloading', percent: 140 })).toEqual({
      kind: 'status',
      state: 'downloading'
    })
    expect(parseNativeLocalizeEvent({ state: 'downloading', percent: '37' })).toEqual({
      kind: 'status',
      state: 'downloading'
    })
    expect(parseNativeLocalizeEvent({ state: 'ready', percent: 100 })).toEqual({ kind: 'ready' })
  })
})
