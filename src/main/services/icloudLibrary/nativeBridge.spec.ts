import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/fixture/app' } }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn
}))
import { nativeLocalize } from './localization'
let child: EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}
beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  mocks.spawn.mockReset().mockReturnValue(child)
})
describe('native subprocess protocol and packaging', () => {
  it('passes a single scoped file to the public-API helper, propagates progress and waits for a successful exit', async () => {
    const signal = new AbortController().signal,
      status = vi.fn()
    const promise = nativeLocalize('/fixture/music', 'Album/song.mp3', signal, status)
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/fixture/app/resources/icloud-native/icloud-localize',
      ['download', '/fixture/music', 'Album/song.mp3'],
      { stdio: ['ignore', 'pipe', 'pipe'], signal }
    )
    child.stdout.write('{"state":"wait')
    child.stdout.write('ing"}\n{"state":"downloading"}\n{"state":"ready"}\n')
    let settled = false
    void promise.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(status.mock.calls.map(([value]) => value)).toEqual(['waiting', 'downloading'])
    child.emit('close', 0)
    await expect(promise).resolves.toBeUndefined()
  })
  it('never accepts a readiness line followed by native failure', async () => {
    const promise = nativeLocalize(
      '/fixture/music',
      'song.mp3',
      new AbortController().signal,
      vi.fn()
    )
    child.stdout.write('{"state":"ready"}\n')
    child.emit('close', 1)
    await expect(promise).rejects.toThrow('downloadFailed')
  })
  it('reports native offline and missing-helper errors without claiming download completion', async () => {
    const offline = nativeLocalize(
      '/fixture/music',
      'song.mp3',
      new AbortController().signal,
      vi.fn()
    )
    child.stdout.write('{"state":"failed","error":"offline"}\n')
    child.emit('close', 1)
    await expect(offline).rejects.toThrow('offline')
    const absent = nativeLocalize(
      '/fixture/music',
      'song.mp3',
      new AbortController().signal,
      vi.fn()
    )
    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(absent).rejects.toThrow('nativeUnavailable')
  })
  it('builds the helper for dev and packages it as a macOS resource, never for Windows', async () => {
    const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'))
    expect(manifest.scripts.build).toContain('ensure-icloud-native.mjs')
    expect(manifest.build.mac.extraResources).toContainEqual({
      from: 'resources/icloud-native',
      to: 'icloud-native'
    })
    expect(JSON.stringify(manifest.build.win)).not.toContain('icloud-native')
    expect(await fs.readFile('scripts/run-frkb-dev.mjs', 'utf8')).toContain(
      'ensure-icloud-native.mjs'
    )
  })
})
