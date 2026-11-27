// @vitest-environment ./tests/vueClientEnvironment.ts
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { h, defineComponent, ref } from 'vue'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { renderer, HostNode, nodes, text, flush } from '../../../../../../tests/vueHost'
import { coverWave, coverPng } from '../../../../../../tests/icloudCoverFixture'
import { readIcloudMetadata } from '../../../../../main/services/icloudLibrary/readMetadata'
import { createIcloudCovers } from '@renderer/utils/icloudCovers'
import type { ISongInfo } from 'src/types/globals'
import Chrome from './SongListPaneChrome.vue'
import Stats from '../BottomInfoAreaTotalRow.vue'
import { icloudOpen } from '@renderer/utils/icloudLibrary'
import { icloudListPresentation } from '@renderer/utils/icloudListPresentation'
import CoverImage from './SongListRows/CoverThumbnailImage.vue'
const fixture = vi.hoisted(() => ({
  runtime: {
    songsArea: {
      songListUUID: 'local',
      songInfoArr: [{ filePath: 'local.wav', duration: '0:04' }],
      selectedSongFilePath: ['local.wav']
    },
    songsAreaPanels: { splitEnabled: false },
    analysisRuntime: { available: false },
    manualKeyAnalysisPendingFilePaths: []
  }
}))
vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => fixture.runtime }))
vi.mock('@renderer/utils/libraryUtils', () => ({ default: { getLibraryTreeByUUID: () => null } }))
vi.mock('@renderer/utils/manualKeyAnalysis', () => ({
  collectMissingAnalysisFilesFromSongs: () => []
}))
vi.mock('@renderer/i18n', () => ({ i18n: { global: { locale: { value: 'en-US' } } } }))
vi.mock('@renderer/utils/translate', () => ({
  t: (key: string, args?: unknown) => key + (args ? JSON.stringify(args) : '')
}))
vi.mock('@renderer/components/bubbleBoxTrigger.vue', () => ({
  default: defineComponent({
    props: { tag: { type: String, default: 'span' }, title: String },
    setup:
      (p, { attrs, slots }) =>
      () =>
        h(p.tag, attrs, slots.default?.())
  })
}))
beforeEach(() => {
  vi.stubGlobal('Document', class Document {})
  vi.stubGlobal('ShadowRoot', class ShadowRoot {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('uses the actual shared chrome for both title/search/clear, keeping Close only for ordinary panes', async () => {
  for (const closable of [true, false]) {
    const root = new HostNode('root'),
      query = ref('Artist'),
      close = vi.fn()
    const app = renderer.createApp({
      render: () =>
        h(Chrome, {
          title: 'Folder',
          query: query.value,
          'onUpdate:query': (v) => {
            query.value = v
          },
          closable,
          onClose: close
        })
    })
    app.mount(root)
    expect(text(root)).toContain('Folder')
    expect(nodes(root).find((n) => n.type === 'input')?.props['aria-label']).toBe(
      'tracks.playlistSearchPlaceholder'
    )
    const buttons = nodes(root).filter((n) => n.type === 'button')
    expect(buttons.some((n) => n.props['aria-label'] === 'common.close')).toBe(closable)
    ;(
      buttons.find((n) => n.props['aria-label'] === 'tracks.clearPlaylistSearch')!.props
        .onClick as Function
    )({ stopPropagation: vi.fn() })
    await flush()
    expect(query.value).toBe('')
    app.unmount()
  }
})
it('renders a thumbnail from a real resident embedded PNG through the shared ordinary CoverThumbnailImage', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-cover-ui-')))
  await fs.writeFile(path.join(root, 'cover.wav'), coverWave())
  const node = new HostNode('root')
  const blob = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:real-embedded-cover')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const covers = createIcloudCovers({
    resolve: (p) => (p === 'cover.wav' ? { relative: p, token: 'root' } : null),
    read: async (relative) =>
      (await readIcloudMetadata(root, relative, async () => 'local', undefined, true)).picture ||
      null,
    cancel: vi.fn(),
    resize: async (data, format) => {
      expect(Buffer.from(data)).toEqual(coverPng)
      return { data, format }
    }
  })
  const app = renderer.createApp({
    render: () => h(CoverImage, { filePath: 'cover.wav', getCoverUrl: covers.getCoverUrl })
  })
  app.mount(node)
  try {
    expect(nodes(node).some((n) => n.type === 'img')).toBe(false)
    covers.setVisibleSongs([{ filePath: 'cover.wav' } as ISongInfo])
    await covers.fetchCoverUrl('cover.wav')
    await flush()
    expect(nodes(node).find((n) => n.type === 'img')?.props.src).toBe('blob:real-embedded-cover')
    expect(blob).toHaveBeenCalledTimes(1)
    covers.clear()
    await flush()
    expect(nodes(node).some((n) => n.type === 'img')).toBe(false)
    expect(revoke).toHaveBeenCalledWith('blob:real-embedded-cover')
  } finally {
    app.unmount()
    covers.clear()
    await fs.rm(root, { recursive: true, force: true })
  }
})
it('both real pages use common scroll, empty/loading, header, row and column-menu presentation instead of parallel CSS', async () => {
  const base = 'src/renderer/src/pages/modules/',
    normal = await fs.readFile(base + 'songsArea/songsArea.vue', 'utf8'),
    cloud = await fs.readFile(base + 'IcloudLibraryPanel.vue', 'utf8'),
    header = await fs.readFile(base + 'songsArea/SongsAreaPaneHeader.vue', 'utf8')
  for (const component of [
    'SongListViewport',
    'SongListState',
    'SongListHeader',
    'SongListRows',
    'ColumnHeaderContextMenu'
  ]) {
    expect(normal).toContain('<' + component)
    expect(cloud).toContain('<' + component)
  }
  expect(header).toContain('<SongListPaneChrome')
  expect(cloud).toContain('<SongListPaneChrome')
  expect(cloud).toContain(':closable="false"')
  expect(cloud).toContain(':cover-provider="covers"')
  expect(cloud).toContain(':enable-cover-thumbnails="false"')
  expect(cloud).toContain('useParentRafSampler')
  expect(cloud).toContain(':external-scroll-top="externalScrollTop"')
  expect(cloud).toContain(':external-viewport-height="externalViewportHeight"')
  expect(cloud).not.toContain('icloud-header')
  expect(cloud).not.toContain('icloud-scroll')
  const preload = await fs.readFile('src/preload/index.ts', 'utf8')
  expect(preload).toContain("'icloud:cover'")
  expect(preload).toContain("'icloud:waveform-preview'")
  expect(cloud).toContain(':allow-waveform-preview-when-read-only="true"')
})

it('shares ordinary footer with cloud-known durations and selection without modifying local library state', async () => {
  const root = new HostNode('root'),
    before = JSON.stringify(fixture.runtime)
  icloudOpen.value = true
  icloudListPresentation.value = {
    songs: [
      { filePath: 'a', duration: '0:02' },
      { filePath: 'b', duration: '' }
    ] as ISongInfo[],
    selected: ['b'],
    total: 220,
    page: true
  }
  const app = renderer.createApp(Stats)
  app.mount(root)
  expect(text(root)).toContain('bottomInfo.totalDurationLabel')
  expect(text(root)).toContain('bottomInfo.knownDurationOnly')
  expect(text(root)).toContain('"duration":"—"')
  expect(text(root)).not.toContain('icloud.pageDuration')
  expect(text(root)).not.toContain('icloud.knownOnly')
  expect(text(root)).not.toContain('icloud.trackCount')
  expect(text(root)).not.toContain('"count":220')
  expect(text(root)).not.toContain('bottomInfo.pendingAnalysis')
  icloudOpen.value = false
  await flush()
  expect(text(root)).toContain('bottomInfo.totalDurationLabel')
  expect(text(root)).not.toContain('icloud.knownOnly')
  expect(text(root)).not.toContain('bottomInfo.knownDurationOnly')
  expect(JSON.stringify(fixture.runtime)).toBe(before)
  app.unmount()
  icloudListPresentation.value = null
})
