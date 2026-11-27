import { clearIcloudViews } from '@renderer/utils/icloudViewState'
import { createPinia, setActivePinia } from 'pinia'
// @vitest-environment ./tests/vueClientEnvironment.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertIcloudMaskCss } from '../../../../../tests/assertIcloudMaskCss'
import { watch, reactive, defineComponent, h, type Component, type PropType } from 'vue'
import { HostNode, renderer, nodes, text, flush, teleportBody } from '../../../../../tests/vueHost'
import { icloudListPresentation } from '@renderer/utils/icloudListPresentation'
import Panel from './IcloudLibraryPanel.vue'
import Entry from './IcloudLibraryEntry.vue'
import FolderTree from './IcloudFolderTree.vue'
import icloudIcon from '@renderer/assets/icloud.svg?asset'
import IcloudSettings from '@renderer/components/settingDialog/IcloudLibrarySettings.vue'
import type { ISongInfo } from 'src/types/globals'
import { ICLOUD_DRAG_MIME, parseIcloudDragPayload } from '@shared/icloudLibrary'
import {
  icloudOpen,
  icloudDirectory,
  icloudDirectorySelected,
  selectIcloudDirectory,
  icloudSongDragging,
  icloudPendingExport,
  icloudState,
  icloudTransfer,
  openIcloudExport
} from '@renderer/utils/icloudLibrary'
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  remove: vi.fn(),
  select: vi.fn(),
  menu: vi.fn(),
  setting: { showIcloudLibraryIcon: true },
  runtime: {
    setting: { showIcloudLibraryIcon: true },
    mainWindowBrowseMode: 'browser',
    libraryAreaSelected: 'CuratedLibrary',
    songsArea: { songListUUID: 'local' },
    playingData: {
      playingSong: null as ISongInfo | null,
      playingSongListUUID: '',
      playingSongListData: [] as ISongInfo[]
    }
  },
  available: true,
  copyError: '',
  playError: ''
}))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => mocks.runtime }))
vi.mock('@renderer/components/confirmDialog', () => ({ default: vi.fn(async () => 'confirm') }))
vi.mock('@renderer/components/singleCheckbox.vue', () => ({
  default: defineComponent({
    props: { modelValue: Boolean, disabled: Boolean },
    emits: ['update:modelValue'],
    setup:
      (props, { emit }) =>
      () =>
        h(
          'button',
          { 'data-show-icon': true, onClick: () => emit('update:modelValue', !props.modelValue) },
          String(props.modelValue)
        )
  })
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/components/bubbleBox.vue', () => ({ default: { render: () => null } }))
vi.mock('@renderer/components/rightClickMenu', () => ({ default: mocks.menu }))
vi.mock('@renderer/components/selectSongListDialog', () => ({ default: mocks.select }))
vi.mock('overlayscrollbars-vue', () => ({
  OverlayScrollbarsComponent: defineComponent({
    setup(_, { slots, expose }) {
      expose({ osInstance: () => ({ elements: () => ({ viewport: null }) }) })
      return () => h('div', slots.default?.())
    }
  })
}))
vi.mock('@renderer/components/bubbleBoxTrigger.vue', () => ({
  default: defineComponent({
    props: { tag: { type: String, default: 'span' }, title: String },
    setup:
      (props, { attrs, slots }) =>
      () =>
        h(props.tag, attrs, slots.default?.())
  })
}))
vi.mock('./songsArea/SongListHeader.vue', () => ({ default: { render: () => null } }))
vi.mock('./songsArea/ColumnHeaderContextMenu.vue', () => ({ default: { render: () => null } }))
vi.mock('./songsArea/SongListRows.vue', () => ({
  default: defineComponent({
    props: { songs: { type: Array as PropType<ISongInfo[]>, required: true } },
    emits: ['song-click', 'song-dblclick', 'song-contextmenu', 'song-dragstart', 'visible-songs'],
    setup(props, { emit, slots }) {
      watch(
        () => props.songs,
        (rows) => emit('visible-songs', rows.slice(0, 10)),
        { immediate: true }
      )
      return () =>
        h(
          'div',
          props.songs.map((song) =>
            h(
              'div',
              {
                'data-cloud-row': song.filePath,
                'data-song-object': song,
                onClick: (event: MouseEvent) => emit('song-click', event, song),
                onDblclick: (event: MouseEvent) => emit('song-dblclick', song, event),
                onContextmenu: (event: MouseEvent) => emit('song-contextmenu', event, song),
                onDragstart: (event: DragEvent) => emit('song-dragstart', event, song)
              },
              [song.title, slots['cell-icloudStatus']?.({ song })]
            )
          )
        )
    }
  })
}))
let unmount: (() => void) | undefined
beforeEach(() => {
  clearIcloudViews()
  setActivePinia(createPinia())
  const savedColumns = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => savedColumns.get(key) ?? null,
    setItem: (key: string, value: string) => savedColumns.set(key, value)
  })
  vi.clearAllMocks()
  teleportBody.children = []
  mocks.setting = reactive({ showIcloudLibraryIcon: true })
  mocks.runtime = reactive({
    setting: mocks.setting,
    mainWindowBrowseMode: 'browser',
    libraryAreaSelected: 'CuratedLibrary',
    songsArea: { songListUUID: 'local' },
    playingData: {
      playingSong: null as ISongInfo | null,
      playingSongListUUID: '',
      playingSongListData: [] as ISongInfo[]
    }
  })
  Object.assign(icloudTransfer, {
    busy: false,
    requestId: '',
    error: '',
    results: [],
    progress: null
  })
  mocks.available = true
  mocks.copyError = ''
  mocks.playError = ''
  mocks.select.mockResolvedValue({ uuid: 'destination' })
  mocks.menu.mockResolvedValue('cancel')
  icloudDirectory.value = ''
  icloudDirectorySelected.value = false
  icloudSongDragging.value = false
  icloudOpen.value = true
  icloudState.value = null
  icloudPendingExport.value = null
  mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'icloud:state')
      return {
        ok: true,
        value: {
          supported: true,
          visible: true,
          available: mocks.available,
          configured: true,
          folder: '',
          rootToken: 'root-token'
        }
      }
    if (channel === 'icloud:metadata') return { ok: true, value: [] }
    if (channel === 'icloud:list')
      return {
        ok: true,
        value: {
          entries: [
            { name: 'Cloud.mp3', relativePath: 'Cloud.mp3', directory: false, residency: 'cloud' }
          ],
          total: 1,
          rootToken: 'root-token'
        }
      }
    if (channel === 'icloud:choose-destination')
      return {
        ok: true,
        value: { directory: 'Picked', token: 'chosen-token', rootToken: 'root-token' }
      }
    if (channel === 'icloud:authorize-destination')
      return {
        ok: true,
        value: { directory: args[0], token: 'explicit-token', rootToken: 'root-token' }
      }
    if (channel === 'icloud:use-default-folder')
      return {
        ok: true,
        value: { supported: true, visible: true, configured: true, available: true, folder: '' }
      }
    if (channel === 'icloud:copy')
      return mocks.copyError
        ? { ok: false, error: mocks.copyError }
        : { ok: true, value: [{ source: 'Cloud.mp3', status: 'copied' }] }
    if (channel === 'icloud:prepare-play')
      return { ok: false, error: mocks.playError || 'download' }
    return { ok: true, value: undefined }
  })
  vi.stubGlobal('HTMLInputElement', class {})
  vi.stubGlobal('HTMLElement', HostNode)
  vi.stubGlobal('Document', class {})
  vi.stubGlobal('ShadowRoot', class {})
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('window', {
    electron: { ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.remove } }
  })
})
afterEach(() => {
  unmount?.()
  unmount = undefined
  icloudOpen.value = false
  icloudState.value = null
  icloudPendingExport.value = null
  vi.unstubAllGlobals()
})
const mount = async (component: Component = Panel) => {
  const root = new HostNode('root')
  const app = renderer.createApp(component)
  app.mount(root)
  unmount = () => app.unmount()
  await flush()
  return root
}
const click = async (root: HostNode, key: string) => {
  const button = nodes(root).find(
    (node) =>
      node.type === 'button' && (text(node).includes(key) || node.props['aria-label'] === key)
  )
  expect(button, key).toBeDefined()
  await (button!.props.onClick as (event: unknown) => unknown)({
    stopPropagation: vi.fn(),
    preventDefault: vi.fn()
  })
  await flush()
}
describe('iCloud music list interactions', () => {
  it('merges real metadata into the same selected row without changing copy identity', async () => {
    const original = mocks.invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    mocks.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'icloud:list')
        return Promise.resolve({
          ok: true,
          value: {
            entries: [
              { name: 'Local.wav', relativePath: 'Local.wav', directory: false, residency: 'local' }
            ],
            total: 1,
            rootToken: 'root-token'
          }
        })
      if (channel === 'icloud:metadata')
        return new Promise((resolve) => {
          finish = resolve
        })
      return original(channel, ...args)
    })
    const root = await mount(),
      row = nodes(root).find((node) => node.props['data-cloud-row'])!
    const identity = row.props['data-song-object']
    await (row.props.onClick as (event: unknown) => void)({})
    finish({
      ok: true,
      value: [
        {
          relativePath: 'Local.wav',
          metadata: {
            title: 'Tagged title',
            artist: 'Tagged artist',
            album: 'Tagged album',
            duration: '2:34',
            bpm: 124.5,
            key: 'Am'
          }
        }
      ]
    })
    await flush()
    const updated = nodes(root).find((node) => node.props['data-cloud-row'])!
    expect(updated.props['data-song-object']).toBe(identity)
    expect(identity).toMatchObject({
      artist: 'Tagged artist',
      album: 'Tagged album',
      duration: '2:34',
      bpm: 124.5,
      key: 'Am'
    })
    expect(text(updated)).toContain('Tagged title')
    const data = new Map<string, string>()
    await (updated.props.onDragstart as (event: unknown) => void)({
      dataTransfer: { setData: (key: string, value: string) => data.set(key, value) },
      stopPropagation: vi.fn()
    })
    expect(parseIcloudDragPayload(data.get(ICLOUD_DRAG_MIME)!)).toMatchObject({
      rootToken: 'root-token',
      paths: ['Local.wav']
    })
  })
  it('keeps configured unavailable libraries visible without copying, downloading or choosing a folder', async () => {
    mocks.available = false
    const root = await mount()
    expect(text(root)).toContain('icloud.unavailable')
    expect(text(root)).not.toContain('icloud.emptyMusic')
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual(['icloud:state'])
  })
  it('opens the current Drive folder without a configuration dialog or permanent explanations', async () => {
    const root = await mount()
    expect(text(root)).not.toContain('common.close')
    expect(text(root)).toContain('Cloud')
    expect(text(root)).not.toContain('icloud.musicHint')
    expect(text(root)).not.toContain('icloud.copyNotice')
    expect(text(root)).not.toContain('icloud.driveProjectionHint')
    expect(mocks.invoke).toHaveBeenCalledWith('icloud:list', '', null, '', 'root-token')
    expect(
      mocks.invoke.mock.calls.some(([channel]) => /choose|prepare-play|copy/.test(channel))
    ).toBe(false)
    expect(nodes(root).some((node) => node.type === 'audio')).toBe(false)
    const directory = icloudDirectory.value
    mocks.runtime.libraryAreaSelected = 'FilterLibrary'
    await flush()
    expect(icloudOpen.value).toBe(false)
    expect(icloudDirectory.value).toBe(directory)
  })
  it('keeps successful copies quiet and shows only nonzero result counts without stale progress', async () => {
    const root = await mount()
    icloudTransfer.results = [
      { source: 'song.mp3', status: 'copied', destination: '/cloud/song.mp3' }
    ]
    icloudTransfer.progress = { done: 1, total: 1, current: 'old progress filename' }
    await flush()
    expect(text(root)).toContain('icloud.copiedCount')
    expect(text(root)).not.toContain('icloud.failedCount')
    expect(text(root)).not.toContain('icloud.skippedCount')
    expect(text(root)).not.toContain('old progress filename')
    expect(text(root)).not.toContain('icloud.copyNotice')
    expect(nodes(root).some((node) => node.type === 'details')).toBe(false)
  })
  it('keeps copy failures available in one expandable detail area, without repeating a full-width alert for every file', async () => {
    const root = await mount()
    icloudTransfer.results = [
      { source: 'good.mp3', status: 'copied', destination: '/cloud/good.mp3' },
      { source: 'bad.mp3', status: 'failed', error: 'permission' }
    ]
    await flush()
    expect(text(root)).toContain('icloud.failedCount')
    const details = nodes(root).find((node) => node.type === 'details')!
    expect(details).toBeDefined()
    expect(details.props.open).not.toBe(true)
    expect(text(details)).toContain('bad.mp3')
    expect(text(details)).toContain('icloud.errors.permission')
    expect(nodes(details).some((node) => node.type === 'summary')).toBe(true)
    expect(nodes(details).some((node) => node.props.role === 'alert')).toBe(false)
  })
  it('does not label an inaccessible folder as an empty song list', async () => {
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'icloud:list'
        ? Promise.resolve({ ok: false, error: 'download' })
        : original(channel, ...args)
    )
    const root = await mount()
    expect(text(root)).toContain('icloud.folderNotLocal')
    expect(text(root)).not.toContain('icloud.emptyMusic')
    expect(text(root)).not.toContain('icloud.unavailable')
  })
  it('waits for the requested file, then continues in the existing main player', async () => {
    const original = mocks.invoke.getMockImplementation()!
    let resolve!: (value: unknown) => void
    mocks.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'icloud:metadata')
        return Promise.resolve({
          ok: true,
          value: [
            { relativePath: 'Cloud.mp3', metadata: { artist: 'Downloaded artist', bpm: 128 } }
          ]
        })
      return channel === 'icloud:prepare-play'
        ? new Promise((done) => {
            resolve = done
          })
        : original(channel, ...args)
    })
    const root = await mount()
    const row = nodes(root).find((node) => node.props['data-cloud-row'])!
    ;(row.props.onDblclick as () => void)()
    await flush()
    expect(text(root)).toContain('icloud.waiting')
    expect(mocks.runtime.playingData.playingSong).toBe(null)
    expect(mocks.invoke).toHaveBeenCalledWith(
      'icloud:prepare-play',
      'Cloud.mp3',
      expect.objectContaining({ rootToken: 'root-token', requestId: expect.any(String) })
    )
    resolve({ ok: true, value: 'frkb-preview://icloud/?path=Cloud.mp3&ticket=ready' })
    await flush()
    expect(mocks.runtime.playingData.playingSong?.filePath).toContain('ticket=ready')
    expect(mocks.runtime.playingData.playingSongListData).toHaveLength(1)
    expect(mocks.runtime.playingData.playingSong).toMatchObject({
      artist: 'Downloaded artist',
      bpm: 128
    })
    expect(row.props['data-song-object']).toMatchObject({ artist: 'Downloaded artist', bpm: 128 })
  })
  it('cancels waiting asynchronously, blocks late continuation and retries in the same row', async () => {
    const original = mocks.invoke.getMockImplementation()!
    const pending: ((value: unknown) => void)[] = []
    mocks.invoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'icloud:prepare-play'
        ? new Promise((done) => pending.push(done))
        : original(channel, ...args)
    )
    const root = await mount()
    const row = nodes(root).find((node) => node.props['data-cloud-row'])!
    ;(row.props.onDblclick as () => void)()
    await flush()
    await click(root, 'icloud.cancel')
    expect(mocks.invoke).toHaveBeenCalledWith('icloud:cancel', expect.any(String))
    pending[0]({ ok: true, value: 'frkb-preview://icloud/?path=Cloud.mp3&ticket=late' })
    await flush()
    expect(mocks.runtime.playingData.playingSong).toBe(null)
    expect(text(root)).toContain('icloud.errors.cancelled')
    const retry = click(root, 'icloud.retry')
    await flush()
    pending[1]({ ok: true, value: 'frkb-preview://icloud/?path=Cloud.mp3&ticket=retry' })
    await retry
    expect(mocks.runtime.playingData.playingSong?.filePath).toContain('ticket=retry')
  })
  it('shows an offline error in the original song row without claiming it is missing', async () => {
    mocks.playError = 'offline'
    const root = await mount()
    const row = nodes(root).find((node) => node.props['data-cloud-row'])!
    ;(row.props.onDblclick as () => void)()
    await flush()
    expect(text(root)).toContain('icloud.errors.offline')
    expect(text(root)).toContain('icloud.retry')
    expect(mocks.runtime.playingData.playingSong).toBe(null)
  })
  it.each([
    ['library.copyToFilter', 'FilterLibrary'],
    ['library.copyToCurated', 'CuratedLibrary']
  ])('offers %s as a copy-only right-click alternative', async (menuName, libraryName) => {
    mocks.menu.mockResolvedValue({ menuName })
    const root = await mount()
    const row = nodes(root).find((node) => node.props['data-cloud-row'])!
    ;(row.props.onContextmenu as (event: unknown) => void)({})
    await flush()
    expect(mocks.select).toHaveBeenCalledWith({ libraryName, actionMode: 'copy' })
    expect(mocks.invoke).toHaveBeenCalledWith(
      'icloud:copy',
      expect.objectContaining({
        direction: 'to-local',
        localPlaylistUuid: 'destination',
        paths: ['Cloud.mp3'],
        rootToken: 'root-token'
      })
    )
  })
  it('refreshes an open list after a settings location change and binds new drags to the new root', async () => {
    const root = await mount()
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'icloud:state')
        return {
          ok: true,
          value: { ...icloudState.value, rootToken: 'new-root', folder: 'Custom Music' }
        }
      if (channel === 'icloud:list')
        return {
          ok: true,
          value: {
            entries: [
              { name: 'New.mp3', relativePath: 'New.mp3', directory: false, residency: 'local' }
            ],
            total: 1,
            rootToken: 'new-root'
          }
        }
      return original(channel, ...args)
    })
    icloudState.value = { ...icloudState.value!, rootToken: 'new-root', folder: 'Custom Music' }
    await flush()
    expect(text(root)).toContain('New')
    expect(text(root)).not.toContain('Cloud.mp3')
    const row = nodes(root).find((node) => node.props['data-cloud-row'])!
    const setData = vi.fn()
    ;(row.props.onDragstart as (event: unknown) => void)({
      dataTransfer: { setData, effectAllowed: '' }
    })
    expect(parseIcloudDragPayload(setData.mock.calls[0][1])).toEqual({
      version: 1,
      rootToken: 'new-root',
      paths: ['New.mp3']
    })
  })
  it('writes an actual root-bound, copy-only drag payload from selected cloud rows', async () => {
    const root = await mount()
    const row = nodes(root).find((node) => node.props['data-cloud-row'])!
    const setData = vi.fn()
    const transfer = { setData, effectAllowed: '' }
    ;(row.props.onDragstart as (event: unknown) => void)({ dataTransfer: transfer })
    expect(transfer.effectAllowed).toBe('copy')
    expect(setData).toHaveBeenCalledWith(ICLOUD_DRAG_MIME, expect.any(String))
    expect(parseIcloudDragPayload(setData.mock.calls[0][1])).toEqual({
      version: 1,
      rootToken: 'root-token',
      paths: ['Cloud.mp3']
    })
  })
  it('preserves song row identity and selection during an unchanged refresh, pruning removed songs', async () => {
    const root = await mount()
    const row = nodes(root).find((node) => node.props['data-cloud-row'])!
    const song = row.props['data-song-object']
    ;(row.props.onClick as (event: unknown) => void)({
      shiftKey: false,
      metaKey: false,
      ctrlKey: false
    })
    await flush()
    await click(root, 'icloud.refresh')
    expect(
      nodes(root).find((node) => node.props['data-cloud-row'])?.props['data-song-object']
    ).toBe(song)
    expect(icloudListPresentation.value?.selected).toHaveLength(1)
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'icloud:list'
        ? Promise.resolve({
            ok: true,
            value: { entries: [], total: 0, rootToken: 'root-token', directory: '' }
          })
        : original(channel, ...args)
    )
    await click(root, 'icloud.refresh')
    expect(icloudListPresentation.value?.selected).toHaveLength(0)
  })
  it('renders loading and unavailable Drive states without creating a directory', async () => {
    const original = mocks.invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    mocks.invoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'icloud:folders'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : original(channel, ...args)
    )
    const root = await mount(FolderTree)
    expect(text(root)).toContain('common.loading')
    finish({
      ok: true,
      value: { entries: [], directory: '', rootToken: 'root-token', missingRoot: true }
    })
    await flush()
    expect(text(root)).toContain('icloud.driveUnavailable')
    expect(text(root)).not.toContain('icloud.noSubfolders')
    expect(
      mocks.invoke.mock.calls.some(([channel]) => /copy|prepare-play|choose-folder/.test(channel))
    ).toBe(false)
  })
  it('copies a local song into the explicitly selected visible iCloud folder without another picker', async () => {
    await mount()
    selectIcloudDirectory('Album')
    await flush()
    openIcloudExport('local-source', ['/local/song.mp3'])
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith(
      'icloud:copy',
      expect.objectContaining({
        direction: 'to-cloud',
        localPlaylistUuid: 'local-source',
        paths: ['/local/song.mp3'],
        cloudDirectory: 'Album',
        rootToken: 'root-token'
      })
    )
    expect(
      mocks.invoke.mock.calls.some(([channel]) => channel === 'icloud:choose-destination')
    ).toBe(false)
  })
  it('asks for a destination when the Drive root is only being browsed, never silently writing it', async () => {
    await mount()
    expect(icloudDirectory.value).toBe('')
    expect(icloudDirectorySelected.value).toBe(false)
    openIcloudExport('local-source', ['/local/song.mp3'])
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('icloud:choose-destination', '')
    expect(mocks.invoke).toHaveBeenCalledWith(
      'icloud:copy',
      expect.objectContaining({
        cloudDirectory: 'Picked',
        destinationToken: 'chosen-token',
        rootToken: 'root-token'
      })
    )
    expect(
      mocks.invoke.mock.calls.some(([channel]) => channel === 'icloud:authorize-destination')
    ).toBe(false)
  })
  it('does not use an old folder selection that is no longer visible, and cancelling the picker does not copy', async () => {
    await mount()
    selectIcloudDirectory('Old Selection')
    icloudOpen.value = false
    icloudTransfer.error = 'permission'
    icloudTransfer.results = [{ source: 'old.mp3', status: 'copied' }]
    icloudTransfer.progress = { done: 1, total: 1, current: 'old.mp3' }
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'icloud:choose-destination'
        ? Promise.resolve({ ok: true, value: null })
        : original(channel, ...args)
    )
    openIcloudExport('local-source', ['/local/song.mp3'])
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('icloud:choose-destination', '')
    expect(icloudTransfer.error).toBe('')
    expect(icloudTransfer.results).toEqual([])
    expect(icloudTransfer.progress).toBe(null)
    expect(
      mocks.invoke.mock.calls.some(([channel]) =>
        /authorize-destination|^icloud:copy$/.test(channel)
      )
    ).toBe(false)
  })
  it('allows an explicitly clicked root as a destination only after obtaining its one-use authorization', async () => {
    await mount()
    selectIcloudDirectory('')
    openIcloudExport('local-source', ['/local/song.mp3'])
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('icloud:authorize-destination', '', 'root-token')
    expect(mocks.invoke).toHaveBeenCalledWith(
      'icloud:copy',
      expect.objectContaining({ cloudDirectory: '', destinationToken: 'explicit-token' })
    )
    expect(
      mocks.invoke.mock.calls.some(([channel]) => channel === 'icloud:choose-destination')
    ).toBe(false)
  })
  it('changes folders without accepting a late response from the previous directory', async () => {
    const original = mocks.invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    mocks.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'icloud:list' && args[0] === '')
        return new Promise((resolve) => {
          finish = resolve
        })
      if (channel === 'icloud:list')
        return Promise.resolve({
          ok: true,
          value: {
            entries: [
              {
                name: 'Nested.mp3',
                relativePath: 'Album/Nested.mp3',
                directory: false,
                residency: 'local'
              }
            ],
            total: 1,
            directory: 'Album',
            rootToken: 'root-token'
          }
        })
      return original(channel, ...args)
    })
    const root = await mount()
    icloudDirectory.value = 'Album'
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('icloud:list', 'Album', null, '', 'root-token')
    expect(text(root)).toContain('Nested')
    finish({
      ok: true,
      value: {
        entries: [
          { name: 'Old.mp3', relativePath: 'Old.mp3', directory: false, residency: 'local' }
        ],
        total: 1,
        directory: '',
        rootToken: 'root-token'
      }
    })
    await flush()
    expect(text(root)).not.toContain('Old')
    const row = nodes(root).find((node) => node.props['data-cloud-row'])!
    const setData = vi.fn()
    ;(row.props.onDragstart as (event: unknown) => void)({
      dataTransfer: { setData, effectAllowed: '' }
    })
    expect(parseIcloudDragPayload(setData.mock.calls[0][1])?.paths).toEqual(['Album/Nested.mp3'])
    expect(icloudSongDragging.value).toBe(true)
  })
  it('renders actual empty/document-only folder nodes and loads nested children only on expansion', async () => {
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'icloud:state') {
        const state = (await original(channel, ...args)) as {
          ok: true
          value: Record<string, unknown>
        }
        return {
          ok: true,
          value: { ...state.value, folder: 'Old Custom', preferredDirectory: 'Old Custom' }
        }
      }
      if (channel !== 'icloud:folders') return original(channel, ...args)
      const directory = args[0] as string
      if (directory === 'Remote') return { ok: false, error: 'download' }
      const names =
        directory === ''
          ? ['Empty', 'Documents', 'FRKB Music', 'Album', 'Remote']
          : directory === 'Album'
            ? ['Album/Nested']
            : []
      return {
        ok: true,
        value: {
          directory,
          rootToken: 'root-token',
          missingRoot: false,
          entries: names.map((relativePath) => ({
            name: relativePath.split('/').pop(),
            relativePath,
            directory: true,
            residency: relativePath === 'Remote' ? 'cloud' : 'local'
          }))
        }
      }
    })
    const root = await mount(FolderTree)
    expect(text(root)).not.toContain('icloud.driveProjectionHint')
    expect(text(root)).toContain('iCloud Drive')
    expect(text(root)).not.toContain('Old Custom')
    expect(text(root)).toContain('FRKB Music')
    expect(text(root)).toContain('Empty')
    expect(text(root)).toContain('Documents')
    expect(text(root)).not.toContain('Nested')
    expect(mocks.invoke.mock.calls.filter(([channel]) => channel === 'icloud:folders')).toEqual([
      ['icloud:folders', '', 'root-token']
    ])
    const item = (relative: string) =>
      nodes(root).find((node) => node.props['data-cloud-folder'] === relative)!
    const row = nodes(item('Documents')).find((node) =>
      String(node.props.class).includes('cloud-folder-row')
    )!
    ;(row.props.onClick as (event: unknown) => void)({ stopPropagation: vi.fn() })
    await flush()
    expect(icloudDirectory.value).toBe('Documents')
    const rootRow = nodes(item('')).find((node) =>
      String(node.props.class).includes('cloud-folder-row')
    )!
    ;(rootRow.props.onClick as (event: unknown) => void)({ stopPropagation: vi.fn() })
    await flush()
    expect(icloudDirectory.value).toBe('')
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'icloud:folders')
    ).toHaveLength(1)
    const expand = async (relative: string) => {
      const button = nodes(item(relative)).find((node) => node.type === 'button')!
      ;(button.props.onClick as (event: unknown) => void)({ stopPropagation: vi.fn() })
      await flush()
    }
    await expand('Album')
    expect(text(root)).toContain('Nested')
    await expand('Empty')
    expect(text(item('Empty'))).not.toContain('icloud.noSubfolders')
    expect(item('Empty').props['aria-busy']).toBe(false)
    await expand('Remote')
    expect(text(item('Remote'))).toContain('icloud.folderNotLocal')
    expect(text(item('Remote'))).not.toContain('icloud.noSubfolders')
    expect(text(item('Remote'))).toContain('icloud.retry')
    await click(item('Remote'), 'icloud.retry')
    expect(
      mocks.invoke.mock.calls.filter(
        ([channel, relative]) => channel === 'icloud:folders' && relative === 'Remote'
      )
    ).toHaveLength(2)
    expect(mocks.invoke.mock.calls.some(([channel]) => /prepare-play|copy/.test(channel))).toBe(
      false
    )
  })
  it('renders initial leaves without expand controls while keeping selection, songs and unknown recovery available', async () => {
    const original = mocks.invoke.getMockImplementation()!
    let leaf = true
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel !== 'icloud:folders') return original(channel, ...args)
      const directory = args[0] as string
      return {
        ok: true,
        value: {
          directory,
          rootToken: 'root-token',
          missingRoot: false,
          entries: directory
            ? []
            : [
                {
                  name: 'Leaf',
                  relativePath: 'Leaf',
                  directory: true,
                  residency: 'local',
                  hasChildren: !leaf
                },
                {
                  name: 'Parent',
                  relativePath: 'Parent',
                  directory: true,
                  residency: 'local',
                  hasChildren: true
                },
                {
                  name: 'Unknown',
                  relativePath: 'Unknown',
                  directory: true,
                  residency: 'unknown',
                  hasChildren: 'unknown'
                }
              ]
        }
      }
    })
    const root = await mount(FolderTree)
    const item = (relative: string) =>
      nodes(root).find((node) => node.props['data-cloud-folder'] === relative)!
    const row = (relative: string) =>
      nodes(item(relative)).find((node) => String(node.props.class).includes('cloud-folder-row'))!
    const expander = (relative: string) =>
      nodes(item(relative)).find(
        (node) => node.type === 'button' && String(node.props.class).includes('expander')
      )
    expect(expander('Leaf')).toBeUndefined()
    expect(item('Leaf').props['aria-expanded']).toBeUndefined()
    expect(expander('Parent')).toBeDefined()
    expect(expander('Unknown')).toBeDefined()
    ;(row('Leaf').props.onClick as (event: unknown) => void)({ stopPropagation: vi.fn() })
    await flush()
    expect(icloudDirectory.value).toBe('Leaf')
    expect(item('Leaf').props['aria-selected']).toBe(true)
    ;(row('Leaf').props.onKeydown as (event: unknown) => void)({
      key: 'ArrowRight',
      stopPropagation: vi.fn(),
      preventDefault: vi.fn()
    })
    await flush()
    expect(
      mocks.invoke.mock.calls.filter(([name, dir]) => name === 'icloud:folders' && dir === 'Leaf')
    ).toHaveLength(0)
    leaf = false
    mocks.menu.mockResolvedValue({ menuName: 'icloud.refresh' })
    await (row('').props.onContextmenu as (event: unknown) => Promise<void>)({
      stopPropagation: vi.fn(),
      preventDefault: vi.fn()
    })
    await flush()
    expect(expander('Leaf')).toBeDefined()
    expect(item('Leaf').props['aria-selected']).toBe(true)
    leaf = true
    await (row('').props.onContextmenu as (event: unknown) => Promise<void>)({
      stopPropagation: vi.fn(),
      preventDefault: vi.fn()
    })
    await flush()
    expect(expander('Leaf')).toBeUndefined()
    expect(icloudDirectory.value).toBe('Leaf')
    expect(text(root)).not.toContain('icloud.noSubfolders')
  })
  it('uses the right-clicked folder for real Finder and refresh actions without selecting, copying or playing it', async () => {
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) =>
      channel === 'icloud:folders'
        ? {
            ok: true,
            value: {
              directory: args[0],
              rootToken: 'root-token',
              missingRoot: false,
              entries: args[0]
                ? []
                : [
                    {
                      name: 'Leaf',
                      relativePath: 'Leaf',
                      directory: true,
                      residency: 'local',
                      hasChildren: false
                    }
                  ]
            }
          }
        : original(channel, ...args)
    )
    const root = await mount(FolderTree)
    const item = (relative: string) =>
      nodes(root).find((node) => node.props['data-cloud-folder'] === relative)!
    const row = (relative: string) =>
      nodes(item(relative)).find((node) => String(node.props.class).includes('cloud-folder-row'))!
    selectIcloudDirectory('')
    mocks.menu.mockResolvedValue({ menuName: 'tracks.showInFileExplorer' })
    await (row('Leaf').props.onContextmenu as (event: unknown) => Promise<void>)({
      stopPropagation: vi.fn(),
      preventDefault: vi.fn()
    })
    await flush()
    expect(mocks.menu).toHaveBeenCalledWith(
      expect.objectContaining({
        menuArr: [[{ menuName: 'tracks.showInFileExplorer' }], [{ menuName: 'icloud.refresh' }]]
      })
    )
    expect(mocks.invoke).toHaveBeenCalledWith('icloud:reveal', 'Leaf', 'root-token')
    expect(icloudDirectory.value).toBe('')
    mocks.menu.mockResolvedValue({ menuName: 'icloud.refresh' })
    await (row('Leaf').props.onContextmenu as (event: unknown) => Promise<void>)({
      stopPropagation: vi.fn(),
      preventDefault: vi.fn()
    })
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('icloud:folders', 'Leaf', 'root-token')
    expect(mocks.invoke.mock.calls.some(([channel]) => /copy|prepare-play/.test(channel))).toBe(
      false
    )
    let resolve!: (value: unknown) => void
    mocks.menu.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const pending = (row('Leaf').props.onContextmenu as (event: unknown) => Promise<void>)({
      stopPropagation: vi.fn(),
      preventDefault: vi.fn()
    })
    mocks.invoke.mockClear()
    icloudState.value = { ...icloudState.value!, rootToken: 'changed-root' }
    resolve({ menuName: 'tracks.showInFileExplorer' })
    await pending
    expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'icloud:reveal')).toBe(false)
  })
  it('keeps root and unavailable-folder context actions recoverable when Finder reveal fails', async () => {
    const root = await mount(FolderTree)
    const rootItem = nodes(root).find((node) => node.props['data-cloud-folder'] === '')!
    const row = nodes(rootItem).find((node) =>
      String(node.props.class).includes('cloud-folder-row')
    )!
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) =>
      channel === 'icloud:reveal' ? { ok: false, error: 'unavailable' } : original(channel, ...args)
    )
    mocks.menu.mockResolvedValue({ menuName: 'tracks.showInFileExplorer' })
    await (row.props.onContextmenu as (event: unknown) => Promise<void>)({
      stopPropagation: vi.fn(),
      preventDefault: vi.fn()
    })
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('icloud:reveal', '', 'root-token')
    expect(text(root)).toContain('icloud.errors.unavailable')
    const retry = nodes(root).find(
      (node) =>
        node.type === 'button' &&
        node.props.onClick &&
        String(node.props.text).includes('icloud.refresh')
    )
    expect(retry).toBeDefined()
    expect(mocks.invoke.mock.calls.some(([channel]) => /copy|prepare-play/.test(channel))).toBe(
      false
    )
  })
  it('provides a discoverable settings switch that restores a hidden icon and persists it', async () => {
    mocks.setting.showIcloudLibraryIcon = false
    const root = await mount(IcloudSettings)
    expect(text(root)).toContain('icloud.title')
    expect(text(root)).not.toContain('icloud.showIconHint')
    const control = nodes(root).find((node) => node.props['data-show-icon'])!
    await (control.props.onClick as () => unknown)()
    await flush()
    expect(mocks.setting.showIcloudLibraryIcon).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith(
      'setSetting',
      expect.objectContaining({ showIcloudLibraryIcon: true })
    )
    expect(mocks.invoke.mock.calls.some(([name]) => String(name).startsWith('icloud:'))).toBe(false)
  })
  it('keeps the saved visibility unchanged and shows an actionable error if preference persistence fails', async () => {
    mocks.setting.showIcloudLibraryIcon = false
    mocks.invoke.mockRejectedValue(new Error('persistence failed'))
    const root = await mount(IcloudSettings)
    const control = nodes(root).find((node) => node.props['data-show-icon'])!
    await (control.props.onClick as () => unknown)()
    await flush()
    expect(mocks.setting.showIcloudLibraryIcon).toBe(false)
    expect(text(root)).toContain('icloud.preferenceFailed')
  })
})
describe('iCloud branded rail icon', () => {
  it('produces valid CSS from the actual Vite-inlined SVG containing transform parentheses', async () => {
    icloudOpen.value = false
    const root = await mount(Entry)
    const icon = nodes(root).find((node) => String(node.props.class).includes('sidebar-icon'))!
    const mask = (icon.props.style as Record<string, string>)['--icon-mask']
    expect(icloudIcon).toMatch(/^data:image\/svg\+xml,/)
    expect(icloudIcon).toContain('translate(')
    await assertIcloudMaskCss(mask, icloudIcon)
  })
  it('renders the standalone branded asset as an accessible, theme-colored mask without scanning', async () => {
    icloudOpen.value = false
    const root = await mount(Entry)
    const icon = nodes(root).find((node) => String(node.props.class).includes('sidebar-icon'))!
    const button = nodes(root).find((node) => node.type === 'button')!
    expect(icon.props.style).toEqual({ '--icon-mask': `url(${JSON.stringify(icloudIcon)})` })
    expect(icon.props['aria-hidden']).toBe('true')
    expect(nodes(root).some((node) => node.type === 'svg')).toBe(false)
    expect(button.props['aria-label']).toBe('icloud.title')
    expect(button.props['aria-pressed']).toBe(false)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('keeps the mask and switches active styling with the actual panel state', async () => {
    icloudOpen.value = false
    const root = await mount(Entry)
    const button = nodes(root).find((node) => node.type === 'button')!
    const icon = nodes(root).find((node) => String(node.props.class).includes('sidebar-icon'))!
    await (button.props.onClick as () => void)()
    await flush()
    expect(button.props['aria-pressed']).toBe(true)
    expect(icon.props.class).toContain('is-active')
    expect(
      nodes(root).find((node) => String(node.props.class).includes('icloud-entry'))!.props.class
    ).toContain('is-active')
    icloudOpen.value = false
    await flush()
    expect(button.props['aria-pressed']).toBe(false)
    expect(icon.props.class).not.toContain('is-active')
    expect(icon.props.style).toEqual({ '--icon-mask': `url(${JSON.stringify(icloudIcon)})` })
  })
})
