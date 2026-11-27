import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type {
  IcloudResult,
  IcloudCopyItem,
  IcloudListing,
  IcloudState,
  IcloudFolderListing
} from '../../shared/icloudLibrary'
import { coverWave } from '../../../tests/icloudCoverFixture'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  home: '',
  userData: '',
  databaseDir: '',
  chosen: [] as string[],
  unavailable: new Set<string>(),
  locked: false,
  metadataFailure: false,
  readMetadata: vi.fn(),
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
  finish: vi.fn(),
  open: vi.fn(),
  message: vi.fn(async () => ({ response: 0 }))
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
  assertLibraryMergeMutationAllowed: () => {
    if (mocks.locked) throw new Error('busy')
  }
}))
vi.mock('../services/libraryMerge/operationActivity', () => ({
  beginImportSongsActivity: () => mocks.finish
}))
vi.mock('../services/globalSongSearch', () => ({ markGlobalSongSearchDirty: vi.fn() }))
vi.mock('../services/playlistTrackNumbers', () => ({
  appendSongListTrackNumbers: async () => {
    if (mocks.metadataFailure) throw new Error('metadata')
  }
}))
vi.mock('../services/playlistAddedAt', () => ({ stampPlaylistSongsAddedAt: vi.fn() }))
vi.mock('../services/icloudLibrary/localization', async (original) => ({
  ...(await original<typeof import('../services/icloudLibrary/localization')>()),
  nativeLocalize: mocks.native
}))
vi.mock('../services/icloudLibrary/metadata', async (original) => {
  const actual = await original<typeof import('../services/icloudLibrary/metadata')>()
  return {
    ...actual,
    createIcloudMetadataCache: (
      residency: Parameters<typeof actual.createIcloudMetadataCache>[0]
    ) => actual.createIcloudMetadataCache(residency, mocks.readMetadata)
  }
})
import { registerIcloudLibraryHandlers } from './icloudLibraryHandlers'

let root: string
let cloud: string
let music: string
let local: string
const event = () => ({
  sender: { id: 1, isDestroyed: () => false, send: mocks.send, once: vi.fn() }
})
const invoke = async <T>(name: string, ...args: unknown[]): Promise<IcloudResult<T>> => {
  if (name === 'icloud:prepare-play' && args.length === 1) {
    const state = (await mocks.handlers.get('icloud:state')!(event())) as { value: IcloudState }
    args.push({ requestId: 'test-play', rootToken: state.value.rootToken })
  }
  if (name === 'icloud:copy') {
    const input = args[0] as Record<string, unknown>
    if (input.direction === 'to-cloud' && input.rootToken && input.destinationToken === undefined) {
      const authorized = (await mocks.handlers.get('icloud:authorize-destination')!(
        event(),
        input.cloudDirectory,
        input.rootToken
      )) as IcloudResult<{ token: string }>
      if (!authorized.ok) return authorized
      args[0] = { ...input, destinationToken: authorized.value.token }
    }
    if (input.direction === 'to-local' && input.rootToken === undefined) {
      const state = (await mocks.handlers.get('icloud:state')!(event())) as { value: IcloudState }
      args[0] = { ...input, rootToken: state.value.rootToken }
    }
  }
  return mocks.handlers.get(name)!(event(), ...args) as Promise<IcloudResult<T>>
}
async function configure() {
  mocks.chosen = [music]
  return invoke<IcloudState>('icloud:choose-folder')
}
async function destinationToken(chosen = music) {
  mocks.chosen = [chosen]
  const result = await invoke<{ directory: string; token: string }>('icloud:choose-destination', '')
  if (!result.ok) throw new Error(result.error)
  return result.value.token
}
beforeEach(async () => {
  vi.clearAllMocks()
  mocks.message.mockResolvedValue({ response: 0 })
  mocks.open.mockImplementation(async () => ({
    canceled: !mocks.chosen.length,
    filePaths: mocks.chosen
  }))
  mocks.native.mockReset().mockRejectedValue(new Error('downloadFailed'))
  mocks.handlers.clear()
  mocks.unavailable.clear()
  mocks.chosen = []
  mocks.locked = false
  mocks.metadataFailure = false
  mocks.readMetadata
    .mockReset()
    .mockResolvedValue([{ relativePath: 'resident.wav', metadata: { artist: 'Actual artist' } }])
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-icloud-ipc-')))
  mocks.home = path.join(root, 'home')
  mocks.userData = path.join(root, 'config')
  mocks.databaseDir = path.join(root, 'database')
  cloud = path.join(mocks.home, 'Library/Mobile Documents/com~apple~CloudDocs')
  music = cloud
  local = path.join(mocks.databaseDir, 'library/FilterLibrary/Songs')
  await fs.mkdir(music, { recursive: true })
  await fs.mkdir(local, { recursive: true })
  registerIcloudLibraryHandlers()
})
afterEach(async () => {
  await invoke('icloud:unwatch-directory')
  await fs.rm(root, { recursive: true, force: true })
})

