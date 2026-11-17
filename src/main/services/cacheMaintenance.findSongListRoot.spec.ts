// Run: pnpm exec vitest run src/main/services/cacheMaintenance.findSongListRoot.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import store from '../store'
import { findSongListRoot } from './cacheMaintenance'

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  session: {},
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
  BrowserWindow: class BrowserWindow {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('./keyAnalysisQueue', () => ({
  cancelKeyAnalysisForPaths: vi.fn()
}))
vi.mock('../libraryTreeDb', () => ({
  loadLibraryNodes: () => [],
  findSongListRootByPath: vi.fn(async () => null)
}))

const previousDatabaseDir = store.databaseDir
let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-netease-list-root-'))
  store.databaseDir = root
})

afterEach(async () => {
  store.databaseDir = previousDatabaseDir
  await fs.rm(root, { recursive: true, force: true })
})

describe('findSongListRoot for NeteaseLibrary', () => {
  it('returns the NeteaseLibrary root for files under .store even without a songList node', async () => {
    const neteaseRoot = path.join(root, 'library', 'NeteaseLibrary')
    const storeDir = path.join(neteaseRoot, '.store')
    const filePath = path.join(storeDir, '2079830421.flac')
    await fs.mkdir(storeDir, { recursive: true })
    await fs.writeFile(filePath, Buffer.from('flac'))

    await expect(findSongListRoot(storeDir)).resolves.toBe(neteaseRoot)
    await expect(findSongListRoot(neteaseRoot)).resolves.toBe(neteaseRoot)
  })

  it('does not invent a cache root for an unrelated directory', async () => {
    const otherDir = path.join(root, 'somewhere-else')
    await fs.mkdir(otherDir, { recursive: true })
    await expect(findSongListRoot(otherDir)).resolves.toBeNull()
  })
})
