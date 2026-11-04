// Run: pnpm exec vitest run src/main/ipc/cloudSyncUserKey.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISettingConfig } from '../../types/globals'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
  store: { settingConfig: {} as Partial<ISettingConfig>, songFingerprintList: [] },
  is: { dev: false },
  setSyncEnabled: false,
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
vi.mock('../setLibrarySync/state', () => ({
  isSetLibrarySyncEnabled: () => mocks.setSyncEnabled
}))
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
vi.mock('../curatedLibrarySync/engine', () => ({
  runCuratedLibrarySync: vi.fn(),
  completeCuratedLibrarySyncStatus: vi.fn()
}))
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
import { enqueueCloudWork } from '../curatedLibrarySync/queue'

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
  mocks.setSyncEnabled = false
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
  it('SET 上传占用同步队列时，保存未修改的密钥立即成功', async () => {
    mocks.setSyncEnabled = true
    let release!: () => void
    const uploading = enqueueCloudWork(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await Promise.resolve()
    let result: unknown
    const saving = invoke('cloudSync/config/save', { userKey: ` ${oldKey} ` }).then((value) => {
      result = value
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(result).toEqual({ success: true, userKey: oldKey })
      expect(mocks.validate).not.toHaveBeenCalled()
      expect(mocks.persist).not.toHaveBeenCalled()
      expect(mocks.restartScheduler).not.toHaveBeenCalled()
    } finally {
      release()
      await uploading
      await saving
    }
  })

  it('SET 上传中更换密钥立即提示关闭同步，不等待传输结束', async () => {
    mocks.setSyncEnabled = true
    let release!: () => void
    const uploading = enqueueCloudWork(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await Promise.resolve()
    let result: unknown
    const saving = invoke('cloudSync/config/save', { userKey: newKey }).then((value) => {
      result = value
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(result).toEqual({
        success: false,
        message: 'cloudSync.setLibrary.cannotChangeUserKey'
      })
      expect(mocks.store.settingConfig.cloudSyncUserKey).toBe(oldKey)
      expect(mocks.validate).not.toHaveBeenCalled()
    } finally {
      release()
      await uploading
      await saving
    }
  })

  it('密钥等待保存期间开启 SET 同步，执行时仍必须拦截换密钥', async () => {
    mocks.store.settingConfig.curatedLibrarySyncEnabled = false
    let release!: () => void
    const uploading = enqueueCloudWork(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await Promise.resolve()
    const saving = invoke('cloudSync/config/save', { userKey: newKey })
    mocks.setSyncEnabled = true
    release()
    await uploading
    expect(await saving).toMatchObject({
      success: false,
      message: 'cloudSync.setLibrary.cannotChangeUserKey'
    })
    expect(mocks.validate).not.toHaveBeenCalled()
  })

  it('密钥校验期间开启 SET 同步，不能在请求完成后更换同步身份', async () => {
    mocks.store.settingConfig.curatedLibrarySyncEnabled = false
    mocks.validate.mockImplementation(async () => {
      mocks.setSyncEnabled = true
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ success: true, data: { isActive: true, userKey: newKey } })
      }
    })
    expect(await invoke('cloudSync/config/save', { userKey: newKey })).toMatchObject({
      success: false,
      message: 'cloudSync.setLibrary.cannotChangeUserKey'
    })
    expect(mocks.store.settingConfig.cloudSyncUserKey).toBe(oldKey)
    expect(mocks.persist).not.toHaveBeenCalled()
  })

  it('空密钥不能被当作已保存而跳过校验', async () => {
    mocks.store.settingConfig.curatedLibrarySyncEnabled = false
    mocks.store.settingConfig.cloudSyncUserKey = ''
    mocks.validate.mockResolvedValue({
      status: 400,
      text: async () => JSON.stringify({ success: false, error: 'INVALID_USER_KEY' })
    })
    expect(await invoke('cloudSync/config/save', { userKey: '' })).toMatchObject({ success: false })
    expect(mocks.validate).toHaveBeenCalledTimes(1)
  })

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