describe('iCloud IPC integration (temporary folders only)', () => {
  it('exposes single resident cover requests with the same root authorization, never materializing cloud files', async () => {
    await fs.writeFile(path.join(cloud, 'resident.wav'), 'resident')
    await fs.writeFile(path.join(cloud, 'cloud.wav'), 'cloud')
    mocks.unavailable.add(path.join(cloud, 'cloud.wav'))
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    const token = state.value.rootToken!
    const picture = { format: 'image/png', data: 'actual-worker-picture' }
    mocks.readMetadata.mockResolvedValue([{ relativePath: 'resident.wav', metadata: { picture } }])
    expect(await invoke('icloud:cover', ['resident.wav'], token, 'cover')).toEqual({
      ok: true,
      value: picture
    })
    const count = mocks.readMetadata.mock.calls.length
    expect(await invoke('icloud:cover', ['cloud.wav'], token, 'cloud-cover')).toEqual({
      ok: true,
      value: null
    })
    expect(mocks.readMetadata).toHaveBeenCalledTimes(count)
    for (const [paths, key] of [
      [['../outside.wav'], token],
      [['resident.wav'], 'old-root'],
      [['a.wav', 'b.wav'], token]
    ] as const)
      expect((await invoke('icloud:cover', paths, key, 'bad-cover')).ok).toBe(false)
    expect(mocks.native).not.toHaveBeenCalled()
    expect(await fs.readdir(cloud)).toEqual(['cloud.wav', 'resident.wav'])
  })
  it('binds metadata to the current root, rejects unsafe input and never reads cloud-only files', async () => {
    await fs.writeFile(path.join(cloud, 'resident.wav'), 'resident')
    await fs.writeFile(path.join(cloud, 'cloud.wav'), 'placeholder')
    mocks.unavailable.add(path.join(cloud, 'cloud.wav'))
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    const token = state.value.rootToken!
    expect(
      await invoke('icloud:metadata', ['resident.wav'], token, 'metadata-local')
    ).toMatchObject({
      ok: true,
      value: [{ relativePath: 'resident.wav', metadata: { artist: 'Actual artist' } }]
    })
    expect(await invoke('icloud:metadata', ['cloud.wav'], token, 'metadata-cloud')).toMatchObject({
      ok: true,
      value: [{ relativePath: 'cloud.wav' }]
    })
    expect(mocks.readMetadata).toHaveBeenCalledTimes(1)
    for (const paths of [
      ['../outside.wav'],
      ['/outside.wav'],
      ['bad\0.wav'],
      [],
      Array(17).fill('resident.wav')
    ])
      expect(await invoke('icloud:metadata', paths, token, 'metadata-unsafe')).toMatchObject({
        ok: false
      })
    expect(
      await invoke('icloud:metadata', ['resident.wav'], 'old-token', 'metadata-stale')
    ).toMatchObject({ ok: false })
    expect(mocks.readMetadata).toHaveBeenCalledTimes(1)
  })
  it('cancels metadata by its owning renderer only', async () => {
    await fs.writeFile(path.join(cloud, 'resident.wav'), 'resident')
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    let ready!: () => void, signal!: AbortSignal
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    mocks.readMetadata.mockImplementationOnce(async (_root, _paths, activeSignal: AbortSignal) => {
      signal = activeSignal
      ready()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      )
    })
    const result = invoke(
      'icloud:metadata',
      ['resident.wav'],
      state.value.rootToken,
      'metadata-owned'
    )
    await started
    await mocks.handlers.get('icloud:cancel')!({ sender: { id: 2 } }, 'metadata-owned')
    expect(signal.aborted).toBe(false)
    await invoke('icloud:cancel', 'metadata-owned')
    expect(signal.aborted).toBe(true)
    expect(await result).toMatchObject({ ok: false, error: 'cancelled' })
  })
  it('discards a metadata worker result when the actual root inode changes', async () => {
    await fs.writeFile(path.join(cloud, 'resident.wav'), 'resident')
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    mocks.readMetadata.mockImplementationOnce(async () => {
      await fs.rename(cloud, `${cloud}-old`)
      await fs.mkdir(cloud)
      return [{ relativePath: 'resident.wav', metadata: { artist: 'stale' } }]
    })
    expect(
      await invoke('icloud:metadata', ['resident.wav'], state.value.rootToken, 'root-race')
    ).toMatchObject({ ok: false })
  })

  it('hides absent iCloud initially, then displays detection and retains offline configuration', async () => {
    if (process.platform !== 'darwin') return
    await fs.rename(cloud, `${cloud}-offline`)
    expect(await invoke('icloud:state')).toMatchObject({
      ok: true,
      value: { visible: false, configured: false }
    })
    await fs.rename(`${cloud}-offline`, cloud)
    expect(await invoke('icloud:state')).toMatchObject({
      ok: true,
      value: { visible: true, configured: false, available: true }
    })
    expect(await configure()).toMatchObject({
      ok: true,
      value: { configured: true, folder: '' }
    })
    // Re-registering simulates restarting: configuration must survive.
    registerIcloudLibraryHandlers()
    await fs.rename(cloud, `${cloud}-offline`)
    expect(await invoke('icloud:state')).toMatchObject({
      ok: true,
      value: { visible: true, configured: true, available: false, folder: '' }
    })
  })
  it('validates folder choice within iCloud before saving', async () => {
    if (process.platform !== 'darwin') return
    mocks.chosen = [local]
    expect(await invoke('icloud:choose-folder')).toEqual({ ok: false, error: 'boundary' })
    await expect(fs.access(path.join(mocks.userData, 'icloud-library.json'))).rejects.toThrow()
    await fs.symlink(local, path.join(cloud, 'Shortcut'))
    mocks.chosen = [path.join(cloud, 'Shortcut')]
    expect(await invoke('icloud:choose-folder')).toEqual({ ok: false, error: 'boundary' })
  })
  it('browses and searches all entries before pagination without content reads', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    for (let i = 0; i < 205; i++)
      await fs.writeFile(path.join(music, `${String(i).padStart(3, '0')}.mp3`), '')
    const page = await invoke<IcloudListing>('icloud:list', '', 0, '')
    expect(page.ok && page.value.entries).toHaveLength(200)
    const searched = await invoke<IcloudListing>('icloud:list', '', 0, '204')
    expect(searched.ok && searched.value.total).toBe(1)
    expect(searched.ok && searched.value.entries[0].name).toBe('204.mp3')
  })
  it('rechecks residency before playing and before copying, never treating placeholders as missing', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    await fs.writeFile(path.join(music, 'cloud.mp3'), 'placeholder')
    mocks.unavailable.add(path.join(music, 'cloud.mp3'))
    expect(await invoke('icloud:prepare-play', 'cloud.mp3')).toEqual({
      ok: false,
      error: 'downloadFailed'
    })
    const result = await invoke<IcloudCopyItem[]>('icloud:copy', {
      direction: 'to-local',
      paths: ['cloud.mp3'],
      localPlaylistUuid: 'list',
      cloudDirectory: ''
    })
    expect(result.ok && result.value[0]).toMatchObject({
      status: 'failed',
      error: 'downloadFailed'
    })
    expect(await fs.readdir(local)).toEqual([])
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    expect(await invoke('icloud:reveal', 'cloud.mp3', state.value.rootToken)).toMatchObject({
      ok: true
    })
    expect(mocks.reveal).toHaveBeenCalledWith(path.join(music, 'cloud.mp3'))
  })
  it('copies both ways, reports progress, rejects outside sources and never deletes source files', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    await fs.writeFile(path.join(local, 'song.mp3'), 'audio')
    const exportResult = await invoke<IcloudCopyItem[]>('icloud:copy', {
      direction: 'to-cloud',
      destinationToken: await destinationToken(),
      paths: [path.join(local, 'song.mp3')],
      localPlaylistUuid: 'list',
      cloudDirectory: ''
    })
    expect(exportResult.ok && exportResult.value[0].status).toBe('copied')
    expect(mocks.send).toHaveBeenCalledWith(
      'icloud:copy-progress',
      expect.objectContaining({ done: 1, total: 1 })
    )
    await fs.writeFile(path.join(music, 'cloud.mp3'), 'other')
    const importResult = await invoke<IcloudCopyItem[]>('icloud:copy', {
      direction: 'to-local',
      paths: ['cloud.mp3'],
      localPlaylistUuid: 'list',
      cloudDirectory: ''
    })
    expect(importResult.ok && importResult.value[0].status).toBe('copied')
    expect(mocks.send).toHaveBeenCalledWith('importFinished', 'list')
    expect(await fs.readFile(path.join(music, 'cloud.mp3'), 'utf8')).toBe('other')
    expect(await fs.readFile(path.join(local, 'song.mp3'), 'utf8')).toBe('audio')
    const bad = await invoke<IcloudCopyItem[]>('icloud:copy', {
      direction: 'to-cloud',
      destinationToken: await destinationToken(),
      paths: [path.join(root, 'outside.mp3')],
      localPlaylistUuid: 'list',
      cloudDirectory: ''
    })
    expect(bad.ok && bad.value[0]).toMatchObject({ status: 'failed', error: 'boundary' })
    expect(mocks.finish).toHaveBeenCalled()
  })
  it('rejects unknown playlist IDs, traversal and symlink targets; respects library merge locking', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    const request = {
      direction: 'to-local',
      paths: ['song.mp3'],
      localPlaylistUuid: 'missing',
      cloudDirectory: ''
    }
    expect(await invoke('icloud:copy', request)).toEqual({ ok: false, error: 'invalid' })
    expect(await invoke('icloud:list', '..', 0)).toEqual({ ok: false, error: 'boundary' })
    expect(await invoke('icloud:prepare-play', '../elsewhere.mp3')).toEqual({
      ok: false,
      error: 'boundary'
    })
    await fs.symlink(local, path.join(music, 'linked'))
    expect(
      await invoke('icloud:copy', {
        ...request,
        localPlaylistUuid: 'list',
        cloudDirectory: 'linked'
      })
    ).toEqual({ ok: false, error: 'boundary' })
    mocks.locked = true
    expect(await invoke('icloud:copy', { ...request, localPlaylistUuid: 'list' })).toEqual({
      ok: false,
      error: 'busy'
    })
  })
  it('keeps successful copies but explicitly warns when FRKB metadata updates fail', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    mocks.metadataFailure = true
    await fs.writeFile(path.join(music, 'song.mp3'), 'audio')
    const result = await invoke<IcloudCopyItem[]>('icloud:copy', {
      direction: 'to-local',
      paths: ['song.mp3'],
      localPlaylistUuid: 'list',
      cloudDirectory: ''
    })
    expect(result.ok && result.value[0]).toMatchObject({ status: 'copied', warning: 'metadata' })
    expect(await fs.readFile(path.join(local, 'song.mp3'), 'utf8')).toBe('audio')
  })
  it('opens Drive itself without a music-root preference, then remembers availability offline', async () => {
    if (process.platform !== 'darwin') return
    await fs.writeFile(path.join(cloud, 'root-song.mp3'), 'audio')
    expect(await invoke('icloud:state')).toMatchObject({
      ok: true,
      value: { available: true, folder: '', configured: false }
    })
    const listing = await invoke<IcloudListing>('icloud:list', '', 0)
    expect(listing.ok && listing.value.entries.map((entry) => entry.name)).toContain(
      'root-song.mp3'
    )
    await expect(fs.access(path.join(cloud, 'FRKB Music'))).rejects.toThrow()
    expect(mocks.chosen).toEqual([])
    await fs.rename(cloud, `${cloud}-offline`)
    expect(await invoke('icloud:state')).toMatchObject({
      ok: true,
      value: { visible: true, configured: true, available: false, folder: '' }
    })
  })
  it('migrates old music settings without restricting the tree or moving/deleting existing files', async () => {
    if (process.platform !== 'darwin') return
    for (const folder of ['FRKB Music', 'Custom Music', 'Empty', 'Documents'])
      await fs.mkdir(path.join(cloud, folder))
    await fs.writeFile(path.join(cloud, 'Custom Music/song.mp3'), 'old audio')
    await fs.writeFile(path.join(cloud, 'Documents/note.txt'), 'old note')
    await fs.mkdir(mocks.userData, { recursive: true })
    await fs.writeFile(
      path.join(mocks.userData, 'icloud-library.json'),
      JSON.stringify({ version: 2, relativeFolder: 'Custom Music', mode: 'custom' })
    )
    registerIcloudLibraryHandlers()
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    expect(state.value).toMatchObject({
      folder: '',
      preferredDirectory: 'Custom Music',
      available: true
    })
    const tree = await invoke<IcloudFolderListing>('icloud:folders', '', state.value.rootToken)
    expect(tree.ok && tree.value.entries.map((entry) => entry.name).sort()).toEqual(
      ['FRKB Music', 'Custom Music', 'Empty', 'Documents'].sort()
    )
    const migrated = JSON.parse(
      await fs.readFile(path.join(mocks.userData, 'icloud-library.json'), 'utf8')
    )
    expect(migrated).toMatchObject({
      version: 3,
      relativeFolder: '',
      mode: 'drive',
      legacyFolder: 'Custom Music'
    })
    expect(await fs.readFile(path.join(cloud, 'Custom Music/song.mp3'), 'utf8')).toBe('old audio')
    expect(await fs.readFile(path.join(cloud, 'Documents/note.txt'), 'utf8')).toBe('old note')
  })
  it('never writes to an implicit root; explicit destinations are one-use and canceling the picker leaves files untouched', async () => {
    if (process.platform !== 'darwin') return
    await fs.writeFile(path.join(local, 'song.mp3'), 'audio')
    await fs.mkdir(path.join(cloud, 'Chosen'))
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    const request = {
      direction: 'to-cloud',
      paths: [path.join(local, 'song.mp3')],
      localPlaylistUuid: 'list',
      cloudDirectory: ''
    }
    expect(await invoke('icloud:copy', request)).toEqual({ ok: false, error: 'destination' })
    expect(mocks.message).not.toHaveBeenCalled()
    const authorize = async () => {
      const result = await invoke<{ token: string }>(
        'icloud:authorize-destination',
        'Chosen',
        state.value.rootToken
      )
      if (!result.ok) throw new Error(result.error)
      return result.value.token
    }
    mocks.chosen = []
    expect(await invoke('icloud:choose-destination', '')).toEqual({ ok: true, value: null })
    await expect(fs.access(path.join(cloud, 'Chosen/song.mp3'))).rejects.toThrow()
    const token = await authorize()
    expect(
      await invoke('icloud:copy', { ...request, cloudDirectory: 'Chosen', destinationToken: token })
    ).toMatchObject({ ok: true, value: [{ status: 'copied' }] })
    expect(
      await invoke('icloud:copy', { ...request, cloudDirectory: 'Chosen', destinationToken: token })
    ).toEqual({ ok: false, error: 'destination' })
    expect(
      await invoke('icloud:copy', {
        ...request,
        cloudDirectory: 'Chosen',
        destinationToken: await authorize()
      })
    ).toMatchObject({ ok: true, value: [{ status: 'skipped' }] })
    expect(mocks.message).not.toHaveBeenCalled()
    await expect(fs.access(path.join(cloud, 'song.mp3'))).rejects.toThrow()
    await expect(fs.access(path.join(cloud, 'FRKB Music'))).rejects.toThrow()
    expect(await fs.readFile(path.join(local, 'song.mp3'), 'utf8')).toBe('audio')
  })
  it('validates destination boundaries and invalidates authorization when the browsing root changes', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    mocks.chosen = [local]
    expect(await invoke('icloud:choose-destination', '')).toEqual({ ok: false, error: 'boundary' })
    await configure()
    const token = await destinationToken()
    await invoke('icloud:use-default-folder')
    expect(
      await invoke('icloud:copy', {
        direction: 'to-cloud',
        destinationToken: token,
        paths: [path.join(local, 'song.mp3')],
        localPlaylistUuid: 'list',
        cloudDirectory: ''
      })
    ).toEqual({ ok: false, error: 'destination' })
  })
  it('rejects missing or stale root authorization before a native request', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    await invoke('icloud:use-default-folder')
    expect(
      await invoke('icloud:prepare-play', 'song.mp3', {
        requestId: 'stale',
        rootToken: state.value.rootToken
      })
    ).toEqual({ ok: false, error: 'boundary' })
    expect(
      await mocks.handlers.get('icloud:copy')!(event(), {
        direction: 'to-local',
        paths: ['song.mp3'],
        localPlaylistUuid: 'list',
        cloudDirectory: ''
      })
    ).toEqual({ ok: false, error: 'boundary' })
    expect(mocks.native).not.toHaveBeenCalled()
  })
  it('cancels only a requesting renderer’s own download and rejects late continuation', async () => {
    if (process.platform !== 'darwin') return
    await configure()
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
    const pending = invoke('icloud:prepare-play', 'cloud.mp3', {
      requestId: 'owned',
      rootToken: state.value.rootToken
    })
    const signal = await startedPromise
    await mocks.handlers.get('icloud:cancel')!({ sender: { ...event().sender, id: 2 } }, 'owned')
    expect(signal.aborted).toBe(false)
    await invoke('icloud:cancel', 'owned')
    expect(signal.aborted).toBe(true)
    expect(await pending).toEqual({ ok: false, error: 'cancelled' })
    finish()
    expect(mocks.send).not.toHaveBeenCalledWith(
      'icloud:download-progress',
      expect.objectContaining({ state: 'ready' })
    )
  })
  it('localizes just the selected cloud song before copying to the validated local target', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    await fs.writeFile(path.join(music, 'cloud.mp3'), 'fixture')
    mocks.unavailable.add(path.join(music, 'cloud.mp3'))
    mocks.native.mockImplementation(async (root, relative, _signal, status) => {
      status('downloading')
      mocks.unavailable.delete(path.join(root, relative))
    })
    expect(
      await invoke('icloud:copy', {
        direction: 'to-local',
        paths: ['cloud.mp3'],
        localPlaylistUuid: 'list',
        cloudDirectory: '',
        requestId: 'copy-selected'
      })
    ).toMatchObject({ ok: true, value: [{ status: 'copied' }] })
    expect(mocks.native).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(path.join(local, 'cloud.mp3'), 'utf8')).toBe('fixture')
    expect(await fs.readFile(path.join(music, 'cloud.mp3'), 'utf8')).toBe('fixture')
    expect(mocks.send).toHaveBeenCalledWith(
      'icloud:download-progress',
      expect.objectContaining({
        relative: 'cloud.mp3',
        state: 'downloading',
        requestId: 'copy-selected'
      })
    )
  })
  it('lists every real directory including empty, document-only and hidden directories, with only one safe child-directory lookahead', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    for (const name of ['Empty', 'Documents', 'Album/Nested', '.Hidden', 'Remote'])
      await fs.mkdir(path.join(music, name), { recursive: true })
    await fs.writeFile(path.join(music, 'Documents/notes.txt'), 'not music')
    await fs.writeFile(path.join(music, 'Album/Nested/song.mp3'), 'nested')
    await fs.writeFile(path.join(music, 'root.mp3'), 'root')
    await fs.symlink(local, path.join(music, 'Escape'))
    mocks.unavailable.add(path.join(music, 'Remote'))
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    const open = vi.spyOn(fs, 'opendir')
    const result = await invoke<IcloudFolderListing>('icloud:folders', '', state.value.rootToken)
    expect(result.ok && result.value.entries.map((entry) => entry.name).sort()).toEqual(
      ['.Hidden', 'Album', 'Documents', 'Empty', 'Remote'].sort()
    )
    expect(
      result.ok && result.value.entries.find((entry) => entry.name === 'Remote')?.residency
    ).toBe('cloud')
    expect(open.mock.calls.map(([file]) => file).sort()).toEqual(
      [
        music,
        ...['.Hidden', 'Album', 'Documents', 'Empty'].map((name) => path.join(music, name))
      ].sort()
    )
    expect(
      result.ok &&
        Object.fromEntries(result.value.entries.map((entry) => [entry.name, entry.hasChildren]))
    ).toEqual({ '.Hidden': false, Album: true, Documents: false, Empty: false, Remote: 'unknown' })
    const rootSongs = await invoke<IcloudListing>('icloud:list', '', 0, '', state.value.rootToken)
    expect(rootSongs.ok && rootSongs.value.entries.map((entry) => entry.name)).toEqual(['root.mp3'])
    const album = await invoke<IcloudFolderListing>(
      'icloud:folders',
      'Album',
      state.value.rootToken
    )
    expect(album.ok && album.value.entries.map((entry) => entry.relativePath)).toEqual([
      'Album/Nested'
    ])
    const nested = await invoke<IcloudListing>(
      'icloud:list',
      'Album/Nested',
      0,
      '',
      state.value.rootToken
    )
    expect(nested.ok && nested.value.entries.map((entry) => entry.relativePath)).toEqual([
      'Album/Nested/song.mp3'
    ])
    expect(await invoke('icloud:folders', 'Remote', state.value.rootToken)).toEqual({
      ok: false,
      error: 'download'
    })
    expect(await invoke('icloud:list', 'Remote', 0, '', state.value.rootToken)).toEqual({
      ok: false,
      error: 'download'
    })
    expect(mocks.native).not.toHaveBeenCalled()
    open.mockRestore()
  })
  it('reports a missing Drive unavailable and never recreates it', async () => {
    if (process.platform !== 'darwin') return
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    await fs.rename(cloud, `${cloud}-offline`)
    expect(await invoke('icloud:folders', '', state.value.rootToken)).toEqual({
      ok: false,
      error: 'unavailable'
    })
    await expect(fs.access(cloud)).rejects.toThrow()
    expect(mocks.native).not.toHaveBeenCalled()
  })
  it('rejects stale directory identity, traversal and symlinks for both tree and list reads', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    await fs.symlink(local, path.join(music, 'Escape'))
    for (const relative of ['../', local, 'Escape']) {
      expect(await invoke('icloud:folders', relative, state.value.rootToken)).toEqual({
        ok: false,
        error: 'boundary'
      })
      expect(await invoke('icloud:list', relative, 0, '', state.value.rootToken)).toEqual({
        ok: false,
        error: 'boundary'
      })
    }
    await invoke('icloud:use-default-folder')
    expect(await invoke('icloud:folders', '', state.value.rootToken)).toEqual({
      ok: false,
      error: 'boundary'
    })
    expect(await invoke('icloud:list', '', 0, '', state.value.rootToken)).toEqual({
      ok: false,
      error: 'boundary'
    })
  })
  it('copies into the explicitly dropped cloud directory and imports root-relative nested songs without moving sources', async () => {
    if (process.platform !== 'darwin') return
    await configure()
    await fs.mkdir(path.join(music, 'Album'))
    await fs.writeFile(path.join(local, 'song.mp3'), 'local fixture')
    await fs.writeFile(path.join(music, 'Album/cloud.mp3'), 'cloud fixture')
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    const exportRequest = {
      direction: 'to-cloud',
      paths: [path.join(local, 'song.mp3')],
      localPlaylistUuid: 'list',
      cloudDirectory: 'Album',
      rootToken: state.value.rootToken
    }
    expect(await invoke('icloud:copy', exportRequest)).toMatchObject({
      ok: true,
      value: [{ status: 'copied' }]
    })
    expect(await fs.readFile(path.join(music, 'Album/song.mp3'), 'utf8')).toBe('local fixture')
    await expect(fs.access(path.join(music, 'song.mp3'))).rejects.toThrow()
    expect(
      await invoke('icloud:copy', {
        direction: 'to-local',
        paths: ['Album/cloud.mp3'],
        localPlaylistUuid: 'list',
        cloudDirectory: '',
        rootToken: state.value.rootToken
      })
    ).toMatchObject({ ok: true, value: [{ status: 'copied' }] })
    expect(await fs.readFile(path.join(local, 'cloud.mp3'), 'utf8')).toBe('cloud fixture')
    expect(await fs.readFile(path.join(music, 'Album/cloud.mp3'), 'utf8')).toBe('cloud fixture')
    expect(await fs.readFile(path.join(local, 'song.mp3'), 'utf8')).toBe('local fixture')
    expect(await invoke('icloud:copy', { ...exportRequest, cloudDirectory: '../outside' })).toEqual(
      { ok: false, error: 'boundary' }
    )
    expect(
      await invoke('icloud:copy', {
        ...exportRequest,
        direction: 'to-local',
        rootToken: 'stale',
        destinationToken: 'cannot-bypass'
      })
    ).toEqual({ ok: false, error: 'boundary' })
  })
  it('never enumerates the whole Mobile Documents directory or exposes sibling application containers and aliases', async () => {
    if (process.platform !== 'darwin') return
    const privateDocuments = path.join(path.dirname(cloud), 'com~vendor~Private/Documents')
    await fs.mkdir(privateDocuments, { recursive: true })
    await fs.writeFile(path.join(privateDocuments, 'private.txt'), 'untouched fixture')
    await fs.mkdir(path.join(cloud, 'Empty'))
    await fs.symlink(privateDocuments, path.join(cloud, 'Outside Alias'))
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    const read = vi.spyOn(fs, 'opendir')
    const tree = await invoke<IcloudFolderListing>('icloud:folders', '', state.value.rootToken)
    expect(tree.ok && tree.value.entries.map((entry) => entry.name)).toEqual(['Empty'])
    expect(read.mock.calls.map(([file]) => file)).toEqual([cloud, path.join(cloud, 'Empty')])
    expect(await invoke('icloud:folders', 'Outside Alias', state.value.rootToken)).toEqual({
      ok: false,
      error: 'boundary'
    })
    expect(
      await invoke('icloud:authorize-destination', privateDocuments, state.value.rootToken)
    ).toEqual({ ok: false, error: 'boundary' })
    mocks.chosen = [privateDocuments]
    expect(await invoke('icloud:choose-destination', '')).toEqual({ ok: false, error: 'boundary' })
    read.mockRestore()
  })
  it('binds explicit destination tickets to their renderer and invalidates old root identity after replacement', async () => {
    if (process.platform !== 'darwin') return
    await fs.writeFile(path.join(local, 'song.mp3'), 'audio')
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    const authorized = await invoke<{ token: string }>(
      'icloud:authorize-destination',
      '',
      state.value.rootToken
    )
    if (!authorized.ok) throw new Error(authorized.error)
    const request = {
      direction: 'to-cloud',
      localPlaylistUuid: 'list',
      paths: [path.join(local, 'song.mp3')],
      cloudDirectory: '',
      destinationToken: authorized.value.token
    }
    expect(
      await mocks.handlers.get('icloud:copy')!({ sender: { ...event().sender, id: 2 } }, request)
    ).toEqual({ ok: false, error: 'destination' })
    await fs.rename(cloud, `${cloud}-old`)
    await fs.mkdir(cloud)
    expect(await invoke('icloud:folders', '', state.value.rootToken)).toEqual({
      ok: false,
      error: 'boundary'
    })
    const changed = await invoke<IcloudState>('icloud:state')
    expect(changed.ok && changed.value.rootToken).not.toBe(state.value.rootToken)
    expect(await invoke('icloud:copy', request)).toEqual({ ok: false, error: 'destination' })
    expect(await fs.readdir(cloud)).toEqual([])
    expect(await fs.readFile(path.join(local, 'song.mp3'), 'utf8')).toBe('audio')
  })
  it('rejects a destination picker response from a replaced Drive without opening a copy confirmation', async () => {
    if (process.platform !== 'darwin') return
    await fs.writeFile(path.join(local, 'song.mp3'), 'source retained')
    mocks.open.mockImplementationOnce(async () => {
      await fs.rename(cloud, `${cloud}-old`)
      await fs.mkdir(cloud)
      return { canceled: false, filePaths: [cloud] }
    })
    expect(await invoke('icloud:choose-destination', '')).toEqual({ ok: false, error: 'boundary' })
    expect(mocks.message).not.toHaveBeenCalled()
    expect(await fs.readdir(cloud)).toEqual([])
    expect(await fs.readFile(path.join(local, 'song.mp3'), 'utf8')).toBe('source retained')
    await expect(fs.access(path.join(mocks.userData, 'icloud-library.json'))).rejects.toThrow()
  })
  it('does not import a same-name song from a replacement Drive after async download', async () => {
    if (process.platform !== 'darwin') return
    const song = path.join(cloud, 'song.mp3')
    await fs.writeFile(song, 'old cloud fixture')
    mocks.unavailable.add(song)
    mocks.native.mockImplementationOnce(async () => {
      await fs.rename(cloud, `${cloud}-old`)
      await fs.mkdir(cloud)
      await fs.writeFile(song, 'different account fixture')
      mocks.unavailable.delete(song)
    })
    const result = await invoke<IcloudCopyItem[]>('icloud:copy', {
      direction: 'to-local',
      localPlaylistUuid: 'list',
      paths: ['song.mp3'],
      cloudDirectory: ''
    })
    expect(result.ok && result.value).toEqual([
      { source: 'song.mp3', status: 'failed', error: 'boundary' }
    ])
    expect(await fs.readdir(local)).toEqual([])
    expect(await fs.readFile(path.join(`${cloud}-old`, 'song.mp3'), 'utf8')).toBe(
      'old cloud fixture'
    )
  })
  it('binds Finder reveal to the requested node and current root, including leaves and cloud-only folders', async () => {
    if (process.platform !== 'darwin') return
    await fs.mkdir(path.join(cloud, 'Leaf'))
    await fs.mkdir(path.join(cloud, 'Remote'))
    await fs.symlink(local, path.join(cloud, 'Escape'))
    mocks.unavailable.add(path.join(cloud, 'Remote'))
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    for (const relative of ['', 'Leaf', 'Remote']) {
      expect(await invoke('icloud:reveal', relative, state.value.rootToken)).toEqual({
        ok: true,
        value: undefined
      })
      expect(mocks.reveal).toHaveBeenLastCalledWith(path.join(cloud, relative))
    }
    mocks.reveal.mockClear()
    for (const [relative, token] of [
      ['Leaf', 'old-token'],
      ['Escape', state.value.rootToken],
      ['../outside', state.value.rootToken],
      ['Leaf', undefined]
    ]) {
      expect(await invoke('icloud:reveal', relative, token)).toEqual({
        ok: false,
        error: 'boundary'
      })
    }
    expect(mocks.reveal).not.toHaveBeenCalled()
    expect(mocks.native).not.toHaveBeenCalled()
  })
  it('rejects a root replacement during child-presence inspection before publishing folder hints', async () => {
    if (process.platform !== 'darwin') return
    await fs.mkdir(path.join(cloud, 'Empty'))
    const state = await invoke<IcloudState>('icloud:state')
    if (!state.ok) throw new Error(state.error)
    const original = fs.opendir
    const open = vi
      .spyOn(fs, 'opendir')
      .mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
        const directory = await original(...args)
        if (args[0] === path.join(cloud, 'Empty')) {
          await fs.rename(cloud, `${cloud}-old`)
          await fs.mkdir(path.join(cloud, 'Empty'), { recursive: true })
        }
        return directory
      })
    expect(await invoke('icloud:folders', '', state.value.rootToken)).toEqual({
      ok: false,
      error: 'boundary'
    })
    open.mockRestore()
    expect(mocks.native).not.toHaveBeenCalled()
  })
  it('keeps every new channel explicitly allowed in preload', async () => {
    const preload = await fs.readFile(path.join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    for (const name of mocks.handlers.keys()) expect(preload).toContain(`'${name}'`)
    expect(preload).toContain("'icloud:copy-progress'")
    expect(preload).toContain("'icloud:download-progress'")
  })
})

