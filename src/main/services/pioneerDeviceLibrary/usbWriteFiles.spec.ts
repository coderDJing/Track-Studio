import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../log'
import { commitUsbFiles, recoverUsbWrite, resolveUsbFile, usbFileHash } from './usbWriteFiles'

const directories: string[] = []
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-usb-transaction-test-'))
  directories.push(root)
  await fs.mkdir(path.join(root, 'PIONEER', 'rekordbox'), { recursive: true })
  const target = path.join(root, 'PIONEER', 'rekordbox', 'export.pdb')
  const staged = path.join(root, 'staged')
  const audio = path.join(root, 'track.mp3')
  await fs.writeFile(target, 'before')
  await fs.writeFile(staged, 'after')
  await fs.writeFile(audio, 'audio')
  return { root, target, staged, audio }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of directories.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('USB multi-file transactions', () => {
  it('reports a durable commit as successful when only backup cleanup fails', async () => {
    const { root, target, staged, audio } = await fixture()
    const expected = new Map([
      [target, await usbFileHash(target)],
      [audio, await usbFileHash(audio)]
    ])
    const realRemove = fs.rm.bind(fs)
    const folder = path.join(root, 'PIONEER', 'rekordbox', '.frkb-write-transaction')
    const cleanupError = Object.assign(new Error('busy backup directory'), { code: 'EBUSY' })
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === folder) {
        // Recursive cleanup can remove some backups before hitting a locked file.
        await fs.unlink(path.join(folder, 'before', '0'))
        throw cleanupError
      }
      return realRemove(target, options)
    })
    await commitUsbFiles(root, [{ target, staged }], [audio], expected)
    expect(await fs.readFile(target, 'utf8')).toBe('after')
    await expect(fs.access(audio)).rejects.toThrow()
    expect(JSON.parse(await fs.readFile(path.join(folder, 'journal.json'), 'utf8')).status).toBe(
      'committed'
    )
    expect(errorLog).toHaveBeenCalledOnce()
    vi.restoreAllMocks()
    await recoverUsbWrite(root)
    await expect(fs.access(folder)).rejects.toThrow()
  })
  it('commits replacements and physically removes audio and transaction copies', async () => {
    const { root, target, staged, audio } = await fixture()
    await commitUsbFiles(
      root,
      [{ target, staged }],
      [audio],
      new Map([
        [target, await usbFileHash(target)],
        [audio, await usbFileHash(audio)]
      ])
    )
    expect(await fs.readFile(target, 'utf8')).toBe('after')
    await expect(fs.access(audio)).rejects.toThrow()
    await expect(
      fs.access(path.join(root, 'PIONEER', 'rekordbox', '.frkb-write-transaction'))
    ).rejects.toThrow()
  })
  it('refuses stale previews before writing a database', async () => {
    const { root, target, staged } = await fixture()
    const expected = new Map([[target, await usbFileHash(target)]])
    await fs.writeFile(target, 'external edit')
    await expect(commitUsbFiles(root, [{ target, staged }], [], expected)).rejects.toThrow(
      '发生变化'
    )
    expect(await fs.readFile(target, 'utf8')).toBe('external edit')
  })
  it('restores an interrupted replacement plus missing deleted file from durable journal', async () => {
    const { root, target, staged, audio } = await fixture()
    const folder = path.join(root, 'PIONEER', 'rekordbox', '.frkb-write-transaction')
    await fs.mkdir(path.join(folder, 'before'), { recursive: true })
    await fs.copyFile(target, path.join(folder, 'before', '0'))
    await fs.copyFile(audio, path.join(folder, 'before', '1'))
    const entries = [
      {
        relative: path.relative(root, target),
        before: await usbFileHash(target),
        after: await usbFileHash(staged)
      },
      { relative: 'track.mp3', before: await usbFileHash(audio), after: null }
    ]
    await fs.writeFile(
      path.join(folder, 'journal.json'),
      JSON.stringify({ version: 1, status: 'committing', entries })
    )
    await fs.copyFile(staged, target)
    await fs.unlink(audio)
    await recoverUsbWrite(root)
    expect(await fs.readFile(target, 'utf8')).toBe('before')
    expect(await fs.readFile(audio, 'utf8')).toBe('audio')
  })
  it('rejects traversal and does not overwrite a third-party edit during recovery', async () => {
    const { root, target, staged } = await fixture()
    expect(() => resolveUsbFile(root, '/../outside')).toThrow('无效')
    const folder = path.join(root, 'PIONEER', 'rekordbox', '.frkb-write-transaction')
    await fs.mkdir(path.join(folder, 'before'), { recursive: true })
    await fs.copyFile(target, path.join(folder, 'before', '0'))
    await fs.writeFile(
      path.join(folder, 'journal.json'),
      JSON.stringify({
        version: 1,
        status: 'committing',
        entries: [
          {
            relative: path.relative(root, target),
            before: await usbFileHash(target),
            after: await usbFileHash(staged)
          }
        ]
      })
    )
    await fs.writeFile(target, 'third party')
    await expect(recoverUsbWrite(root)).rejects.toThrow('其他程序')
    expect(await fs.readFile(target, 'utf8')).toBe('third party')
  })
})
