import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive } from 'vue'
import {
  buildRekordboxSourceCacheKey,
  clearRekordboxSourceCachesByKind,
  getCachedRekordboxSourceTree,
  setCachedRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { useRekordboxSourceIcons } from './useRekordboxSourceIcons'
import { isRepairableRekordboxRuntimeError } from './rekordboxRuntimeDownload'
import {
  applyOptionalComponentDownloadState,
  resetOptionalComponentDownloadsForTests,
  useOptionalComponentDownloads
} from '@renderer/composables/useOptionalComponentDownloads'
import type { PioneerDriveIcon } from './useRekordboxSourceIcons'

const { invoke, confirm, menu } = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  menu: vi.fn()
}))
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onMounted: vi.fn(),
  onUnmounted: vi.fn()
}))
vi.mock('@renderer/components/confirmDialog', () => ({ default: confirm }))
vi.mock('@renderer/components/rightClickMenu', () => ({ default: menu }))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/utils/mitt', () => ({ default: { emit: vi.fn() } }))
vi.mock('@renderer/utils/similarTracksActions', () => ({
  collectRekordboxSimilarTracksSeeds: vi.fn(),
  openBatchSimilarTracksDialogForSeeds: vi.fn()
}))
vi.mock('@renderer/utils/fingerprintActions', () => ({ analyzeFingerprintsForPaths: vi.fn() }))
vi.mock('@renderer/composables/rekordboxDesktop/useImportCuratedArtists', () => ({
  importCuratedArtistsFromPioneerSource: vi.fn()
}))

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const cacheKey = (icon: PioneerDriveIcon) =>
  buildRekordboxSourceCacheKey({
    sourceKind: 'usb',
    sourceKey: icon.key,
    rootPath: icon.path,
    libraryType: icon.libraryType
  })

const scopes: ReturnType<typeof effectScope>[] = []
const fixture = async () => {
  type Options = Parameters<typeof useRekordboxSourceIcons>[0]
  const runtime = reactive({
    libraryAreaSelected: 'PioneerDeviceLibrary',
    isProgressing: false,
    pioneerDeviceLibrary: {
      selectedSourceKey: '',
      selectedSourceRootPath: '',
      selectedSourceKind: '',
      selectedLibraryType: '',
      selectedPlaylistId: 0,
      treeNodes: []
    },
    songsArea: { songListUUID: '' },
    externalDjLibrary: {}
  }) as unknown as Options['runtime']
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() =>
    useRekordboxSourceIcons({
      runtime,
      usbDriveIconAsset: 'usb.svg',
      rekordboxDesktopIconAsset: 'desktop.svg',
      updateSelectedIcon: vi.fn(),
      waitForUiIdle: vi.fn().mockResolvedValue(undefined),
      emitLibrarySelectedChange: vi.fn()
    })
  )!
  await state.refreshRekordboxSourceIcons({ force: true })
  const [device, one, other] = state.pioneerDriveIcons.value
  // 纯 RKB 运行时用例不提供 USB 列表，fixture 必须允许空列表。
  for (const icon of state.pioneerDriveIcons.value) {
    setCachedRekordboxSourceTree(cacheKey(icon), [])
  }
  const select = (icon: PioneerDriveIcon) =>
    Object.assign(runtime.pioneerDeviceLibrary, {
      selectedSourceKey: icon.key,
      selectedSourceRootPath: icon.path,
      selectedSourceKind: 'usb',
      selectedLibraryType: icon.libraryType,
      selectedPlaylistId: 42,
      treeNodes: [{ id: 42, name: 'Playlist', isFolder: false }]
    })
  const eject = (icon: PioneerDriveIcon) =>
    state.handlePioneerDriveContextmenu({ preventDefault: vi.fn() } as unknown as MouseEvent, icon)
  return { state, runtime, device, one, other, select, eject }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('navigator', { platform: 'Win32' })
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  menu.mockResolvedValue({ menuName: 'library.ejectUsbDrive' })
  confirm.mockResolvedValue('confirm')
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'rekordbox-desktop-library:probe') return { available: false }
    if (channel === 'pioneer-device-library:list-removable-drives')
      return [
        {
          id: 'E:',
          path: 'E:/',
          isPioneerDeviceLibrary: true,
          supportedLibraryTypes: ['deviceLibrary', 'oneLibrary']
        },
        {
          id: 'F:',
          path: 'F:/',
          isPioneerDeviceLibrary: true,
          supportedLibraryTypes: ['deviceLibrary']
        }
      ]
    throw new Error(`Unexpected IPC: ${channel}`)
  })
})

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
  clearRekordboxSourceCachesByKind('usb')
  resetOptionalComponentDownloadsForTests()
  vi.unstubAllGlobals()
})

