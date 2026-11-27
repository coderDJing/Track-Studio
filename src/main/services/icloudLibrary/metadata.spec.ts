import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIcloudMetadataCache } from './metadata'
import { readIcloudMetadata } from './readMetadata'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
let root: string
const local = async () => 'local' as const
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-meta-')))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
const signal = () => new AbortController().signal
async function file(name = 'song.wav') {
  await fs.writeFile(path.join(root, name), 'resident fixture')
  return name
}
describe('resident-only iCloud metadata cache', () => {
  it('does not read audio for cloud, unknown, legacy placeholders or unsafe paths', async () => {
    await file()
    await file('.song.wav.icloud')
    await fs.symlink(os.tmpdir(), path.join(root, 'escape'))
    const reader = vi.fn(async () => [])
    for (const state of ['cloud', 'unknown'] as const) {
      const cache = createIcloudMetadataCache(async () => state, reader)
      expect((await cache.read(root, ['song.wav'], 'root', signal()))[0].metadata).toBeUndefined()
    }
    await createIcloudMetadataCache(local, reader).read(
      root,
      ['.song.wav.icloud', '../outside.wav', 'escape/outside.wav'],
      'root',
      signal()
    )
    expect(reader).not.toHaveBeenCalled()
  })
  it('reuses real signatures but invalidates on file change and root identity scope', async () => {
    await file()
    const reader = vi.fn(async () => [
      { relativePath: 'song.wav', metadata: { artist: 'Actual artist' } }
    ])
    const cache = createIcloudMetadataCache(local, reader)
    await cache.read(root, ['song.wav'], 'root-a', signal())
    await cache.read(root, ['song.wav'], 'root-a', signal())
    expect(reader).toHaveBeenCalledTimes(1)
    await fs.appendFile(path.join(root, 'song.wav'), ' changed')
    await cache.read(root, ['song.wav'], 'root-a', signal())
    expect(reader).toHaveBeenCalledTimes(2)
    await cache.read(root, ['song.wav'], 'root-b', signal())
    expect(reader).toHaveBeenCalledTimes(3)
    cache.clear()
    await cache.read(root, ['song.wav'], 'root-b', signal())
    expect(reader).toHaveBeenCalledTimes(4)
  })
  it('discards changed, evicted, cancelled and unsolicited worker results', async () => {
    await file()
    const controller = new AbortController()
    const cache = createIcloudMetadataCache(local, async () => {
      await fs.appendFile(path.join(root, 'song.wav'), ' changed')
      return [
        { relativePath: 'song.wav', metadata: { title: 'stale' } },
        { relativePath: 'other.wav', metadata: { title: 'injected' } }
      ]
    })
    expect(await cache.read(root, ['song.wav'], 'r', controller.signal)).toEqual([
      { relativePath: 'song.wav' }
    ])
    const evicted = createIcloudMetadataCache(
      async () => (controller.signal.aborted ? 'cloud' : 'local'),
      async () => {
        controller.abort()
        return [{ relativePath: 'song.wav', metadata: { title: 'late' } }]
      }
    )
    expect(
      (await evicted.read(root, ['song.wav'], 'r', controller.signal))[0].metadata
    ).toBeUndefined()
  })
  it('drops results after eviction even if the request itself was not cancelled', async () => {
    await file()
    let resident = true
    const cache = createIcloudMetadataCache(
      async () => (resident ? 'local' : 'cloud'),
      async () => {
        resident = false
        return [{ relativePath: 'song.wav', metadata: { artist: 'must not display' } }]
      }
    )
    expect(await cache.read(root, ['song.wav'], 'root', signal())).toEqual([
      { relativePath: 'song.wav' }
    ])
  })
  it('limits concurrent workers and forwards cancellation without starting an aborted request', async () => {
    await file()
    let finish!: (value: []) => void
    const pending = new Promise<[]>((resolve) => {
      finish = resolve
    })
    const reader = vi.fn(async () => pending),
      cache = createIcloudMetadataCache(local, reader)
    const a = cache.read(root, ['song.wav'], 'r', signal()),
      b = cache.read(root, ['song.wav'], 'r', signal())
    await expect(cache.read(root, ['song.wav'], 'r', signal())).rejects.toThrow('busy')
    finish([])
    await Promise.all([a, b])
    const abort = new AbortController()
    abort.abort()
    await expect(cache.read(root, ['song.wav'], 'r', abort.signal)).rejects.toThrow('cancelled')
    expect(reader).toHaveBeenCalledTimes(2)
  })
})
describe('safe descriptor-based real audio parser', () => {
  it('reads real PCM WAV duration without fabricating missing BPM or key', async () => {
    const wav = Buffer.alloc(32044)
    wav.write('RIFF')
    wav.writeUInt32LE(wav.length - 8, 4)
    wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(8000, 24)
    wav.writeUInt32LE(16000, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(32000, 40)
    await fs.writeFile(path.join(root, 'real.wav'), wav)
    const result = await readIcloudMetadata(root, 'real.wav', local)
    expect(result.duration).toBe('0:02')
    expect(result.container).toBe('WAVE')
    expect(result.bpm).toBeUndefined()
    expect(result.key).toBeUndefined()
  })
  it('refuses a replaced root identity before opening audio', async () => {
    await file()
    const open = vi.spyOn(fs, 'open')
    await expect(readIcloudMetadata(root, 'song.wav', local, `${root}:old:inode`)).rejects.toThrow(
      'boundary'
    )
    expect(open).not.toHaveBeenCalled()
  })
  it('fails closed before opening an unknown or cloud file', async () => {
    await file()
    const open = vi.spyOn(fs, 'open')
    await expect(readIcloudMetadata(root, 'song.wav', async () => 'cloud')).rejects.toThrow()
    await expect(readIcloudMetadata(root, 'song.wav', async () => 'unknown')).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
  it('checks the opened inode before any bytes can be read after a path replacement', async () => {
    await file()
    const open = fs.open.bind(fs),
      reads = vi.fn()
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(path.join(root, 'song.wav'), path.join(root, 'original.wav'))
      await fs.writeFile(path.join(root, 'song.wav'), 'replacement')
      const handle = await open(...args)
      vi.spyOn(handle, 'read').mockImplementation(reads)
      return handle
    })
    await expect(readIcloudMetadata(root, 'song.wav', local)).rejects.toThrow('boundary')
    expect(reads).not.toHaveBeenCalled()
  })
})
