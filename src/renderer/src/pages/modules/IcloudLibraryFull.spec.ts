// @vitest-environment ./tests/vueClientEnvironment.ts
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { defineComponent, h, reactive, type Component } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { HostNode, renderer, nodes, text, flush, teleportBody } from '../../../../../tests/vueHost'
import { icloudState, icloudOpen, icloudDirectory } from '@renderer/utils/icloudLibrary'
import { clearIcloudViews } from '@renderer/utils/icloudViewState'
import { icloudListPresentation } from '@renderer/utils/icloudListPresentation'
import { usePlaylistViewSettingsStore } from '@renderer/stores/playlistViewSettings'
import PlayerControls from '@renderer/components/playerControls.vue'
import PlayerSurface from './songPlayer/PlayerSurface.vue'
import { useCover } from './songPlayer/useCover'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { ISongInfo } from 'src/types/globals'
import Panel from './IcloudLibraryPanel.vue'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), runtime: {}, viewport: null as unknown }))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => mocks.runtime }))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/components/bubbleBox.vue', () => ({ default: { render: () => null } }))
vi.mock('@renderer/components/rightClickMenu', () => ({ default: vi.fn(async () => 'cancel') }))
vi.mock('./songsArea/SongListRows/coverDisplayWorkerClient', () => ({
  createCoverDisplayWorkerClient: () => ({
    resize: async (data: Uint8Array, format: string) => ({ data, format }),
    dispose: vi.fn()
  })
}))
vi.mock('vue-draggable-plus', () => ({ vDraggable: {} })) // Only native DOM drag adapter, not list/header behavior.
vi.mock('overlayscrollbars-vue', () => ({
  OverlayScrollbarsComponent: defineComponent({
    setup(_, ctx) {
      ctx.expose({ osInstance: () => ({ elements: () => ({ viewport: mocks.viewport }) }) })
      return () => h('div', ctx.slots.default?.())
    }
  })
}))
vi.mock('@renderer/components/bubbleBoxTrigger.vue', () => ({
  default: defineComponent({
    props: { tag: { type: String, default: 'span' } },
    setup:
      (props, { attrs, slots }) =>
      () =>
        h(props.tag, attrs, slots.default?.())
  })
}))
let dispose = () => {}
beforeEach(() => {
  setActivePinia(createPinia())
  clearIcloudViews()
  vi.clearAllMocks()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  })
  mocks.runtime = reactive({
    setting: { keyDisplayStyle: 'Classic', persistSongFilters: false, theme: 'dark' },
    analysisRuntime: { available: false },
    songDragSuppressClickUntilMs: 0,
    hotkeysScopesHeap: ['windowGlobal'],
    libraryTree: { uuid: 'local' },
    songsArea: { songListUUID: 'local' },
    libraryAreaSelected: 'FilterLibrary',
    mainWindowBrowseMode: 'browser',
    playingData: { playingSong: null, playingSongListData: [], playingSongListUUID: '' },
    curatedArtistFavorites: []
  })
  vi.stubGlobal('self', { location: 'http://localhost/' })
  vi.stubGlobal(
    'Worker',
    class {
      addEventListener = vi.fn()
      removeEventListener = vi.fn()
      postMessage = vi.fn()
      terminate = vi.fn()
    }
  )
  vi.stubGlobal('HTMLInputElement', class {})
  vi.stubGlobal('HTMLElement', HostNode)
  vi.stubGlobal('Element', HostNode)
  vi.stubGlobal('Document', class {})
  vi.stubGlobal('ShadowRoot', class {})
  vi.stubGlobal('document', {
    body: new HostNode('body'),
    activeElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('window', {
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    setTimeout,
    clearTimeout,
    getComputedStyle: () => ({
      transitionDelay: '0s',
      transitionDuration: '0s',
      animationDelay: '0s',
      animationDuration: '0s'
    }),
    innerHeight: 900,
    innerWidth: 1280,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electron: { ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() } }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(callback, 0)
  )
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
    }
  )
  mocks.viewport = new HostNode('viewport')
  icloudDirectory.value = ''
  icloudOpen.value = true
  icloudState.value = null
  mocks.invoke.mockImplementation(async (channel: string) =>
    channel === 'icloud:state'
      ? {
          ok: true,
          value: {
            supported: true,
            visible: true,
            available: true,
            configured: true,
            folder: 'drive',
            rootToken: 'root'
          }
        }
      : channel === 'icloud:list'
        ? {
            ok: true,
            value: {
              rootToken: 'root',
              directory: '',
              total: 450,
              entries: Array.from({ length: 450 }, (_, index) => ({
                name: `Track ${index}.mp3`,
                relativePath: `Track ${index}.mp3`,
                directory: false,
                residency: 'cloud'
              }))
            }
          }
        : { ok: true, value: [] }
  )
  const store = usePlaylistViewSettingsStore()
  store.updateSharedColumns(
    'default',
    store
      .getSharedColumns('default', false)
      .map((col) => ({ ...col, show: ['index', 'title', 'artist', 'bpm'].includes(col.key) }))
  )
})
afterEach(() => {
  dispose()
  icloudState.value = null
  icloudOpen.value = false
  clearIcloudViews()
  vi.unstubAllGlobals()
})
const mount = async (component: Component = Panel) => {
  const root = new HostNode('root'),
    app = renderer.createApp(component)
  app.directive('dialog-drag', {})
  app.mount(root)
  dispose = () => app.unmount()
  await flush()
  return root
}
const event = (target: HostNode, more: Record<string, unknown> = {}) => ({
  target,
  stopPropagation: vi.fn(),
  preventDefault: vi.fn(),
  ...more
})
it('actual shared header/virtual rows expose all 450 entries, growing Shift ranges, Cmd-A, full filename search, statistics and no-result state', async () => {
  const root = await mount()
  expect(icloudListPresentation.value?.total).toBe(450)
  const rows = nodes(root).filter((node) => String(node.props.class).includes('song-row-item'))
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.length).toBeLessThan(450)
  const rowsRoot = nodes(root).find((node) => node.props.class === 'song-rows-root')!
  const click = rowsRoot.props.onClick as (event: unknown) => void
  click(event(rows[0]))
  await flush()
  expect(icloudListPresentation.value?.selected).toHaveLength(1)
  const section = nodes(root).find((node) => node.type === 'section')!,
    keydown = section.props.onKeydown as (event: unknown) => void
  keydown(event(section, { key: 'ArrowDown', shiftKey: true }))
  keydown(event(section, { key: 'ArrowDown', shiftKey: true }))
  await flush()
  expect(icloudListPresentation.value?.selected).toHaveLength(3)
  keydown(event(section, { key: 'a', metaKey: true }))
  await flush()
  expect(icloudListPresentation.value?.selected).toHaveLength(450)
  const sortTitle = () =>
    nodes(root).find(
      (node) => Boolean(node.props.onClick) && text(node).trim() === 'columns.title'
    )!
  const title = sortTitle()
  ;(title.props.onClick as (event: unknown) => void)(event(title))
  await flush()
  const titleAgain = sortTitle()
  ;(titleAgain.props.onClick as (event: unknown) => void)(event(titleAgain))
  await flush()
  expect(icloudListPresentation.value?.songs[0].fileName).toBe('Track 449.mp3')
  const end = event(section, { key: 'End' })
  keydown(end)
  await flush()
  expect(end.stopPropagation).toHaveBeenCalled()
  expect(icloudListPresentation.value?.selected).toEqual(['icloud-song:Track 0.mp3'])
  expect((mocks.viewport as HostNode).scrollTop).toBeGreaterThan(10000)
  keydown(event(section, { key: 'ArrowUp', shiftKey: true }))
  await flush()
  expect(icloudListPresentation.value?.selected).toHaveLength(2)

  const input = nodes(root).find((node) => node.type === 'input' && node.props.type === 'text')!
  input.value = 'Track 449'
  input.dispatch('input')
  await flush()
  expect(icloudListPresentation.value?.songs).toHaveLength(1)
  expect(text(root)).toContain('Track 449')
  input.value = 'not a track'
  input.dispatch('input')
  await flush()
  expect(text(root)).toContain('filters.noResults')
  expect(icloudListPresentation.value?.songs).toHaveLength(0)
  expect(
    mocks.invoke.mock.calls.some(([channel]) =>
      ['icloud:metadata', 'icloud:cover', 'icloud:prepare-play'].includes(channel)
    )
  ).toBe(false)
})

