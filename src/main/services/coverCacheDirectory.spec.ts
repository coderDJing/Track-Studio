import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setFileHidden } from './hiddenFileOperation'
import { prepareCoverCacheDirectory } from './coverCacheDirectory'

vi.mock('./hiddenFileOperation', () => ({ setFileHidden: vi.fn().mockResolvedValue(undefined) }))
const roots: string[] = []
afterEach(async () => {
  vi.mocked(setFileHidden).mockReset().mockResolvedValue(undefined)
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const cacheDirectory = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-cover-dir-'))
  roots.push(root)
  return path.join(root, '.frkb_covers')
}

describe('cover cache directory preparation', () => {
  it('shares concurrent preparation, skips repeated attribute changes, and handles recreation', async () => {
    const directory = await cacheDirectory()
    await Promise.all([
      prepareCoverCacheDirectory(directory),
      prepareCoverCacheDirectory(directory)
    ])
    expect(setFileHidden).toHaveBeenCalledTimes(1)
    await prepareCoverCacheDirectory(directory)
    expect(setFileHidden).toHaveBeenCalledTimes(1)
    await fs.rm(directory, { recursive: true })
    await prepareCoverCacheDirectory(directory)
    expect(setFileHidden).toHaveBeenCalledTimes(2)
    expect((await fs.stat(directory)).isDirectory()).toBe(true)
  })

  it('retries failed preparation instead of retaining a failed promise or prepared flag', async () => {
    const directory = await cacheDirectory()
    vi.mocked(setFileHidden).mockRejectedValueOnce(new Error('attribute failed'))
    await expect(prepareCoverCacheDirectory(directory)).rejects.toThrow('attribute failed')
    await expect(prepareCoverCacheDirectory(directory)).resolves.toBeUndefined()
    expect(setFileHidden).toHaveBeenCalledTimes(2)
  })
})
