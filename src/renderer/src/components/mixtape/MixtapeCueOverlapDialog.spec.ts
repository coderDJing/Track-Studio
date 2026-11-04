import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { compileStyleAsync, parse } from '@vue/compiler-sfc'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import MixtapeCueOverlapDialog from './MixtapeCueOverlapDialog.vue'
import BaseSelect from '../BaseSelect.vue'
import { buildMixtapeCueOverlapPlan } from '../../composables/mixtape/mixtapeCueOverlap'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import type { MixtapeTrack } from '../../composables/mixtape/types'

vi.mock('@renderer/stores/runtime', () => ({ useRuntimeStore: () => ({ confirmShow: false }) }))
vi.mock('@renderer/utils/utils', () => ({
  default: { setHotkeysScpoe: vi.fn(), delHotkeysScope: vi.fn() }
}))
vi.mock('@renderer/composables/useDialogTransition', () => ({
  useDialogTransition: () => ({
    dialogVisible: ref(true),
    closeWithAnimation: (callback: () => void) => callback()
  })
}))
vi.mock('hotkeys-js', () => ({ default: vi.fn() }))
vi.mock('@renderer/components/bubbleBoxTrigger.vue', () => ({
  default: defineComponent({
    props: ['tag', 'title'],
    setup: (props, context) => () =>
      h(props.tag || 'span', context.attrs, context.slots.default?.())
  })
}))
vi.mock('@renderer/utils/translate', async () => {
  const mix = (await import('../../i18n/locales/zh-CN/mixtape.json')).default.mixtape
  const playlist = (await import('../../i18n/locales/zh-CN/playlist.json')).default.playlist
  const dict: Record<string, string> = {
    ...Object.fromEntries(Object.entries(mix).map(([key, value]) => [`mixtape.${key}`, value])),
    ...Object.fromEntries(
      Object.entries(playlist).map(([key, value]) => [`playlist.${key}`, value])
    ),
    'common.cancel': '取消'
  }
  return {
    t: (key: string, params: Record<string, unknown> = {}) =>
      (dict[key] || key).replace(/\{(\w+)\}/g, (_, token: string) => String(params[token] ?? ''))
  }
})

const tracks: MixtapeTrack[] = Array.from({ length: 7 }, (_, index) => ({
  id: String(index),
  title: `示例歌曲 ${index + 1} — Hot Cue 转场预览`,
  artist: '',
  filePath: `/track${index}.mp3`,
  originPath: '',
  mixOrder: index + 1,
  startSec: index * 240,
  duration: '04:00',
  originalBpm: 120,
  gridBaseBpm: 120,
  bpm: 120,
  beatGridMap:
    createSongBeatGridMapV2FromFixedGrid({
      bpm: 120,
      firstBeatMs: 0,
      downbeatBeatOffset: 0,
      source: 'analysis'
    }) ?? undefined,
  hotCues:
    index === 3
      ? [{ slot: 0, sec: 8 }]
      : [
          { slot: 0, sec: 8 },
          { slot: 1, sec: 190 }
        ]
}))
const render = async (theme: string) => {
  const app = createSSRApp({
    render: () =>
      h('section', { class: `preview-theme ${theme}` }, [
        h('h3', theme),
        h(MixtapeCueOverlapDialog, {
          initialBpm: 128,
          buildPlan: (settings) =>
            buildMixtapeCueOverlapPlan({ tracks, settings, resolveSourceDuration: () => 240 }),
          confirm: vi.fn(async () => {})
        })
      ])
  })
  app.directive('dialog-drag', { getSSRProps: () => ({}) })
  return renderToString(app)
}

describe('manual cue overlap dialog', () => {
  it.each(['theme-light', 'theme-dark'])(
    'renders Cue selectors, BPM, preview, cancel, and confirm in %s',
    async (theme) => {
      const html = await render(theme)
      expect(html).toContain('Hot Cue 对齐')
      expect(html).toContain('开始 Hot Cue')
      expect(html).toContain('结束 Hot Cue')
      expect(html).toContain('目标 BPM')
      expect(html).toContain('确认对齐')
      expect(html).toContain('取消')
      expect(html).toContain('替换当前主 BPM 变化曲线')
      expect(html).toContain('1 首缺少结束 Cue，使用歌曲结尾')
      expect(html).not.toMatch(/\stitle=/)
    }
  )

  it('can export the real dialog and scoped styles for visual QA', async () => {
    const outputDir = process.env.FRKB_OVERLAP_PREVIEW_DIR
    if (!outputDir) return
    const css: string[] = []
    for (const [component, filename] of [
      [MixtapeCueOverlapDialog, 'src/renderer/src/components/mixtape/MixtapeCueOverlapDialog.vue'],
      [BaseSelect, 'src/renderer/src/components/BaseSelect.vue']
    ] as const) {
      const { descriptor } = parse(await readFile(filename, 'utf8'))
      const result = await compileStyleAsync({
        filename,
        source: descriptor.styles[0].content,
        id: (component as { __scopeId?: string }).__scopeId || '',
        scoped: true,
        preprocessLang: 'scss'
      })
      expect(result.errors).toEqual([])
      css.push(result.code)
    }
    const globalCss = await compileStyleAsync({
      filename: 'main.scss',
      source: await readFile('src/renderer/src/styles/main.scss', 'utf8'),
      id: '',
      preprocessLang: 'scss'
    })
    expect(globalCss.errors).toEqual([])
    css.unshift(globalCss.code)
    css.push(
      'body{margin:0}.preview-theme{position:relative;height:640px;background:var(--bg);color:var(--text)}.preview-theme > h3{position:absolute;left:16px;top:0;z-index:100;font-size:13px}.preview-theme .dialog{position:absolute;width:100%;height:100%}'
    )
    await mkdir(outputDir, { recursive: true })
    await writeFile(
      path.join(outputDir, 'cue-overlap-dialog.html'),
      `<html><meta charset="UTF-8"><style>${css.join('\n')}</style><body>${await render('theme-light')}${await render('theme-dark')}</body></html>`
    )
  })
})
