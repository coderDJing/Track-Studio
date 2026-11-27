import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { IcloudResult, IcloudState } from '../../shared/icloudLibrary'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  home: '',
  userData: '',
  databaseDir: '',
  chosen: [] as string[],
  unavailable: new Set<string>(),
  native:
    vi.fn<
      (
        root: string,
        relative: string,
        signal: AbortSignal,
        status: (state: 'waiting' | 'downloading' | 'ready') => void
      ) => Promise<void>
    >(),
  send: vi.fn(),
  reveal: vi.fn(),
  open: vi.fn(),
  message: vi.fn(async () => ({ response: 0 })),
  issue: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? mocks.home : mocks.userData) },
  dialog: {
    showMessageBox: mocks.message,
    showOpenDialog: mocks.open
  },
  shell: { showItemInFolder: mocks.reveal },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('../services/icloudLibrary/files', async (original) => ({
  ...(await original<typeof import('../services/icloudLibrary/files')>()),
  readMacResidency: async (file: string) => (mocks.unavailable.has(file) ? 'cloud' : 'local')
}))
vi.mock('../store', () => ({
  default: {
    get databaseDir() {
      return mocks.databaseDir
    }
  }
}))
vi.mock('../coreLibraries', () => ({ getCoreFsDirName: (name: string) => name }))
vi.mock('../libraryTreeDb', () => ({
  loadLibraryNodes: () => [
    { uuid: 'root', parentUuid: null, dirName: 'library', nodeType: 'root' },
    { uuid: 'lib', parentUuid: 'root', dirName: 'FilterLibrary', nodeType: 'library' },
    { uuid: 'list', parentUuid: 'lib', dirName: 'Songs', nodeType: 'songList' }
  ]
}))
vi.mock('../services/libraryMerge/runtime', () => ({
  assertLibraryMergeMutationAllowed: () => undefined
}))
vi.mock('../services/libraryMerge/operationActivity', () => ({
  beginImportSongsActivity: () => vi.fn()
}))
vi.mock('../services/globalSongSearch', () => ({ markGlobalSongSearchDirty: vi.fn() }))
vi.mock('../services/playlistTrackNumbers', () => ({ appendSongListTrackNumbers: vi.fn() }))
vi.mock('../services/playlistAddedAt', () => ({ stampPlaylistSongsAddedAt: vi.fn() }))
vi.mock('../services/icloudLibrary/localization', async (original) => ({
  ...(await original<typeof import('../services/icloudLibrary/localization')>()),
  nativeLocalize: mocks.native
}))
vi.mock('../services/icloudLibrary/playback', () => ({
  icloudPlayback: { issue: mocks.issue }
}))

import { registerIcloudLibraryHandlers } from './icloudLibraryHandlers'

let root: string
let music: string
const event = () => ({
  sender: { id: 1, isDestroyed: () => false, send: mocks.send, once: vi.fn() }
})
const invoke = async <T>(name: string, ...args: unknown[]): Promise<IcloudResult<T>> =>
  mocks.handlers.get(name)!(event(), ...args) as Promise<IcloudResult<T>>

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.open.mockImplementation(async () => ({
    canceled: !mocks.chosen.length,
    filePaths: mocks.chosen
  }))
  mocks.native.mockReset().mockRejectedValue(new Error('downloadFailed'))
  mocks.issue.mockReset().mockResolvedValue('frkb-preview://icloud/?ticket=should-not-issue')
  mocks.handlers.clear()
  mocks.unavailable.clear()
  mocks.chosen = []
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-icloud-local-')))
  mocks.home = path.join(root, 'home')
  mocks.userData = path.join(root, 'config')
  mocks.databaseDir = path.join(root, 'database')
  music = path.join(mocks.home, 'Library/Mobile Documents/com~apple~CloudDocs')
  await fs.mkdir(music, { recursive: true })
  await fs.mkdir(path.join(mocks.databaseDir, 'library/FilterLibrary/Songs'), { recursive: true })
  registerIcloudLibraryHandlers()
})

