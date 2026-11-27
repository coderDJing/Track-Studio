import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { coverWave, coverPng } from '../../../../tests/icloudCoverFixture'
import { readIcloudMetadata } from './readMetadata'
import { embeddedPicture } from './embeddedPicture'
import { createIcloudMetadataCache } from './metadata'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
let root: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-cover-')))
  await fs.writeFile(path.join(root, 'cover.wav'), coverWave())
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
describe('resident embedded covers with no cloud writes', () => {
  it('extracts a real WAV APIC PNG and hash; normal metadata does not read pictures', async () => {
    const before = await fs.readdir(root)
    const value = await readIcloudMetadata(root, 'cover.wav', async () => 'local', undefined, true)
    expect(value.picture?.data).toBe(coverPng.toString('base64'))
    expect(value.picture?.format).toBe('image/png')
    expect(value.picture?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(
      (await readIcloudMetadata(root, 'cover.wav', async () => 'local')).picture
    ).toBeUndefined()
    expect(await fs.readdir(root)).toEqual(before)
  })
  it('does not open cloud or unknown files, even for an explicit cover request', async () => {
    const open = vi.spyOn(fs, 'open')
    for (const state of ['cloud', 'unknown'] as const)
      await expect(
        readIcloudMetadata(root, 'cover.wav', async () => state, undefined, true)
      ).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
  it('rejects replaced roots and symlink escapes before opening image bytes', async () => {
    await fs.symlink(path.join(root, 'cover.wav'), path.join(root, 'link.wav'))
    const open = vi.spyOn(fs, 'open')
    await expect(
      readIcloudMetadata(root, 'cover.wav', async () => 'local', 'old-root', true)
    ).rejects.toThrow()
    await expect(
      readIcloudMetadata(root, 'link.wav', async () => 'local', undefined, true)
    ).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
  it('bounds encoded size and dimensions and tolerates malformed JPEG markers', () => {
    expect(embeddedPicture('image/png', coverPng)?.format).toBe('image/png')
    expect(embeddedPicture('image/png', Buffer.alloc(1024 * 1024 + 1))).toBeUndefined()
    const huge = Buffer.from(coverPng)
    huge.writeUInt32BE(5000, 16)
    expect(embeddedPicture('image/png', huge)).toBeUndefined()
    expect(embeddedPicture('image/gif', coverPng)).toBeUndefined()
    expect(() =>
      embeddedPicture('image/jpeg', Buffer.from([255, 216, 255, 255, 255, 255]))
    ).not.toThrow()
  })
})

it('bounds the app-memory picture cache and invalidates changed files and root scopes', async () => {
  for (const name of ['b.wav', 'c.wav']) await fs.writeFile(path.join(root, name), coverWave())
  const reader = vi.fn(
    async (root: string, paths: string[], _signal: AbortSignal, identity: string) =>
      Promise.all(
        paths.map(async (relativePath) => ({
          relativePath,
          metadata: await readIcloudMetadata(
            root,
            relativePath,
            async () => 'local',
            identity,
            true
          )
        }))
      )
  )
  const cache = createIcloudMetadataCache(async () => 'local', reader, 2),
    signal = new AbortController().signal
  const read = (name: string, scope = 'root') => cache.read(root, [name], scope, signal)
  expect((await read('cover.wav'))[0].metadata?.picture?.data).toBe(coverPng.toString('base64'))
  await read('cover.wav')
  expect(reader).toHaveBeenCalledTimes(1)
  await fs.appendFile(path.join(root, 'cover.wav'), 'changed')
  await read('cover.wav')
  expect(reader).toHaveBeenCalledTimes(2)
  await read('cover.wav', 'new-root')
  expect(reader).toHaveBeenCalledTimes(3)
  await read('b.wav', 'new-root')
  await read('c.wav', 'new-root')
  await read('cover.wav', 'new-root')
  expect(reader).toHaveBeenCalledTimes(6)
  expect(await fs.readdir(root)).toEqual(['b.wav', 'c.wav', 'cover.wav'])
})
