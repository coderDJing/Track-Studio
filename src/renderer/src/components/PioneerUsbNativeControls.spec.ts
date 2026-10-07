import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import HorizontalBrowseDeckOverviewSection from './HorizontalBrowseDeckOverviewSection.vue'
import { resolveHorizontalBrowseDeckToolbarPresentation } from '../composables/horizontalBrowse/horizontalBrowseDeckToolbarPresentation'
import { createDefaultDeckToolbarState } from '../composables/horizontalBrowse/horizontalBrowseModeShellTypes'
import type { ISongInfo } from 'src/types/globals'
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/components/bubbleBoxTrigger.vue', () => ({
  default: defineComponent({
    props: ['tag', 'title', 'wrapperTag'],
    setup: (props, context) => () =>
      h(props.tag || 'span', context.attrs, context.slots.default?.())
  })
}))
vi.mock('@renderer/components/HorizontalBrowseDeckInfoCard.vue', () => ({
  default: { render: () => null }
}))
vi.mock('@renderer/components/HorizontalBrowseWaveformOverview.vue', () => ({
  default: { render: () => null }
}))
vi.mock('@renderer/components/HorizontalBrowseDeckMoveButton.vue', () => ({
  default: { render: () => null }
}))
vi.mock('@renderer/components/BeatGridMetronomeControls.vue', () => ({
  default: { render: () => null }
}))

const render = (theme: string, usb: boolean) => {
  const song = {
    filePath: 'D:\\Contents\\7.mp3',
    externalSourceKind: usb ? 'usb' : undefined,
    pioneerUsbSource: usb ? { rootPath: 'D:\\', libraryType: 'oneLibrary', trackId: 7 } : undefined,
    rekordboxGridEntries: [{ beatNumber: 1, bpm: 120, timeMs: 100 }]
  } as ISongInfo
  const toolbarState = resolveHorizontalBrowseDeckToolbarPresentation({
    toolbarState: { ...createDefaultDeckToolbarState(), disabled: false, bpmInputDisabled: false },
    bpmInputValue: '120',
    loopBeatLabel: '8',
    loopActive: false,
    loopDisabled: false,
    editMode: false,
    editSaving: false,
    editSubMode: '',
    song
  })
  return renderToString(
    createSSRApp({
      render: () =>
        h('div', { class: theme }, [
          h(HorizontalBrowseDeckOverviewSection, {
            position: 'top',
            regionIds: [3],
            deck: 'top',
            deckHovered: false,
            song,
            beatSyncEnabled: false,
            beatSyncPending: false,
            masterActive: false,
            masterPending: false,
            masterFailed: false,
            keyHighlighted: false,
            currentSeconds: 0,
            durationSeconds: 120,
            hotCues: [],
            memoryCues: [],
            toolbarState,
            loopRange: null,
            readOnlySource: usb,
            quantizeEnabled: true,
            masterTempoEnabled: false
          })
        ])
    })
  )
}
describe('native USB controls reach the actual overview and toolbar components', () => {
  it.each(['theme-light', 'theme-dark'])(
    'shows grid shifts and Memory through the existing controls in %s',
    async (theme) => {
      const html = await render(theme, true)
      expect(html).toContain('aria-label="Memory Cue"')
      expect(html).toContain('grid-adjust-bpm-input')
      expect(html).not.toContain('aria-label="mixtape.gridAdjustSetDownbeatLineAtPlayhead"')
      expect(html).toContain('aria-label="mixtape.gridAdjustShiftLeftSmall"')
      expect(html).toContain('aria-label="mixtape.gridAdjustShiftRightSmall"')
      expect(html).toMatch(/<input[^>]*disabled/)
    }
  )
  it('keeps normal grid controls available for local songs', async () => {
    const html = await render('theme-light', false)
    expect(html).toContain('aria-label="mixtape.gridAdjustSetDownbeatLineAtPlayhead"')
    expect(html).not.toMatch(/<input[^>]*disabled/)
  })
})