it('restores directory query/selection and highlights cloud playback by logical origin after pane remount', async () => {
  let root = await mount()
  const section = nodes(root).find((node) => node.type === 'section')!
  ;(section.props.onKeydown as (event: unknown) => void)(
    event(section, { key: 'a', metaKey: true })
  )
  await flush()
  dispose()
  root = await mount()
  expect(icloudListPresentation.value?.selected).toHaveLength(450)
  const input = nodes(root).find((node) => node.type === 'input' && node.props.type === 'text')!
  input.value = 'Track 449'
  input.dispatch('input')
  await flush()
  dispose()
  root = await mount()
  expect(icloudListPresentation.value?.songs).toHaveLength(1)
  expect(
    nodes(root).find((node) => node.type === 'input' && node.props.type === 'text')?.value
  ).toBe('Track 449')
  const runtime = mocks.runtime as ReturnType<typeof useRuntimeStore>
  runtime.playingData.playingSong = {
    filePath: 'frkb-preview://icloud/song?ticket=fixture&path=Track449.mp3',
    icloudOrigin: {
      relativePath: 'Track 449.mp3',
      rootToken: 'root',
      key: 'icloud-song:Track 449.mp3'
    }
  } as ISongInfo
  await flush()
  expect(
    nodes(root).some((node) => String(node.props.class).split(' ').includes('playingSong'))
  ).toBe(true)
})

