import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { icloudOpen, icloudState, icloudPendingExport } from './icloudLibrary'
const mocks = vi.hoisted(() => ({
  setting: { showIcloudLibraryIcon: true, language: 'zh-CN' },
  invoke: vi.fn(),
  confirm: vi.fn()
}))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => ({ setting: mocks.setting }) }))
vi.mock('@renderer/components/confirmDialog', () => ({ default: mocks.confirm }))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
import { hideIcloudLibraryIcon, setIcloudLibraryIconVisible } from './icloudLibraryPreferences'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.setting = { showIcloudLibraryIcon: true, language: 'zh-CN' }
  mocks.invoke.mockResolvedValue(undefined)
  mocks.confirm.mockResolvedValue('confirm')
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke: mocks.invoke } } })
  icloudOpen.value = true
  icloudState.value = {
    supported: true,
    visible: true,
    available: true,
    configured: true,
    folder: 'Music'
  }
  icloudPendingExport.value = { localPlaylistUuid: 'test', paths: ['song.mp3'] }
})
afterEach(() => {
  vi.unstubAllGlobals()
  icloudOpen.value = false
  icloudState.value = null
  icloudPendingExport.value = null
})
describe('iCloud icon preference persistence', () => {
  it('hides through the normal settings channel without clearing folder configuration or pending songs', async () => {
    const state = icloudState.value
    const pending = icloudPendingExport.value
    await hideIcloudLibraryIcon()
    expect(mocks.setting.showIcloudLibraryIcon).toBe(false)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('setSetting', {
      showIcloudLibraryIcon: false,
      language: 'zh-CN'
    })
    expect(icloudState.value).toBe(state)
    expect(icloudPendingExport.value).toBe(pending)
    expect(icloudOpen.value).toBe(false)
  })
  it('hides in one action without a confirmation and can be restored in settings', async () => {
    await hideIcloudLibraryIcon()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.setting.showIcloudLibraryIcon).toBe(false)
    await setIcloudLibraryIconVisible(true)
    expect(mocks.setting.showIcloudLibraryIcon).toBe(true)
  })
  it('does not claim hiding succeeded if saving fails or settings writes are blocked', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('permission'))
    await expect(setIcloudLibraryIconVisible(false)).rejects.toThrow('permission')
    expect(mocks.setting.showIcloudLibraryIcon).toBe(true)
    mocks.invoke.mockResolvedValueOnce({ blocked: true })
    await expect(setIcloudLibraryIconVisible(false)).rejects.toThrow('failed')
    expect(mocks.setting.showIcloudLibraryIcon).toBe(true)
  })
  it('restores a hidden entry without modifying other settings', async () => {
    mocks.setting.showIcloudLibraryIcon = false
    await setIcloudLibraryIconVisible(true)
    expect(mocks.setting).toEqual({ showIcloudLibraryIcon: true, language: 'zh-CN' })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('setSetting', {
      showIcloudLibraryIcon: true,
      language: 'zh-CN'
    })
  })
})
