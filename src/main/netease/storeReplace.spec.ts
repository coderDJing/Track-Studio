// Run: pnpm exec vitest run src/main/netease/storeReplace.spec.ts
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../recycleBinService', () => ({
  moveFileToRecycleBin: vi.fn(async (filePath: string) => {
    await fs.remove(filePath)
    return { status: 'success' }
  })
}))

const updateRefs = vi.fn()
vi.mock('../setListDb', () => ({
  updateSetItemFilePathReferences: (...args: unknown[]) => updateRefs(...args)
}))

import store from '../store'
import { getNeteaseStoreDir, getStoreFilePath } from './paths'
import { replaceStoreFileAtomically } from './storeReplace'
import { moveFileToRecycleBin } from '../recycleBinService'

describe('replaceStoreFileAtomically', () => {
  const originalDir = store.databaseDir
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-netease-replace-'))
    store.databaseDir = root
    await fs.ensureDir(getNeteaseStoreDir())
    updateRefs.mockReset()
  })

  afterEach(async () => {
    store.databaseDir = originalDir
    await fs.remove(root).catch(() => {})
  })

  it('成功换成另一种扩展名后，旧文件不再留在 .store 里，SET 引用切到新路径', async () => {
    const oldPath = getStoreFilePath('123', 'flac')
    const stagingPath = path.join(getNeteaseStoreDir(), '.staging.mp3')
    await fs.writeFile(oldPath, 'old-flac')
    await fs.writeFile(stagingPath, 'new-mp3')

    const result = await replaceStoreFileAtomically({
      songId: '123',
      ext: 'mp3',
      stagingPath,
      oldPath
    })

    const finalPath = getStoreFilePath('123', 'mp3')
    expect(result.finalPath).toBe(finalPath)
    expect(await fs.pathExists(finalPath)).toBe(true)
    expect(await fs.readFile(finalPath, 'utf8')).toBe('new-mp3')
    expect(await fs.pathExists(oldPath)).toBe(false)
    expect(await fs.pathExists(stagingPath)).toBe(false)
    expect(updateRefs).toHaveBeenCalledWith(oldPath, finalPath)
    expect(moveFileToRecycleBin).toHaveBeenCalled()
  })

  it('同一扩展名替换失败时，旧文件必须还在原来的位置', async () => {
    const oldPath = getStoreFilePath('456', 'flac')
    const stagingPath = path.join(getNeteaseStoreDir(), '.staging.flac')
    await fs.writeFile(oldPath, 'keep-me')
    await fs.writeFile(stagingPath, 'new-flac')

    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (src: string, dest: string) => {
      // 旧文件挪到一边放行；把新文件改到正式名时故意失败；失败后的回迁也放行
      if (path.resolve(String(src)) === path.resolve(stagingPath)) {
        throw new Error('simulated rename failure')
      }
      return await rename(src, dest)
    })

    await expect(
      replaceStoreFileAtomically({
        songId: '456',
        ext: 'flac',
        stagingPath,
        oldPath
      })
    ).rejects.toThrow(/simulated rename failure/)

    spy.mockRestore()
    expect(await fs.pathExists(oldPath)).toBe(true)
    expect(await fs.readFile(oldPath, 'utf8')).toBe('keep-me')
  })

  it('同一扩展名时旧文件已丢失，仍把新文件放到正式路径', async () => {
    const oldPath = getStoreFilePath('789', 'flac')
    const stagingPath = path.join(getNeteaseStoreDir(), '.staging.flac')
    await fs.writeFile(stagingPath, 'new-flac')
    expect(await fs.pathExists(oldPath)).toBe(false)

    const result = await replaceStoreFileAtomically({
      songId: '789',
      ext: 'flac',
      stagingPath,
      oldPath
    })

    expect(result.finalPath).toBe(oldPath)
    expect(result.leftoverOldPath).toBeNull()
    expect(await fs.pathExists(oldPath)).toBe(true)
    expect(await fs.readFile(oldPath, 'utf8')).toBe('new-flac')
    expect(await fs.pathExists(stagingPath)).toBe(false)
  })

  it('扩展名变化但更新 SET 引用失败时，保留旧文件', async () => {
    updateRefs.mockImplementation(() => {
      throw new Error('ref update failed')
    })
    const oldPath = getStoreFilePath('321', 'flac')
    const stagingPath = path.join(getNeteaseStoreDir(), '.staging.mp3')
    await fs.writeFile(oldPath, 'old-flac')
    await fs.writeFile(stagingPath, 'new-mp3')

    const result = await replaceStoreFileAtomically({
      songId: '321',
      ext: 'mp3',
      stagingPath,
      oldPath
    })

    const finalPath = getStoreFilePath('321', 'mp3')
    expect(result.finalPath).toBe(finalPath)
    expect(result.leftoverOldPath).toBe(oldPath)
    expect(await fs.pathExists(finalPath)).toBe(true)
    expect(await fs.readFile(finalPath, 'utf8')).toBe('new-mp3')
    expect(await fs.pathExists(oldPath)).toBe(true)
    expect(await fs.readFile(oldPath, 'utf8')).toBe('old-flac')
    expect(updateRefs).toHaveBeenCalledWith(oldPath, finalPath)
  })
})