describe('rekordbox desktop runtime download entry', () => {
  const probeChannel = 'rekordbox-desktop-library:probe'
  const downloadChannel = 'optional-component:download'

  it('only treats missing or damaged runtime errors as repairable', () => {
    expect(isRepairableRekordboxRuntimeError('PYTHON_RUNTIME_MISSING')).toBe(true)
    expect(isRepairableRekordboxRuntimeError('PYREKORDBOX_UNAVAILABLE')).toBe(true)
    // 桥脚本随 app 发布，不在下载包内，下载无法修复。
    expect(isRepairableRekordboxRuntimeError('BRIDGE_SCRIPT_MISSING')).toBe(false)
    expect(isRepairableRekordboxRuntimeError('UNSUPPORTED_PLATFORM')).toBe(false)
    expect(isRepairableRekordboxRuntimeError(undefined)).toBe(false)
  })

  it('hides the component entry when the main process found no local rekordbox installation or library', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel) return { available: false, errorCode: 'REKORDBOX_NOT_FOUND' }
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })

    const { state } = await fixture()

    expect(state.desktopRuntimeMissing.value).toBe(false)
    expect(state.desktopLibraryIcon.value).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
    expect(invoke.mock.calls.some(([channel]) => channel === downloadChannel)).toBe(false)
  })

  it('removes a previously visible download entry when local rekordbox evidence disappears', async () => {
    let errorCode = 'PYTHON_RUNTIME_MISSING'
    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel) return { available: false, errorCode }
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })

    const { state } = await fixture()
    expect(state.desktopRuntimeMissing.value).toBe(true)
    errorCode = 'REKORDBOX_NOT_FOUND'
    await state.refreshRekordboxSourceIcons({ force: true })
    expect(state.desktopRuntimeMissing.value).toBe(false)
    expect(invoke.mock.calls.some(([channel]) => channel === downloadChannel)).toBe(false)
  })

  it('shows the repair entry for a damaged component without downloading', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel)
        return { available: false, errorCode: 'PYREKORDBOX_UNAVAILABLE' }
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })

    const { state } = await fixture()

    expect(state.desktopRuntimeMissing.value).toBe(true)
    expect(invoke.mock.calls.some(([channel]) => channel === downloadChannel)).toBe(false)
  })

  it('shows the missing entry without downloading during startup probe', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel) return { available: false, errorCode: 'PYTHON_RUNTIME_MISSING' }
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })

    const { state } = await fixture()

    expect(state.desktopRuntimeMissing.value).toBe(true)
    expect(invoke.mock.calls.some(([channel]) => channel === downloadChannel)).toBe(false)
  })

  it('downloads only after confirmation, then re-probes and restores the icon', async () => {
    let probeCount = 0
    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel) {
        probeCount += 1
        return probeCount === 1
          ? { available: false, errorCode: 'PYTHON_RUNTIME_MISSING' }
          : { available: true, sourceRootPath: 'D:/Pioneer', sourceKey: 'rekordbox-desktop' }
      }
      if (channel === downloadChannel) return { ok: true }
      if (channel === 'optional-component:states') return []
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })

    const { state } = await fixture()
    expect(state.desktopRuntimeMissing.value).toBe(true)

    const downloaded = await state.downloadDesktopRuntime()

    expect(downloaded).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(downloadChannel, 'rekordbox-desktop-runtime')
    expect(state.desktopRuntimeMissing.value).toBe(false)
    expect(state.desktopLibraryIcon.value?.rootPath).toBe('D:/Pioneer')
  })

  it('does not download when the user cancels the confirmation', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel) return { available: false, errorCode: 'PYTHON_RUNTIME_MISSING' }
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    confirm.mockResolvedValue('cancel')

    const { state, runtime } = await fixture()
    const downloaded = await state.downloadDesktopRuntime()

    expect(downloaded).toBe(false)
    expect(invoke.mock.calls.some(([channel]) => channel === downloadChannel)).toBe(false)
    expect(runtime.pioneerDeviceLibrary.selectedSourceKind).toBe('')
    expect(state.desktopRuntimeMissing.value).toBe(true)
  })

  it('keeps the entry and reports failure so the user can retry', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel) return { available: false, errorCode: 'PYTHON_RUNTIME_MISSING' }
      if (channel === downloadChannel) return { ok: false, error: 'network down' }
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })

    const { state } = await fixture()
    expect(await state.downloadDesktopRuntime()).toBe(false)
    expect(state.desktopRuntimeMissing.value).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)

    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel) {
        return { available: true, sourceRootPath: 'D:/Pioneer', sourceKey: 'rekordbox-desktop' }
      }
      if (channel === downloadChannel) return { ok: true }
      if (channel === 'optional-component:states') return []
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    expect(await state.downloadDesktopRuntime()).toBe(true)
    expect(invoke.mock.calls.filter(([channel]) => channel === downloadChannel)).toHaveLength(2)
  })

  it('refreshes the source immediately when the generic overlay retries to ready', async () => {
    let downloadAttempts = 0
    let runtimeReady = false
    let probeCalls = 0
    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel) {
        probeCalls += 1
        return runtimeReady
          ? { available: true, sourceRootPath: 'D:/Pioneer', sourceKey: 'rekordbox-desktop' }
          : { available: false, errorCode: 'PYTHON_RUNTIME_MISSING' }
      }
      if (channel === downloadChannel) {
        downloadAttempts += 1
        if (downloadAttempts === 1) return { ok: false, error: 'manifest 500' }
        runtimeReady = true
        return { ok: true }
      }
      if (channel === 'optional-component:states') {
        return runtimeReady
          ? [
              {
                id: 'rekordbox-desktop-runtime',
                status: 'ready',
                percent: 100,
                downloadedBytes: 1,
                totalBytes: 1,
                error: '',
                updatedAt: Date.now() + 1000
              }
            ]
          : []
      }
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })

    const { state, runtime } = await fixture()
    expect(await state.downloadDesktopRuntime()).toBe(false)
    expect(state.desktopRuntimeMissing.value).toBe(true)
    const probesBeforeRetry = probeCalls

    const { retry } = useOptionalComponentDownloads()
    await retry('rekordbox-desktop-runtime')

    await vi.waitFor(() => expect(state.desktopLibraryIcon.value?.rootPath).toBe('D:/Pioneer'))
    expect(state.desktopRuntimeMissing.value).toBe(false)
    expect(probeCalls).toBeGreaterThan(probesBeforeRetry)
    expect(downloadAttempts).toBe(2)
    // 刷新只更新来源图标，不改变当前列表/选择。
    expect(runtime.pioneerDeviceLibrary.selectedSourceKind).toBe('')
  })

  it('does not refresh for ready states of other components', async () => {
    let probeCalls = 0
    invoke.mockImplementation(async (channel: string) => {
      if (channel === probeChannel) {
        probeCalls += 1
        return { available: false, errorCode: 'PYTHON_RUNTIME_MISSING' }
      }
      if (channel === 'pioneer-device-library:list-removable-drives') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    })

    await fixture()
    const probesBefore = probeCalls
    applyOptionalComponentDownloadState({
      id: 'stem-model-htdemucs',
      status: 'ready',
      percent: 100,
      downloadedBytes: 1,
      totalBytes: 1,
      error: '',
      updatedAt: Date.now() + 1000
    } satisfies Parameters<typeof applyOptionalComponentDownloadState>[0])
    await nextTick()

    expect(probeCalls).toBe(probesBefore)
  })
})