afterEach(async () => {
  await invoke('icloud:unwatch-directory')
  await fs.rm(root, { recursive: true, force: true })
})

describe('icloud:prepare-local (temporary folders only)', () => {
  it('returns a resident file path without downloading or issuing a playback ticket', async () => {
    if (process.platform !== 'darwin') return
    mocks.chosen = [music]
    await invoke<IcloudState>('icloud:choose-folder')
    await fs.writeFile(path.join(music, 'resident.mp3'), 'original')
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    expect(
      await invoke('icloud:prepare-local', 'resident.mp3', {
        requestId: 'local-1',
        rootToken: state.value.rootToken
      })
    ).toEqual({
      ok: true,
      value: { relative: 'resident.mp3', filePath: path.join(music, 'resident.mp3') }
    })
    expect(mocks.native).not.toHaveBeenCalled()
    expect(mocks.issue).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(music, 'resident.mp3'), 'utf8')).toBe('original')
  })

  it('localizes only the requested evicted file and leaves the original contents in place', async () => {
    if (process.platform !== 'darwin') return
    mocks.chosen = [music]
    await invoke<IcloudState>('icloud:choose-folder')
    await fs.writeFile(path.join(music, 'cloud.mp3'), 'fixture')
    await fs.writeFile(path.join(music, 'other.mp3'), 'other')
    mocks.unavailable.add(path.join(music, 'cloud.mp3'))
    mocks.unavailable.add(path.join(music, 'other.mp3'))
    mocks.native.mockImplementation(async (rootDir, relative, _signal, status) => {
      status('downloading')
      mocks.unavailable.delete(path.join(rootDir, relative))
    })
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    expect(
      await invoke('icloud:prepare-local', 'cloud.mp3', {
        requestId: 'local-2',
        rootToken: state.value.rootToken
      })
    ).toEqual({
      ok: true,
      value: { relative: 'cloud.mp3', filePath: path.join(music, 'cloud.mp3') }
    })
    expect(mocks.native).toHaveBeenCalledTimes(1)
    expect(mocks.native.mock.calls[0][1]).toBe('cloud.mp3')
    expect(mocks.issue).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(music, 'cloud.mp3'), 'utf8')).toBe('fixture')
    expect(mocks.unavailable.has(path.join(music, 'other.mp3'))).toBe(true)
    expect(mocks.send).toHaveBeenCalledWith(
      'icloud:download-progress',
      expect.objectContaining({
        relative: 'cloud.mp3',
        state: 'downloading',
        requestId: 'local-2'
      })
    )
  })

  it('cancels an in-flight localize and rejects a stale root token', async () => {
    if (process.platform !== 'darwin') return
    mocks.chosen = [music]
    await invoke<IcloudState>('icloud:choose-folder')
    await fs.writeFile(path.join(music, 'cloud.mp3'), 'fixture')
    mocks.unavailable.add(path.join(music, 'cloud.mp3'))
    let started!: (signal: AbortSignal) => void
    let finish!: () => void
    const startedPromise = new Promise<AbortSignal>((resolve) => {
      started = resolve
    })
    mocks.native.mockImplementation(async (_root, _relative, signal) => {
      started(signal)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      mocks.unavailable.clear()
    })
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    const pending = invoke('icloud:prepare-local', 'cloud.mp3', {
      requestId: 'owned',
      rootToken: state.value.rootToken
    })
    const signal = await startedPromise
    await invoke('icloud:cancel', 'owned')
    expect(signal.aborted).toBe(true)
    expect(await pending).toEqual({ ok: false, error: 'cancelled' })
    finish()
    await invoke('icloud:use-default-folder')
    expect(
      await invoke('icloud:prepare-local', 'cloud.mp3', {
        requestId: 'stale',
        rootToken: state.value.rootToken
      })
    ).toEqual({ ok: false, error: 'boundary' })
    expect(mocks.issue).not.toHaveBeenCalled()
  })
})
