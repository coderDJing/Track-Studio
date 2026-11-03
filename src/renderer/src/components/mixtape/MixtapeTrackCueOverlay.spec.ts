import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { compileStyleAsync, parse } from '@vue/compiler-sfc'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import MixtapeTrackCueOverlay from './MixtapeTrackCueOverlay.vue'
import MixtapeTrackEnvelopeCurve from './MixtapeTrackEnvelopeCurve.vue'
import HotCueMarkersLayer from '../HotCueMarkersLayer.vue'
import MemoryCueMarkersLayer from '../MemoryCueMarkersLayer.vue'
import { BASE_PX_PER_SEC, MIXTAPE_WIDTH_SCALE } from '../../composables/mixtape/constants'

vi.mock('@renderer/components/bubbleBoxTrigger.vue', () => ({
  default: defineComponent({
    props: ['tag', 'title'],
    setup: (props, context) => () =>
      h(props.tag || 'span', context.attrs, context.slots.default?.())
  })
}))

const render = (theme: string) =>
  renderToString(
    createSSRApp({
      render: () =>
        h('section', { class: theme }, [
          h('h3', theme),
          h('div', { class: 'preview-track' }, [
            h(
              'svg',
              { class: 'preview-waveform', viewBox: '0 0 960 130', preserveAspectRatio: 'none' },
              [
                h('path', {
                  d: Array.from({ length: 480 }, (_, i) => {
                    const height = 8 + Math.abs(Math.sin(i * 0.17) * Math.cos(i * 0.031)) * 50
                    return `M${i * 2},${65 - height}V${65 + height}`
                  }).join(' '),
                  stroke: '#468cb8',
                  'stroke-width': 1.3
                })
              ]
            ),
            h(MixtapeTrackCueOverlay, {
              item: {
                track: {
                  id: 'track',
                  mixOrder: 1,
                  title: 'Track',
                  artist: '',
                  duration: '01:00',
                  filePath: '/track.mp3',
                  originPath: '',
                  bpm: 120,
                  originalBpm: 120,
                  hotCues: [
                    { slot: 0, sec: 0 },
                    { slot: 1, sec: 15 },
                    { slot: 2, sec: 45 }
                  ],
                  memoryCues: [{ sec: 30, comment: 'Mix out' }]
                },
                laneIndex: 0,
                startSec: 0,
                startX: 0,
                width: 960
              },
              sourceDurationSec: 60,
              renderZoom: 960 / (60 * BASE_PX_PER_SEC * MIXTAPE_WIDTH_SCALE)
            })
          ])
        ])
    })
  )

describe('Mixtape cue overlay', () => {
  it.each(['theme-light', 'theme-dark'])(
    'uses the dual-deck markers on the upper edge in %s',
    async (theme) => {
      const html = await render(theme)
      expect(html).toContain('hotcue-marker--top')
      expect(html).toContain('memorycue-marker--top')
      expect(html).not.toContain('marker--bottom')
      expect(html).not.toMatch(/\stitle=/)
      expect(html).toContain('>A</span>')
      expect(html).toContain('>B</span>')
      expect(html).toContain('>C</span>')
      expect(html).toContain('left:240px;')
      expect(html).toContain('left:480px;')
      expect(html).toContain('left:720px;')
    }
  )

  it('keeps the extracted envelope curve and hit area visible', async () => {
    const html = await renderToString(
      createSSRApp(MixtapeTrackEnvelopeCurve, {
        visible: true,
        polygon: '0,100 0,50 100,50 100,100',
        polyline: '0,50 100,50'
      })
    )
    expect(html).toContain('lane-track__envelope-segment-hit')
    expect(html).not.toContain('is-hidden')
  })

  it('can render a visual QA page from the actual components and scoped styles', async () => {
    const outputDir = process.env.FRKB_CUE_PREVIEW_DIR
    if (!outputDir) return
    const css: string[] = [await readFile('src/renderer/src/styles/main.scss', 'utf8')]
    for (const [component, file] of [
      [MixtapeTrackCueOverlay, 'mixtape/MixtapeTrackCueOverlay.vue'],
      [HotCueMarkersLayer, 'HotCueMarkersLayer.vue'],
      [MemoryCueMarkersLayer, 'MemoryCueMarkersLayer.vue']
    ] as const) {
      const filename = path.resolve('src/renderer/src/components', file)
      const { descriptor } = parse(await readFile(filename, 'utf8'))
      const scopeId = (component as { __scopeId?: string }).__scopeId
      const result = await compileStyleAsync({
        filename,
        source: descriptor.styles[0].content,
        id: scopeId || '',
        scoped: true,
        preprocessLang: 'scss'
      })
      expect(result.errors).toEqual([])
      css.push(result.code)
    }
    css.push(`body{margin:0;background:#777}section{padding:20px;background:var(--bg);color:var(--text)}
      h3{margin:0 0 12px;font-size:14px}.preview-track{position:relative;width:960px;height:130px;background:var(--waveform-bg);--lane-track-border-width:0px}
      .preview-waveform{position:absolute;inset:0;width:100%;height:100%}`)
    await mkdir(outputDir, { recursive: true })
    await writeFile(
      path.join(outputDir, 'cue-overlay.html'),
      `<html><head><style>${css.join('\n')}</style></head><body>${await render('theme-light')}${await render('theme-dark')}</body></html>`
    )
  })
})