describe('ejecting a USB with both library formats', () => {
  it.each(['deviceLibrary', 'oneLibrary'] as const)(
    'removes both icons and caches together before refresh when ejecting %s',
    async (libraryType) => {
      const { state, runtime, device, one, other, select, eject } = await fixture()
      // The other library on the same physical USB is currently open.
      select(libraryType === 'deviceLibrary' ? one : device)
      const refresh = deferred<unknown[]>()
      const refreshing = deferred<void>()
      invoke.mockImplementation((channel: string) => {
        if (channel === 'pioneer-device-library:eject-drive') {
          expect(runtime.pioneerDeviceLibrary.selectedSourceKey).toBe('')
          return Promise.resolve({ success: true, path: 'E:/' })
        }
        if (channel === 'pioneer-device-library:list-removable-drives') {
          refreshing.resolve()
          return refresh.promise
        }
        throw new Error(`Unexpected IPC: ${channel}`)
      })
      const task = eject(libraryType === 'deviceLibrary' ? device : one)
      await refreshing.promise
      expect(state.pioneerDriveIcons.value.map((icon) => icon.key)).toEqual([other.key])
      expect(getCachedRekordboxSourceTree(cacheKey(device))).toBeNull()
      expect(getCachedRekordboxSourceTree(cacheKey(one))).toBeNull()
      expect(getCachedRekordboxSourceTree(cacheKey(other))).not.toBeNull()
      refresh.resolve([
        {
          id: 'F:',
          path: 'F:/',
          isPioneerDeviceLibrary: true,
          supportedLibraryTypes: ['deviceLibrary']
        }
      ])
      await task
      expect(runtime.libraryAreaSelected).toBe('FilterLibrary')
    }
  )

  it.each(['failure', 'exception'])(
    'blocks both icons during eject and restores the sibling selection on %s',
    async (outcome) => {
      const { state, runtime, device, one, select, eject } = await fixture()
      select(one)
      const pending = deferred<{ success: boolean }>()
      invoke.mockImplementation(() =>
        pending.promise.then((result) => {
          if (outcome === 'exception') throw new Error('busy')
          return result
        })
      )
      const task = eject(device)
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('pioneer-device-library:eject-drive', device.path)
      )
      expect(state.isEjectingPioneerDriveIcon(device)).toBe(true)
      expect(state.isEjectingPioneerDriveIcon({ ...one, path: 'e:\\' })).toBe(true)
      await state.clickPioneerDriveIcon(one)
      await eject(one)
      expect(
        invoke.mock.calls.filter(([channel]) => channel === 'pioneer-device-library:eject-drive')
      ).toHaveLength(1)
      expect(runtime.pioneerDeviceLibrary.selectedSourceKey).toBe('')
      pending.resolve({ success: false })
      await task
      expect(state.pioneerDriveIcons.value).toHaveLength(3)
      expect(runtime.pioneerDeviceLibrary.selectedSourceKey).toBe(one.key)
      expect(runtime.pioneerDeviceLibrary.selectedPlaylistId).toBe(42)
      expect(state.isEjectingPioneerDriveIcon(one)).toBe(false)
      expect(confirm).toHaveBeenCalledOnce()
    }
  )
})