it('returns the entire current directory on the continuous-list protocol without descending or reading metadata', async () => {
  if (process.platform !== 'darwin') return
  await configure()
  for (let i = 0; i < 251; i++) await fs.writeFile(path.join(cloud, `${i}.mp3`), '')
  await fs.mkdir(path.join(cloud, 'Child'))
  await fs.writeFile(path.join(cloud, 'Child', 'hidden.mp3'), '')
  const state = await invoke<IcloudState>('icloud:state')
  if (!state.ok) throw new Error(state.error)
  const data = await invoke<IcloudListing>('icloud:list', '', null, '', state.value.rootToken)
  expect(data.ok && data.value.entries).toHaveLength(251)
  expect(mocks.readMetadata).not.toHaveBeenCalled()
  expect(mocks.native).not.toHaveBeenCalled()
})
it('watches only the resident selected directory; rejects stale roots, traversal, symlinks and placeholders without downloading', async () => {
  if (process.platform !== 'darwin') return
  await configure()
  const state = await invoke<IcloudState>('icloud:state')
  if (!state.ok) throw new Error(state.error)
  const token = state.value.rootToken
  expect(await invoke('icloud:watch-directory', '../elsewhere', token)).toMatchObject({
    ok: false,
    error: 'boundary'
  })
  await fs.symlink(local, path.join(cloud, 'linked'))
  expect(await invoke('icloud:watch-directory', 'linked', token)).toMatchObject({
    ok: false,
    error: 'boundary'
  })
  await fs.mkdir(path.join(cloud, 'Remote'))
  mocks.unavailable.add(path.join(cloud, 'Remote'))
  expect(await invoke('icloud:watch-directory', 'Remote', token)).toMatchObject({
    ok: false,
    error: 'download'
  })
  expect(await invoke('icloud:watch-directory', '', 'old-root')).toMatchObject({
    ok: false,
    error: 'boundary'
  })
  expect(await invoke('icloud:watch-directory', '', token)).toMatchObject({ ok: true, value: true })
  await fs.writeFile(path.join(cloud, 'new.mp3'), '')
  await vi.waitFor(
    () =>
      expect(mocks.send).toHaveBeenCalledWith('icloud:directory-changed', {
        rootToken: token,
        directory: ''
      }),
    { timeout: 2500 }
  )
  expect(mocks.native).not.toHaveBeenCalled()
  expect(mocks.readMetadata).not.toHaveBeenCalled()
  await invoke('icloud:unwatch-directory')
})

