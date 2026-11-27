import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  audioName,
  boundedPath,
  copySong,
  errorCode,
  isInside,
  listDirectory,
  readMacResidency,
  type ResidencyReader
} from './files'
import { icloudVisibility } from '../../../shared/icloudLibrary'

let root: string
let source: string
let target: string
const local: ResidencyReader = async () => 'local'
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-icloud-test-')))
  source = path.join(root, 'source')
  target = path.join(root, 'target')
  await fs.mkdir(source)
  await fs.mkdir(target)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
const copy = (name = 'song.mp3', residency = local) =>
  copySong({
    sourceRoot: source,
    sourceRelative: name,
    targetRoot: target,
    targetRelative: '',
    residency
  })

describe('iCloud discovery / metadata-only browsing', () => {
  it('only shows supported detected/configured libraries and retains configured offline entries', () => {
    expect(icloudVisibility(true, false, false)).toBe(false)
    expect(icloudVisibility(true, true, false)).toBe(true)
    expect(icloudVisibility(true, false, true)).toBe(true)
    expect(icloudVisibility(false, true, true)).toBe(false)
  })
  it('recognizes audio and legacy placeholders without reading contents', () => {
    expect(audioName('A.MP3')).toBe(true)
    expect(audioName('.song.flac.icloud')).toBe(true)
    expect(audioName('not-a-song.json')).toBe(false)
  })
  it('lists placeholder songs and subfolders, not links, metadata or folder contents', async () => {
    await fs.writeFile(path.join(source, '.song.mp3.icloud'), '')
    await fs.writeFile(path.join(source, 'other.txt'), '')
    await fs.writeFile(path.join(source, '.hidden.mp3'), '')
    await fs.mkdir(path.join(source, 'CloudFolder'))
    await fs.writeFile(path.join(source, 'CloudFolder', 'inner.mp3'), 'do-not-read')
    await fs.symlink(target, path.join(source, 'link'))
    const visited: string[] = []
    const entries = await listDirectory(source, '', async (file) => {
      visited.push(file)
      return 'local'
    })
    expect(entries.map((entry) => entry.name)).toEqual(['CloudFolder', 'song.mp3'])
    expect(entries.find((entry) => entry.name === 'song.mp3')?.residency).toBe('cloud')
    expect(visited).not.toContain(path.join(source, 'CloudFolder'))
    expect(await fs.readFile(path.join(source, '.song.mp3.icloud'), 'utf8')).toBe('')
  })
  it('refuses to enumerate a dataless directory', async () => {
    await expect(listDirectory(source, '', async () => 'cloud')).rejects.toThrow('download')
  })
  it('checks native metadata for local fixture only (macOS)', async () => {
    if (process.platform !== 'darwin') return
    await fs.writeFile(path.join(source, 'song.mp3'), 'fixture')
    expect(await readMacResidency(path.join(source, 'song.mp3'))).toBe('local')
    expect(await readMacResidency(path.join(source, '.song.mp3.icloud'))).toBe('cloud')
    expect(await readMacResidency(path.join(source, 'missing.mp3'))).toBe('unknown')
  })
})
describe('path boundaries', () => {
  it('rejects prefix siblings, traversal, absolute paths and NUL', async () => {
    expect(isInside(source, `${source}-other`)).toBe(false)
    for (const relative of ['../target', target, 'bad\0name']) {
      await expect(boundedPath(source, relative)).rejects.toThrow('boundary')
    }
  })
  it('rejects symlink files, intermediate symlink directories and replaced roots', async () => {
    await fs.writeFile(path.join(target, 'song.mp3'), 'outside')
    await fs.symlink(path.join(target, 'song.mp3'), path.join(source, 'song.mp3'))
    await fs.symlink(target, path.join(source, 'nested'))
    await expect(boundedPath(source, 'song.mp3')).rejects.toThrow('boundary')
    await expect(boundedPath(source, 'nested/song.mp3')).rejects.toThrow('boundary')
    await expect(boundedPath(path.join(source, 'nested'), '')).rejects.toThrow('boundary')
  })
  it('does not traverse dataless intermediate folders', async () => {
    await fs.mkdir(path.join(source, 'cloud'))
    // Descendant does not exist: download must win over ENOENT.
    await expect(
      boundedPath(source, 'cloud/unseen.mp3', async (file) =>
        file.endsWith('/cloud') ? 'cloud' : 'local'
      )
    ).rejects.toThrow('download')
  })
})
describe('song copying', () => {
  it('copies bytes and preserves source; reversing roots provides the other direction', async () => {
    await fs.writeFile(path.join(source, 'song.mp3'), 'audio-content')
    expect((await copy()).status).toBe('copied')
    expect(await fs.readFile(path.join(source, 'song.mp3'), 'utf8')).toBe('audio-content')
    expect(await fs.readFile(path.join(target, 'song.mp3'), 'utf8')).toBe('audio-content')
    await fs.mkdir(path.join(root, 'second-local'))
    expect(
      (
        await copySong({
          sourceRoot: target,
          sourceRelative: 'song.mp3',
          targetRoot: path.join(root, 'second-local'),
          targetRelative: '',
          residency: local
        })
      ).status
    ).toBe('copied')
  })
  it('skips same-name byte-identical files without altering source or destination', async () => {
    await fs.writeFile(path.join(source, 'song.mp3'), 'same')
    await fs.writeFile(path.join(target, 'song.mp3'), 'same')
    expect((await copy()).status).toBe('skipped')
    expect(await fs.readdir(target)).toEqual(['song.mp3'])
  })
  it('skips byte-identical local songs even when their filenames differ', async () => {
    await fs.writeFile(path.join(source, 'song.mp3'), 'same')
    await fs.writeFile(path.join(target, 'renamed.mp3'), 'same')
    expect(await copy()).toMatchObject({
      status: 'skipped',
      destination: path.join(target, 'renamed.mp3')
    })
    expect(await fs.readdir(target)).toEqual(['renamed.mp3'])
    expect(await fs.readFile(path.join(source, 'song.mp3'), 'utf8')).toBe('same')
  })
  it('honors cancellation during deduplication without creating a destination or deleting source', async () => {
    await fs.writeFile(path.join(source, 'song.mp3'), 'same')
    await fs.writeFile(path.join(target, 'renamed.mp3'), 'same')
    const controller = new AbortController()
    const result = await copySong({
      sourceRoot: source,
      sourceRelative: 'song.mp3',
      targetRoot: target,
      targetRelative: '',
      signal: controller.signal,
      residency: async (file) => {
        if (file === path.join(target, 'renamed.mp3')) controller.abort()
        return 'local'
      }
    })
    expect(result).toMatchObject({ status: 'failed', error: 'cancelled' })
    expect(await fs.readdir(target)).toEqual(['renamed.mp3'])
    expect(await fs.readFile(path.join(source, 'song.mp3'), 'utf8')).toBe('same')
  })
  it('renames same-name different contents and skips that new name on retry', async () => {
    await fs.writeFile(path.join(source, 'song.mp3'), 'new!')
    await fs.writeFile(path.join(target, 'song.mp3'), 'old!')
    const result = await copy()
    expect(result.destination).toBe(path.join(target, 'song (2).mp3'))
    expect(result.status).toBe('copied')
    expect(await fs.readFile(path.join(target, 'song.mp3'), 'utf8')).toBe('old!')
    expect(await fs.readFile(path.join(target, 'song (2).mp3'), 'utf8')).toBe('new!')
    expect((await copy()).status).toBe('skipped')
  })
  it.each(['cloud', 'unknown'] as const)('will not read a %s source', async (state) => {
    await fs.writeFile(path.join(source, 'song.mp3'), 'not-materialized')
    expect(
      await copy('song.mp3', async (file) => (file.endsWith('.mp3') ? state : 'local'))
    ).toMatchObject({ status: 'failed', error: 'download' })
    expect(await fs.readdir(target)).toEqual([])
  })
  it('never copies legacy placeholder bytes', async () => {
    await fs.writeFile(path.join(source, '.song.mp3.icloud'), 'placeholder-metadata')
    expect(await copy('.song.mp3.icloud')).toMatchObject({ status: 'failed', error: 'download' })
    expect(await fs.readdir(target)).toEqual([])
  })
  it('does not read/overwrite a cloud-only destination for deduplication', async () => {
    await fs.writeFile(path.join(source, 'song.mp3'), 'new')
    await fs.writeFile(path.join(target, 'song.mp3'), 'cloud-placeholder')
    expect(
      await copy('song.mp3', async (file) =>
        file === path.join(target, 'song.mp3') ? 'cloud' : 'local'
      )
    ).toMatchObject({ status: 'copied', destination: path.join(target, 'song (2).mp3') })
    expect(await fs.readFile(path.join(target, 'song.mp3'), 'utf8')).toBe('cloud-placeholder')
  })
  it('reserves logical destination names held by legacy placeholders', async () => {
    await fs.writeFile(path.join(source, 'song.mp3'), 'new-song')
    await fs.writeFile(path.join(target, '.song.mp3.icloud'), 'remote-placeholder')
    expect(await copy()).toMatchObject({
      status: 'copied',
      destination: path.join(target, 'song (2).mp3')
    })
    expect((await fs.readdir(target)).sort()).toEqual(['.song.mp3.icloud', 'song (2).mp3'].sort())
    expect(await fs.readFile(path.join(target, '.song.mp3.icloud'), 'utf8')).toBe(
      'remote-placeholder'
    )
  })
  it('fails safely for missing songs, non-audio and destination symlinks', async () => {
    expect(await copy()).toMatchObject({ status: 'failed', error: 'unavailable' })
    await fs.writeFile(path.join(source, 'notes.txt'), 'metadata')
    expect(await copy('notes.txt')).toMatchObject({ status: 'failed', error: 'invalid' })
    await fs.writeFile(path.join(source, 'song.mp3'), 'new')
    const outside = path.join(root, 'outside.mp3')
    await fs.writeFile(outside, 'original')
    await fs.symlink(outside, path.join(target, 'song.mp3'))
    expect(await copy()).toMatchObject({ status: 'failed', error: 'boundary' })
    expect(await fs.readFile(outside, 'utf8')).toBe('original')
    expect(await fs.readFile(path.join(source, 'song.mp3'), 'utf8')).toBe('new')
  })
  it('cleans only its own partial destination on a stream failure, retaining source bytes', async () => {
    await fs.writeFile(path.join(source, 'song.mp3'), Buffer.alloc(1024 * 1024, 7))
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] === 'wx') {
        const create = handle.createWriteStream.bind(handle)
        vi.spyOn(handle, 'createWriteStream').mockImplementation((options) => {
          const stream = create(options)
          queueMicrotask(() =>
            stream.destroy(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
          )
          return stream
        })
      }
      return handle
    })
    expect(await copy()).toMatchObject({ status: 'failed', error: 'space' })
    expect(await fs.readdir(target)).toEqual([])
    expect((await fs.stat(path.join(source, 'song.mp3'))).size).toBe(1024 * 1024)
  })
  it('maps offline, permission, disk-full and abort errors into actionable results', () => {
    expect(errorCode({ code: 'ENOSPC' })).toBe('space')
    expect(errorCode({ code: 'EACCES' })).toBe('permission')
    expect(errorCode({ code: 'ABORT_ERR' })).toBe('timeout')
    expect(errorCode({ code: 'ENOENT' })).toBe('unavailable')
  })
})
