import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import type { MixtapeArrangementRequest } from '@shared/mixtapeArrangement'
import { useMixtapeCueOverlap } from './useMixtapeCueOverlap'
import { openMixtapeCueOverlapDialog } from '@renderer/components/mixtape/openMixtapeCueOverlapDialog'
import {
  applyMixtapeGlobalTempoSnapshot,
  readMixtapeGlobalTempoSnapshot,
  resetMixtapeGlobalTempoState
} from './mixtapeGlobalTempoState'
import type { MixtapeTrack } from './types'

vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/components/confirmDialog', () => ({ default: vi.fn() }))
vi.mock('@renderer/components/mixtape/openMixtapeCueOverlapDialog', () => ({
  openMixtapeCueOverlapDialog: vi.fn(async () => {})
}))
const invoke = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  invoke.mockImplementation(async (_channel: string, payload: MixtapeArrangementRequest) => {
    const { playlistId: _playlistId, ...snapshot } = payload
    return { updated: snapshot.entries.length, snapshot }
  })
  applyMixtapeGlobalTempoSnapshot({
    playlistId: 'mix',
    source: 'user',
    snapshot: {
      bpmEnvelope: [
        { sec: 0, bpm: 100 },
        { sec: 300, bpm: 100 }
      ],
      bpmEnvelopeDurationSec: 300,
      gridPhaseOffsetSec: 0.05
    }
  })
})
afterEach(() => {
  resetMixtapeGlobalTempoState()
  vi.unstubAllGlobals()
})
const setup = () => {
  const tracks = ref<MixtapeTrack[]>(
    [1, 2].map((index) => ({
      id: String(index),
      title: `Track ${index}`,
      mixOrder: index,
      filePath: `/track${index}.mp3`,
      artist: '',
      originPath: '',
      duration: '02:00',
      bpm: 100,
      originalBpm: 120,
      gridBaseBpm: 120,
      startSec: (index - 1) * 120,
      beatGridMap:
        createSongBeatGridMapV2FromFixedGrid({
          bpm: 120,
          firstBeatMs: 0,
          downbeatBeatOffset: 0,
          source: 'manual'
        }) ?? undefined,
      hotCues: [
        { slot: 0, sec: 10 },
        { slot: 1, sec: 90 }
      ],
      gainEnvelope: [
        { sec: 0, gain: 0.5 },
        { sec: 120, gain: 1 }
      ]
    }))
  )
  const blocked = ref(false),
    pushUndo = vi.fn(),
    refresh = vi.fn()
  const controller = useMixtapeCueOverlap({
    tracks,
    playlistId: ref('mix'),
    isBlocked: () => blocked.value,
    resolveSourceDuration: () => 120,
    pushUndo,
    refresh
  })
  const dialog = () => vi.mocked(openMixtapeCueOverlapDialog).mock.calls.at(-1)?.[0]
  return { controller, tracks, blocked, pushUndo, refresh, dialog }
}
const settings = { startCue: 0, endCue: 1, bpm: 128 }

describe('manual Mixtape cue overlap workflow', () => {
  it('does not modify or save anything on creation, preview, or cancel', async () => {
    const s = setup(),
      before = JSON.stringify(s.tracks.value),
      tempo = readMixtapeGlobalTempoSnapshot()
    expect(invoke).not.toHaveBeenCalled()
    await s.controller.open() // mock closes as cancel
    expect(s.dialog()?.buildPlan(settings).valid).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
    expect(JSON.stringify(s.tracks.value)).toBe(before)
    expect(readMixtapeGlobalTempoSnapshot()).toEqual(tempo)
    expect(s.pushUndo).not.toHaveBeenCalled()
  })

  it('confirms in one write, preserves envelopes, and restores BPM and starts with one undo', async () => {
    const s = setup(),
      before = JSON.stringify(s.tracks.value),
      tempo = readMixtapeGlobalTempoSnapshot()
    await s.controller.open()
    const dialog = s.dialog()
    if (!dialog) throw new Error('dialog missing')
    await dialog.confirm(settings)
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0][0]).toBe('mixtape:project:apply-arrangement')
    expect(s.tracks.value.map((track) => track.bpm)).toEqual([128, 128])
    expect(s.tracks.value[1].startSec).toBe(75)
    expect(s.tracks.value[0].gainEnvelope).toEqual(JSON.parse(before)[0].gainEnvelope)
    expect(s.pushUndo).toHaveBeenCalledOnce()
    const undo = s.pushUndo.mock.calls[0][0] as () => boolean
    expect(undo()).toBe(true)
    await vi.waitFor(() => expect(s.controller.busy.value).toBe(false))
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(s.tracks.value)).toBe(before)
    expect(readMixtapeGlobalTempoSnapshot()).toEqual(tempo)
  })

  it('keeps the previous state and undo stack if saving fails', async () => {
    const s = setup(),
      before = JSON.stringify(s.tracks.value),
      tempo = readMixtapeGlobalTempoSnapshot()
    await s.controller.open()
    invoke.mockRejectedValueOnce(new Error('database failed'))
    await expect(s.dialog()?.confirm(settings)).rejects.toThrow('database failed')
    expect(JSON.stringify(s.tracks.value)).toBe(before)
    expect(readMixtapeGlobalTempoSnapshot()).toEqual(tempo)
    expect(s.pushUndo).not.toHaveBeenCalled()
    expect(s.controller.busy.value).toBe(false)
  })

  it('disables the action while transport/output is busy and rejects a changed state on confirm', async () => {
    const s = setup()
    s.blocked.value = true
    expect(s.controller.canOpen.value).toBe(false)
    await s.controller.open()
    expect(openMixtapeCueOverlapDialog).not.toHaveBeenCalled()
    s.blocked.value = false
    await s.controller.open()
    s.blocked.value = true
    await expect(s.dialog()?.confirm(settings)).rejects.toThrow('CHANGED')
    expect(invoke).not.toHaveBeenCalled()
  })
})
