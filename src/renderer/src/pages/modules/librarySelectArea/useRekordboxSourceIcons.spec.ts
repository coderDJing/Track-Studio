import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, reactive } from 'vue'
import {
  buildRekordboxSourceCacheKey,
  clearRekordboxSourceCachesByKind,
  getCachedRekordboxSourceTree,
  setCachedRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { useRekordboxSourceIcons } from './useRekordboxSourceIcons'
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
  for (const icon of [device, one, other]) setCachedRekordboxSourceTree(cacheKey(icon), [])
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
  vi.unstubAllGlobals()
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
