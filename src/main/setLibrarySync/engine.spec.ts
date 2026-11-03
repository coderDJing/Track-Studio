import { beforeEach, expect, it, vi } from 'vitest'
import { emptySetSnapshot, SET_SYNC_ROOT } from '../../shared/setLibrarySync'

const mocks = vi.hoisted(() => ({
  enabled: true,
  guard: 'same',
  scan: vi.fn(),
  request: vi.fn(),
  apply: vi.fn(),
  base: vi.fn(),
  upload: vi.fn(),
  lock: vi.fn(),
  disk: vi.fn()
}))
vi.mock('electron', () => ({ powerMonitor: { on: vi.fn() } }))
vi.mock('fs-extra', () => ({
  default: { remove: vi.fn(), statSync: () => ({ size: 1, mtimeMs: 1, ctimeMs: 1 }) }
}))
vi.mock('../store', () => ({ default: { databaseDir: 'test-library', settingConfig: {} } }))
vi.mock('../window/mainWindow', () => ({ default: { instance: null } }))
vi.mock('../log', () => ({ log: { error: vi.fn() } }))
vi.mock('../curatedLibrarySync/queue', () => ({
  enqueueCloudWork: (fn: () => Promise<unknown>) => Promise.resolve().then(fn)
}))
vi.mock('../curatedLibrarySync/blobTransfer', () => ({ uploadBlobWithResume: mocks.upload }))
vi.mock('../services/libraryMerge/mutationGate', () => ({
  isLibraryMergeMutationLocked: () => false,
  tryBeginLibraryMaintenanceMutation: mocks.lock
}))
vi.mock('./scan', () => ({
  scanSetLibrary: mocks.scan,
  setLocalGuard: () => mocks.guard,
  assertSetDiskUnchanged: mocks.disk
}))
vi.mock('./api', () => ({ setSyncRequest: mocks.request, setSyncUserKey: () => 'key' }))
vi.mock('./state', () => ({
  isSetLibrarySyncEnabled: () => mocks.enabled,
  readSetSyncBase: mocks.base
}))
vi.mock('./apply', () => ({ applySetSnapshot: mocks.apply }))
vi.mock('./treeTransaction', () => ({ recoverSetTreeTransaction: vi.fn() }))

const node = {
  id: '11111111-1111-4111-8111-111111111111',
  parentId: SET_SYNC_ROOT,
  name: 'SET',
  type: 'setList' as const,
  order: 1
}
const content = (order = 1, revision = 0, name = 'SET') => ({
  ...emptySetSnapshot(),
  revision,
  nodes: [{ ...node, order, name }]
})
const scanned = (snapshot = content()) => ({
  snapshot,
  directory: 'scan',
  files: new Map<string, string>(),
  guard: 'same'
})
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.enabled = true
  mocks.guard = 'same'
  mocks.disk.mockImplementation(() => {})
  mocks.lock.mockReturnValue(vi.fn())
  mocks.scan.mockResolvedValue(scanned())
  mocks.base.mockReturnValue(emptySetSnapshot())
  mocks.request.mockImplementation(async (endpoint, body) =>
    endpoint === 'pull' ? emptySetSnapshot() : { ...body, revision: 1 }
  )
  mocks.apply.mockResolvedValue(undefined)
})

it('coalesces concurrent starts and returns the terminal state after releasing maintenance', async () => {
  const engine = await import('./engine')
  const a = engine.enqueueSetLibrarySync()
  expect(engine.enqueueSetLibrarySync()).toBe(a)
  expect(await a).toMatchObject({ result: 'success', running: false, phase: 'idle' })
  expect(mocks.scan).toHaveBeenCalledTimes(1)
  expect(mocks.apply).toHaveBeenCalledTimes(1)
  expect(mocks.lock.mock.results[0].value).toHaveBeenCalledTimes(1)
})
it('pauses on concurrent order edits before uploading or changing local data', async () => {
  mocks.base.mockReturnValue(content(1, 1))
  mocks.scan.mockResolvedValue(scanned(content(2)))
  mocks.request.mockResolvedValue(content(3, 2))
  const engine = await import('./engine')
  expect(await engine.enqueueSetLibrarySync()).toMatchObject({
    result: 'conflicts',
    running: false
  })
  expect(mocks.request).toHaveBeenCalledTimes(1)
  expect(mocks.apply).not.toHaveBeenCalled()
  expect(mocks.upload).not.toHaveBeenCalled()
  await engine.enqueueSetLibrarySync(undefined, true)
  expect(mocks.request).toHaveBeenCalledTimes(1)
})
it('re-pulls and re-merges a revision race rather than overwriting another device', async () => {
  mocks.base.mockReturnValue(content(1, 1))
  mocks.scan.mockResolvedValue(scanned(content(2)))
  let pulls = 0
  let pushes = 0
  mocks.request.mockImplementation(async (endpoint, body) => {
    if (endpoint === 'pull')
      return ++pulls === 1 ? content(1, 1) : content(1, 2, 'Renamed elsewhere')
    if (++pushes === 1) throw new Error('SET_SYNC_REVISION_CONFLICT')
    return { ...body, revision: 3 }
  })
  const engine = await import('./engine')
  expect((await engine.enqueueSetLibrarySync()).result).toBe('success')
  expect(mocks.request).toHaveBeenLastCalledWith(
    'push',
    expect.objectContaining({
      baseRevision: 2,
      nodes: [expect.objectContaining({ order: 2, name: 'Renamed elsewhere' })]
    }),
    expect.any(AbortSignal)
  )
  expect(mocks.apply).toHaveBeenCalledTimes(1)
})
it('refuses a regressed cloud history and preserves local data', async () => {
  mocks.base.mockReturnValue(content(1, 2))
  mocks.request.mockResolvedValue(emptySetSnapshot())
  const engine = await import('./engine')
  expect(await engine.enqueueSetLibrarySync()).toMatchObject({
    result: 'failed',
    error: 'SET_SYNC_CLOUD_HISTORY_CHANGED'
  })
  expect(mocks.apply).not.toHaveBeenCalled()
})
it('does not run when disabled', async () => {
  mocks.enabled = false
  const engine = await import('./engine')
  expect((await engine.enqueueSetLibrarySync()).running).toBe(false)
  expect(mocks.scan).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalled()
})