it('mounts real main transport for a cloud song without analysis, and routes its cover only through the safe cloud provider', async () => {
  const runtime = mocks.runtime as ReturnType<typeof useRuntimeStore>,
    play = vi.fn()
  const cloud = {
    filePath: 'frkb-preview://icloud/song?ticket=fixture&path=resident.wav',
    title: 'Cloud',
    fileName: 'resident.wav',
    icloudOrigin: {
      relativePath: 'resident.wav',
      rootToken: 'root',
      key: 'icloud-song:resident.wav'
    }
  } as ISongInfo
  runtime.playingData.playingSong = cloud
  runtime.playingData.playingSongListData = [cloud]
  runtime.playingData.playingSongListUUID = 'icloud-music'
  let cover!: ReturnType<typeof useCover>
  const root = await mount(
    defineComponent({
      setup() {
        cover = useCover(runtime)
        return () => h(PlayerSurface, { visible: true }, () => h(PlayerControls, { onPlay: play }))
      }
    })
  )
  expect(root.children[0].style.display).not.toBe('none')
  const buttons = nodes(root).filter((node) =>
    String(node.props.class || '')
      .split(' ')
      .includes('buttonIcon')
  )
  expect(buttons).toHaveLength(7) // Six transport controls plus mini-player; no unsafe local More menu.
  const playControl = buttons[2]
  expect(playControl.style.display).not.toBe('none')
  ;(playControl.props.onClick as () => void)()
  expect(play).toHaveBeenCalledTimes(1)
  const invoke = mocks.invoke
  invoke.mockResolvedValue({
    ok: true,
    value: { format: 'image/png', data: btoa('cover-route-fixture'), hash: 'picture-1' }
  })
  await cover.setCoverByIPC(cloud.filePath)
  expect(cover.coverBlobUrl.value).toMatch(/^blob:/)
  expect(invoke).toHaveBeenCalledWith('icloud:cover', ['resident.wav'], 'root', expect.any(String))
  expect(invoke.mock.calls.some(([channel]) => channel === 'getSongCoverThumb')).toBe(false)
  // A late cloud response cannot clear or overwrite a newly selected local cover.
  let finish!: (value: unknown) => void
  invoke.mockImplementation(async (channel: string) =>
    channel === 'icloud:cover'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : channel === 'getSongCoverThumb'
        ? { data: [1, 2, 3], format: 'image/jpeg' }
        : { ok: true, value: true }
  )
  cover.disposeCoverUrl()
  const pending = cover.setCoverByIPC(cloud.filePath)
  const local = { ...cloud, filePath: '/temporary-only.wav', icloudOrigin: undefined }
  runtime.playingData.playingSong = local
  runtime.playingData.playingSongListUUID = ''
  await cover.setCoverByIPC(local.filePath)
  const localUrl = cover.coverBlobUrl.value
  expect(localUrl).toMatch(/^blob:/)
  finish({ ok: true, value: { format: 'image/png', data: btoa('late'), hash: 'late' } })
  await pending
  expect(cover.coverBlobUrl.value).toBe(localUrl)
})

it('reads real visible resident rows only, shares actual metadata search and header filter dialogs, leaves unknown offscreen rows unread', async () => {
  const original = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const response = await original(channel, ...args)
    if (channel === 'icloud:list')
      return {
        ...response,
        value: {
          ...response.value,
          entries: response.value.entries.map((entry: Record<string, unknown>) => ({
            ...entry,
            residency: 'local'
          }))
        }
      }
    if (channel === 'icloud:metadata')
      return {
        ok: true,
        value: (args[0] as string[]).map((relativePath) => ({
          relativePath,
          metadata: {
            artist: 'Known artist',
            album: 'Known album',
            duration: '2:34',
            bpm: 128,
            key: 'Am'
          }
        }))
      }
    return response
  })
  const root = await mount(),
    reads = mocks.invoke.mock.calls
      .filter(([channel]) => channel === 'icloud:metadata')
      .flatMap(([, paths]) => paths as string[])
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.length).toBeLessThan(450)
  expect(text(root)).toContain('Known artist')
  const input = nodes(root).find((node) => node.type === 'input' && node.props.type === 'text')!
  input.value = 'Known artist'
  input.dispatch('input')
  await flush()
  expect(icloudListPresentation.value?.songs.length).toBe(reads.length)
  expect(icloudListPresentation.value?.total).toBe(450)
  input.value = ''
  input.dispatch('input')
  await flush()
  const bpm = nodes(root).find(
      (node) =>
        String(node.props.class).includes('header-column') && text(node).includes('columns.bpm')
    )!,
    filter = nodes(bpm).find((node) => String(node.props.class).includes('filter-icon'))!
  ;(filter.props.onClick as (event: unknown) => void)(event(filter))
  await flush()
  expect(nodes(teleportBody).some((node) => node.type === 'input')).toBe(true)
  const number = nodes(teleportBody).find(
    (node) => node.type === 'input' && node.props.type === 'text'
  )!
  number.value = '129'
  number.dispatch('input')
  const confirm = nodes(teleportBody).find(
    (node) => node.props.class === 'button' && text(node).includes('common.confirm')
  )!
  ;(confirm.props.onClick as () => void)()
  await vi.waitFor(() => expect(icloudListPresentation.value?.songs).toHaveLength(0), {
    timeout: 1500
  })
  expect(text(root)).toContain('filters.noResults')

  expect(mocks.invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-play')).toBe(false)
})
