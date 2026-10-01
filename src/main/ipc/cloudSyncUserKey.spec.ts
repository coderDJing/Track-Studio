// Run: pnpm exec vitest run src/main/ipc/cloudSyncUserKey.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISettingConfig } from '../../types/globals'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
  store: { settingConfig: {} as Partial<ISettingConfig>, songFingerprintList: [] },
  is: { dev: false },
  validate: vi.fn(),
  persist: vi.fn(),
  saveLibrary: vi.fn(),
  forgetJoin: vi.fn(),
  clearPrompt: vi.fn(),
  restartScheduler: vi.fn(),
  liveSync: vi.fn(),
  syncTick: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: mocks.is }))
vi.mock('../store', () => ({ default: mocks.store }))
vi.mock('../settingsPersistence', () => ({ persistSettingConfig: mocks.persist }))
vi.mock('../librarySettingsDb', () => ({
  isCuratedLibrarySyncEnabled: () => mocks.store.settingConfig.curatedLibrarySyncEnabled === true,
  saveLibrarySettingsFromConfig: mocks.saveLibrary,
  forgetCuratedLibrarySyncJoinState: mocks.forgetJoin
}))
vi.mock('../curatedLibrarySync/joinPrompt', () => ({
  clearPendingCuratedLibraryJoinPrompt: mocks.clearPrompt
}))
vi.mock('../fetchWithSystemProxy', () => ({ fetchWithSystemProxy: mocks.validate }))
vi.mock('../serverDiscovery', () => ({ resolveBaseUrl: async () => 'https://sync.test' }))
vi.mock('../fingerprintStore', () => ({
  getCollectionHashForSync: vi.fn(),
  unionFingerprintList: vi.fn()
}))
vi.mock('../log', () => ({ log: { error: vi.fn() } }))
vi.mock('../curatedArtistCloudSync', () => ({
  getCuratedArtistSyncErrorPayload: vi.fn(),
  isCuratedArtistSyncUnsupportedServer: vi.fn(),
  syncCuratedArtistCloudSnapshot: vi.fn()
}))
vi.mock('../cloudSyncScheduler', () => ({
  bindCloudSyncScheduler: vi.fn(),
  restartCloudSyncScheduler: mocks.restartScheduler,
  runCuratedLibrarySyncTick: mocks.syncTick
}))
vi.mock('../curatedLibrarySync/liveSync', () => ({ syncCuratedLibraryLiveSync: mocks.liveSync }))
vi.mock('../curatedLibrarySync/queue', () => {
  let queued: Promise<unknown> = Promise.resolve()
  return {
    enqueueCloudWork: <T>(task: () => Promise<T>): Promise<T> => {
      const run = queued.then(task, task)
      queued = run.catch(() => undefined)
      return run
    }
  }
})
vi.mock('../window/mainWindow', () => ({
  default: { instance: null },
  syncWindowScreenshotShortcut: vi.fn()
}))
vi.mock('../bootstrap/settings', () => ({
  applyThemeFromSettings: vi.fn(),
  broadcastSystemThemeIfNeeded: vi.fn()
}))
vi.mock('../platform/windowsContextMenu', () => ({
  clearWindowsContextMenuSignature: vi.fn(),
  ensureWindowsContextMenuIfNeeded: vi.fn(),
  removeWindowsContextMenu: vi.fn()
}))
vi.mock('../menu/macMenu', () => ({ rebuildMacMenusForCurrentFocus: vi.fn() }))
vi.mock('../curatedArtistLibrary', () => ({
  clearCuratedArtistLibrary: vi.fn(),
  getCuratedArtistLibrarySnapshot: vi.fn(),
  importCuratedArtistsFromTracks: vi.fn(),
  replaceCuratedArtistLibrary: vi.fn(),
  removeCuratedArtist: vi.fn()
}))
vi.mock('../services/libraryMerge/runtime', () => ({ assertLibraryMergeMutationAllowed: vi.fn() }))

import '../cloudSync'
import { registerSettingsHandlers } from './settingsHandlers'
import { DEV_DEFAULT_CLOUD_SYNC_USER_KEY } from '../../shared/cloudSyncDevUserKey'

const invoke = async (channel: string, payload?: unknown) => {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return await handler(undefined, payload)
}

