// Run: pnpm exec vitest run src/renderer/src/composables/mixtape/useMixtapeTrackLoopEditor.spec.ts
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import { useMixtapeTrackLoopEditor } from './useMixtapeTrackLoopEditor'
import { resetMixtapeGlobalTempoState } from './mixtapeGlobalTempoState'
import type { MixtapeTrack, TimelineTrackLayout } from './types'

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue')>()),
  onMounted: () => {},
  onBeforeUnmount: () => {}
}))

const invoke = vi.fn(async () => ({}))
beforeEach(() => {
  invoke.mockClear()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  resetMixtapeGlobalTempoState()
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetMixtapeGlobalTempoState()
})

const setup = (withGrid: boolean) => {
  const track: MixtapeTrack = {
    id: 'track',
    mixOrder: 1,
    title: '',
    artist: '',
    duration: '02:00',
    filePath: '',
    originPath: '',
    bpm: 120,
    originalBpm: 120,
    beatGridMap: withGrid
      ? (createSongBeatGridMapV2FromFixedGrid({
          bpm: 120,
          firstBeatMs: 0,
          downbeatBeatOffset: 0,
          source: 'analysis'
        }) ?? undefined)
      : undefined
  }
  const tracks = ref([track])
  const zoom = ref(0.1)
  const scope = effectScope()
  const editor = scope.run(() =>
    useMixtapeTrackLoopEditor({
      t: (key) => key,
      tracks,
      mixtapePlaylistId: ref('mix'),
      renderZoomLevel: zoom,
      isLoopParamMode: ref(true),
      resolveTrackDurationSeconds: () => 120,
      resolveTrackSourceDurationSeconds: () => 120,
      clearTimelineLayoutCache: () => {},
      updateTimelineWidth: () => {},
      scheduleTimelineDraw: () => {},
      scheduleFullPreRender: () => {},
      scheduleWorkerPreRender: () => {}
    })
  )
  if (!editor) throw new Error('failed to create loop editor')
  const item: TimelineTrackLayout = { track, laneIndex: 0, startSec: 0, startX: 0, width: 144 }
  return { editor, item, tracks, zoom, scope }
}

describe('loop grid at overview zoom', () => {
  it('shows spaced real downbeats and persists a selected loop', async () => {
    const { editor, item, tracks, zoom, scope } = setup(true)
    const lines = editor.resolveTrackLoopOverlay(item)?.gridLines ?? []
    expect(lines.length).toBeGreaterThan(2)
    expect(lines.every((line) => line.level === 'downbeat')).toBe(true)
    for (let i = 1; i < lines.length; i++) {
      expect(
        (lines[i].displaySec - lines[i - 1].displaySec) * 12 * zoom.value
      ).toBeGreaterThanOrEqual(14)
    }
    for (const line of lines.slice(0, 2))
      editor.handleTrackLoopGridLineClick(item, line.baseSec, line.displaySec, line.disabled)
    expect(tracks.value[0].loopSegments).toEqual([
      { startSec: lines[0].baseSec, endSec: lines[1].baseSec, repeatCount: 1 }
    ])
    expect(invoke).toHaveBeenCalledWith(
      'mixtape:update-track-loops',
      expect.objectContaining({ entries: expect.any(Array) })
    )
    scope.stop()
  })

  it('still reports missing analysis when there is no source grid', () => {
    const { editor, item, zoom, scope } = setup(false)
    for (zoom.value of [0.1, 3, 15]) {
      const overlay = editor.resolveTrackLoopOverlay(item)
      expect(overlay?.gridLines).toEqual([])
      expect(overlay?.gridEmptyHint).toBe('mixtape.loopGridUnavailableHint')
    }
    scope.stop()
  })
})
