import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

import type { IcloudResidency } from '../../../shared/icloudLibrary'
import { evictLocalCopies } from './evictLocal'

const residencyOf = (read: (candidate: string) => IcloudResidency) => async (candidate: string) =>
  read(candidate)

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'frkb-evict-'))
  roots.push(root)
  const file = path.join(root, 'song.mp3')
  await fs.writeFile(file, 'keep-me')
  return { root, file }
}

it('leaves the bytes in place when the system call does not actually drop the local copy', async () => {
  const { root, file } = await fixture()
  const native = vi.fn(async () => 'evicted' as const)
  const [result] = await evictLocalCopies({
    root,
    relatives: ['song.mp3'],
    residency: residencyOf(() => 'local'),
    native,
    playing: () => false
  })
  expect(result).toEqual({ relative: 'song.mp3', status: 'failed', error: 'failed' })
  expect(await fs.readFile(file, 'utf8')).toBe('keep-me')
  expect(native).toHaveBeenCalledTimes(1)
})

it('reports eviction only after the file is no longer a local copy and still exists', async () => {
  const { root, file } = await fixture()
  let resident = true
  const native = vi.fn(async () => {
    resident = false
    return 'evicted' as const
  })
  const [result] = await evictLocalCopies({
    root,
    relatives: ['song.mp3'],
    residency: residencyOf((candidate) =>
      candidate === file ? (resident ? 'local' : 'cloud') : 'local'
    ),
    native,
    playing: () => false
  })
  expect(result.status).toBe('evicted')
  expect(await fs.readFile(file, 'utf8')).toBe('keep-me')
})

it('does not ask the system to evict a playing song, a cloud song, or a placeholder', async () => {
  const { root, file } = await fixture()
  const cloud = path.join(root, 'cloud.mp3')
  const placeholder = path.join(root, '.kept.mp3.icloud')
  await fs.writeFile(cloud, 'cloud')
  await fs.writeFile(placeholder, 'placeholder')
  const native = vi.fn(async () => 'evicted' as const)
  const results = await evictLocalCopies({
    root,
    relatives: ['song.mp3', 'cloud.mp3', '.kept.mp3.icloud'],
    residency: residencyOf((candidate) => (candidate === cloud ? 'cloud' : 'local')),
    native,
    playing: (relative) => relative === 'song.mp3'
  })
  expect(native).not.toHaveBeenCalled()
  expect(results).toEqual([
    { relative: 'song.mp3', status: 'failed', error: 'playing' },
    { relative: 'cloud.mp3', status: 'skipped' },
    { relative: '.kept.mp3.icloud', status: 'skipped' }
  ])
  expect(await fs.readFile(file, 'utf8')).toBe('keep-me')
  expect(await fs.readFile(cloud, 'utf8')).toBe('cloud')
  expect(await fs.readFile(placeholder, 'utf8')).toBe('placeholder')
})

it('keeps a refused upload from being reported as removed', async () => {
  const { root, file } = await fixture()
  const [result] = await evictLocalCopies({
    root,
    relatives: ['song.mp3'],
    residency: residencyOf(() => 'local'),
    native: async () => {
      throw new Error('uploading')
    },
    playing: () => false
  })
  expect(result).toEqual({ relative: 'song.mp3', status: 'failed', error: 'uploading' })
  expect(await fs.readFile(file, 'utf8')).toBe('keep-me')
})

it('the helper refuses a normal file without deleting it', async () => {
  const binary = path.join(process.cwd(), 'resources/icloud-native/icloud-localize')
  const { root, file } = await fixture()
  const ran = spawnSync(binary, ['evict', root, 'song.mp3'], { encoding: 'utf8' })
  expect(await fs.readFile(file, 'utf8')).toBe('keep-me')
  expect(ran.stdout).toContain('"error":"notCloud"')
  expect(ran.status).not.toBe(0)
  const placeholder = path.join(root, '.cloud.mp3.icloud')
  await fs.writeFile(placeholder, 'placeholder')
  const skipped = spawnSync(binary, ['evict', root, '.cloud.mp3.icloud'], { encoding: 'utf8' })
  expect(skipped.status).toBe(0)
  expect(skipped.stdout).toContain('"state":"skipped"')
  expect(await fs.readFile(placeholder, 'utf8')).toBe('placeholder')
})