const oldKey = '11111111-1111-4111-8111-111111111111'
const newKey = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.is.dev = false
  mocks.store.settingConfig = {
    cloudSyncUserKey: oldKey,
    curatedLibrarySyncEnabled: true,
    cloudSyncAutoEnabled: false
  }
  registerSettingsHandlers({ loadFingerprintList: async () => [] })
  mocks.validate.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { userKey: string }
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ success: true, data: { isActive: true, userKey: body.userKey } })
    }
  })
})

describe('cloud sync userKey lifecycle', () => {
  it.each([false, true])('关闭同步、换密钥、重新打开后保持新密钥 (dev=%s)', async (isDev) => {
    mocks.is.dev = isDev
    const staleRendererSettings = { ...mocks.store.settingConfig }
    await invoke('setSetting', { ...staleRendererSettings, curatedLibrarySyncEnabled: false })
    expect(await invoke('cloudSync/config/save', { userKey: newKey })).toEqual({
      success: true,
      userKey: newKey
    })
    expect(await invoke('cloudSync/config/get')).toMatchObject({ userKey: newKey })
    await invoke('setSetting', { ...staleRendererSettings, curatedLibrarySyncEnabled: true })
    expect(mocks.store.settingConfig.cloudSyncUserKey).toBe(newKey)
    expect(await invoke('cloudSync/config/get')).toMatchObject({ userKey: newKey })
    expect(await invoke('cloudSync/config/save', { userKey: newKey })).toMatchObject({
      success: true
    })
    expect(mocks.forgetJoin).toHaveBeenCalledTimes(1)
    expect(mocks.clearPrompt).toHaveBeenCalledTimes(1)
    expect(mocks.syncTick).toHaveBeenCalledTimes(1)
  })

  it('精选库同步开启时仍拦截更换密钥', async () => {
    expect(await invoke('cloudSync/config/save', { userKey: newKey })).toEqual({
      success: false,
      message: 'cloudSync.curatedLibrary.errors.cannotChangeUserKey'
    })
    expect(mocks.validate).not.toHaveBeenCalled()
    expect(mocks.store.settingConfig.cloudSyncUserKey).toBe(oldKey)
  })

  it('普通设置不能绕过校验更换或清除密钥', async () => {
    await invoke('setSetting', { ...mocks.store.settingConfig, cloudSyncUserKey: newKey })
    expect(mocks.store.settingConfig.cloudSyncUserKey).toBe(oldKey)
    await invoke('setSetting', { curatedLibrarySyncEnabled: false })
    expect(mocks.store.settingConfig.cloudSyncUserKey).toBe(oldKey)
  })

  it('密钥校验失败时保留原密钥与对齐状态', async () => {
    mocks.store.settingConfig.curatedLibrarySyncEnabled = false
    mocks.validate.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ success: false, error: 'INVALID_USER_KEY' })
    })
    expect(await invoke('cloudSync/config/save', { userKey: newKey })).toMatchObject({
      success: false
    })
    expect(mocks.store.settingConfig.cloudSyncUserKey).toBe(oldKey)
    expect(mocks.forgetJoin).not.toHaveBeenCalled()
  })

  it('保存服务端返回的规范密钥', async () => {
    mocks.store.settingConfig.curatedLibrarySyncEnabled = false
    mocks.validate.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { isActive: true, userKey: newKey } })
    })
    expect(await invoke('cloudSync/config/save', { userKey: 'input-key' })).toEqual({
      success: true,
      userKey: newKey
    })
    expect(mocks.store.settingConfig.cloudSyncUserKey).toBe(newKey)
  })

  it('开发模式仅在未配置密钥时提供默认值', async () => {
    mocks.is.dev = true
    mocks.store.settingConfig.cloudSyncUserKey = ''
    expect(await invoke('cloudSync/config/get')).toMatchObject({
      userKey: DEV_DEFAULT_CLOUD_SYNC_USER_KEY
    })
  })

  it('正式模式未配置密钥时保持为空', async () => {
    mocks.store.settingConfig.cloudSyncUserKey = ''
    expect(await invoke('cloudSync/config/get')).toMatchObject({ userKey: '' })
  })
})
