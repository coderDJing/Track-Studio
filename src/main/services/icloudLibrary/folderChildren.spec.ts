import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createFolderChildInspector } from './folderChildren'
import type { IcloudEntry } from '../../../shared/icloudLibrary'
let root: string
const local = async () => 'local' as const
const entry = (name: string, residency: IcloudEntry['residency'] = 'local'): IcloudEntry => ({
  name,
  relativePath: name,
  directory: true,
  residency
})
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-folder-hint-')))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
describe('bounded metadata-only child-directory presence', () => {
  it('knows initial empty, document-only and audio-only leaves, without opening grandchildren or file contents', async () => {
    for (const folder of ['Empty', 'Documents', 'Music', 'Parent/Nested/Deep'])
      await fs.mkdir(path.join(root, folder), { recursive: true })
    await fs.writeFile(path.join(root, 'Documents/note.txt'), 'fixture')
    await fs.writeFile(path.join(root, 'Music/song.mp3'), 'fixture')
    const open = vi.spyOn(fs, 'opendir'),
      read = vi.spyOn(fs, 'readFile')
    const entries = ['Empty', 'Documents', 'Music', 'Parent'].map((name) => entry(name))
    await createFolderChildInspector().inspect(root, entries, local)
    expect(entries.map((value) => value.hasChildren)).toEqual([false, false, false, true])
    expect(open.mock.calls.map(([file]) => file).sort()).toEqual(
      entries.map((value) => path.join(root, value.name)).sort()
    )
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps unlocalized/unknown/denied directories unknown and permits recovery instead of caching a failure as empty', async () => {
    for (const name of ['Remote', 'Unknown', 'Denied']) await fs.mkdir(path.join(root, name))
    const original = fs.opendir,
      open = vi.spyOn(fs, 'opendir')
    open.mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
      if (args[0] === path.join(root, 'Denied'))
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return original(...args)
    })
    const entries = [entry('Remote', 'cloud'), entry('Unknown', 'unknown'), entry('Denied')]
    const inspector = createFolderChildInspector()
    await inspector.inspect(root, entries, local)
    expect(entries.map((value) => value.hasChildren)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(open.mock.calls.map(([file]) => file)).toEqual([path.join(root, 'Denied')])
    open.mockRestore()
    await inspector.inspect(root, entries.slice(2), local)
    expect(entries[2].hasChildren).toBe(false)
  })
  it('rejects escaping or symlink paths and does not count a symlink as a child directory', async () => {
    await fs.mkdir(path.join(root, 'OnlyLink'))
    await fs.symlink(os.tmpdir(), path.join(root, 'Escape'))
    await fs.symlink(os.tmpdir(), path.join(root, 'OnlyLink/Alias'))
    const entries = [entry('Escape'), entry('../escape'), entry('OnlyLink')]
    const open = vi.spyOn(fs, 'opendir')
    await createFolderChildInspector().inspect(root, entries, local)
    expect(entries.map((value) => value.hasChildren)).toEqual(['unknown', 'unknown', false])
    expect(open.mock.calls.map(([file]) => file)).toEqual([path.join(root, 'OnlyLink')])
  })
  it('bounds large scans, reuses unchanged metadata results and updates leaf hints after directory changes', async () => {
    await fs.mkdir(path.join(root, 'Large'))
    for (const file of ['1.txt', '2.txt', '3.txt'])
      await fs.writeFile(path.join(root, 'Large', file), '')
    const entries = [entry('Large')],
      open = vi.spyOn(fs, 'opendir')
    const inspector = createFolderChildInspector({ maxEntries: 1 })
    await inspector.inspect(root, entries, local)
    expect(entries[0].hasChildren).toBe('unknown')
    await inspector.inspect(root, entries, local)
    expect(open).toHaveBeenCalledTimes(1)
    for (const file of ['1.txt', '2.txt', '3.txt']) await fs.unlink(path.join(root, 'Large', file))
    await fs.mkdir(path.join(root, 'Large/Nested'))
    await inspector.inspect(root, entries, local)
    expect(entries[0].hasChildren).toBe(true)
    await fs.rmdir(path.join(root, 'Large/Nested'))
    await inspector.inspect(root, entries, local)
    expect(entries[0].hasChildren).toBe(false)
  })
  it('has a per-request folder/entry budget and bounded concurrency, leaving excess work unknown', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(String(i)))
    for (const value of entries) await fs.mkdir(path.join(root, value.name))
    const original = fs.opendir
    let active = 0,
      maximum = 0
    const open = vi
      .spyOn(fs, 'opendir')
      .mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
        maximum = Math.max(maximum, ++active)
        await new Promise<void>((resolve) => setImmediate(resolve))
        try {
          return await original(...args)
        } finally {
          active--
        }
      })
    await createFolderChildInspector({ maxFolders: 5 }).inspect(root, entries, local)
    expect(open).toHaveBeenCalledTimes(5)
    expect(maximum).toBeLessThanOrEqual(4)
    expect(entries.filter((value) => value.hasChildren === 'unknown')).toHaveLength(3)
  })
})