it('returns a resident list preview over icloud:waveform-preview, skips non-resident files, and caches only in userData', async () => {
  const wav = coverWave()
  wav.writeInt16LE(24000, 44)
  await fs.writeFile(path.join(cloud, 'resident.wav'), wav)
  await fs.writeFile(path.join(cloud, 'cloud.wav'), wav)
  mocks.unavailable.add(path.join(cloud, 'cloud.wav'))
  const state = await invoke<IcloudState>('icloud:state')
  if (!state.ok) throw new Error(state.error)
  const token = state.value.rootToken!
  const before = await fs.readdir(cloud)
  const opened: string[] = []
  const realOpen = fs.open.bind(fs)
  const spy = vi.spyOn(fs, 'open').mockImplementation((file, ...args) => {
    opened.push(String(file))
    return realOpen(file, ...args)
  })
  const ready = await invoke('icloud:waveform-preview', ['resident.wav'], token, 'wave-resident')
  expect(ready).toMatchObject({ ok: true })
  const value = (ready as { value: { surfaceKind?: string; detailPeakTop?: Uint8Array } | null })
    .value
  expect(value?.surfaceKind).toBe('listPreview')
  expect(Array.from(value?.detailPeakTop || [])).toHaveLength(512)
  expect(Math.max(...Array.from(value?.detailPeakTop || []))).toBeGreaterThan(0)
  expect(await invoke('icloud:waveform-preview', ['cloud.wav'], token, 'wave-cloud')).toEqual({
    ok: true,
    value: null
  })
  expect(opened).not.toContain(path.join(cloud, 'cloud.wav'))
  expect((await invoke('icloud:waveform-preview', ['../outside.wav'], token, 'wave-bad')).ok).toBe(
    false
  )
  expect(
    (await invoke('icloud:waveform-preview', ['resident.wav'], 'old-root', 'wave-old')).ok
  ).toBe(false)
  expect((await invoke('icloud:waveform-preview', ['a.wav', 'b.wav'], token, 'wave-many')).ok).toBe(
    false
  )
  expect(await fs.readdir(cloud)).toEqual(before)
  expect(
    (await fs.readdir(path.join(mocks.userData, 'icloud-waveform-preview'))).some((name) =>
      name.endsWith('.json')
    )
  ).toBe(true)
  spy.mockRestore()
})
