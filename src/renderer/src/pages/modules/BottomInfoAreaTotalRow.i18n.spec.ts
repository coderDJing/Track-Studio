// @vitest-environment ./tests/vueClientEnvironment.ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { HostNode, renderer, text, flush } from '../../../../../tests/vueHost'
import { i18n, setLocale } from '@renderer/i18n'
import type { ISongInfo } from 'src/types/globals'
import Stats from './BottomInfoAreaTotalRow.vue'
import { icloudOpen } from '@renderer/utils/icloudLibrary'
import { icloudListPresentation } from '@renderer/utils/icloudListPresentation'

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
vi.mock('@renderer/components/bubbleBoxTrigger.vue', () => ({
  default: defineComponent({
    props: { tag: { type: String, default: 'span' }, title: String },
    setup:
      (p, { attrs, slots }) =>
      () =>
        h(p.tag, attrs, slots.default?.())
  })
}))

const leaked = ['icloud.trackCount', 'icloud.knownOnly', 'icloud.pageDuration', 'icloud.search']

const mountFooter = async () => {
  const root = new HostNode('root')
  const app = renderer.createApp(Stats)
  app.use(i18n)
  app.mount(root)
  await flush()
  return {
    root,
    text: () => text(root),
    unmount: () => app.unmount()
  }
}

beforeEach(() => {
  vi.stubGlobal('Document', class Document {})
  vi.stubGlobal('ShadowRoot', class ShadowRoot {})
  setLocale('zh-CN')
  icloudOpen.value = false
  icloudListPresentation.value = null
})
afterEach(() => {
  icloudOpen.value = false
  icloudListPresentation.value = null
  setLocale('zh-CN')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('renders zh/en cloud footer with real i18n, ordinary duration format, and no leaked keys', async () => {
  icloudOpen.value = true
  icloudListPresentation.value = {
    songs: [
      { filePath: 'a', duration: '118:26' },
      { filePath: 'b', duration: '6:55' },
      { filePath: 'c', duration: '' }
    ] as ISongInfo[],
    selected: ['b'],
    total: 3,
    page: true
  }
  const view = await mountFooter()
  try {
    const zh = view.text()
    expect(zh).toContain('已选 1 首 · 6分钟55秒')
    expect(zh).toContain('总时长：2小时5分钟21秒 (部分歌曲时长未知)')
    expect(zh).not.toContain('0小时')
    expect(zh).not.toContain('220')
    for (const key of leaked) expect(zh).not.toContain(key)
    setLocale('en-US')
    await flush()
    const en = view.text()
    expect(en).toContain('1 selected · 6 minutes 55 seconds')
    expect(en).toContain(
      'Total duration: 2 hours 5 minutes 21 seconds (some track durations unknown)'
    )
    expect(en).not.toContain('0 hours')
    expect(en).not.toMatch(/\{count\}/)
    for (const key of leaked) expect(en).not.toContain(key)
  } finally {
    view.unmount()
  }
})

it('uses the same compact duration format for ordinary lists and does not invent technical copy', async () => {
  const view = await mountFooter()
  try {
    const zh = view.text()
    expect(zh).toContain('已选 1 首 · 4秒')
    expect(zh).toContain('总时长：4秒')
    expect(zh).not.toContain('0小时')
    expect(zh).not.toContain('部分歌曲时长未知')
    for (const key of leaked) expect(zh).not.toContain(key)
    setLocale('en-US')
    await flush()
    const en = view.text()
    expect(en).toContain('1 selected · 4 seconds')
    expect(en).toContain('Total duration: 4 seconds')
    expect(en).not.toContain('0 hours')
    expect(en).not.toContain('some track durations unknown')
    for (const key of leaked) expect(en).not.toContain(key)
  } finally {
    view.unmount()
  }
})

it('hides the unknown-duration note when every track duration is known', async () => {
  icloudOpen.value = true
  icloudListPresentation.value = {
    songs: [
      { filePath: 'a', duration: '1:00' },
      { filePath: 'b', duration: '2:00' }
    ] as ISongInfo[],
    selected: [],
    total: 2,
    page: true
  }
  const view = await mountFooter()
  try {
    const zh = view.text()
    expect(zh).toContain('总时长：3分钟')
    expect(zh).not.toContain('部分歌曲时长未知')
    expect(zh).not.toContain('含已知时长')
    setLocale('en-US')
    await flush()
    const en = view.text()
    expect(en).toContain('Total duration: 3 minutes')
    expect(en).not.toContain('some track durations unknown')
    expect(en).not.toContain('known durations only')
  } finally {
    view.unmount()
  }
})
