import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref, toRaw } from 'vue'
import { dbToLinearGain } from './gainEnvelope'
import { readProjectGainState, shiftProjectGain } from './projectGainEnvelope'
import type { ProjectGainEntry } from './projectGainEnvelope'
import { useMixtapeProjectGain } from './useMixtapeProjectGain'
import type { MixtapeTrack } from './types'

const track = (id: string, gains = [0.5, 1, 0.25]): MixtapeTrack => ({
  id,
  mixOrder: 1,
  title: id,
  artist: '',
  duration: '00:10',
  filePath: 'same-file.mp3',
  originPath: '',
  gainEnvelope: gains.map((gain, index) => ({ sec: index * 5, gain })),
  volumeEnvelope: [
    { sec: 0, gain: 0.5 },
    { sec: 10, gain: 0.8 }
  ],
  volumeMuteSegments: [{ startSec: 2, endSec: 4 }]
})

const harness = (initialTracks = [track('a'), track('b', [1, 2, 0.5])]) => {
  const tracks = ref(initialTracks)
  const playlistId = ref('project')
  const blocked = ref(false)
  const undoStack: Array<() => boolean> = []
  const persist = vi.fn(async (_entries: ProjectGainEntry[]) => {})
  const flushPending = vi.fn(async () => {})
  const refresh = vi.fn()
  const showError = vi.fn(async () => {})
  const onAdjusted = vi.fn()
  const onUndone = vi.fn()
  const controller = useMixtapeProjectGain({
    tracks,
    playlistId,
    isBlocked: () => blocked.value,
    resolveDuration: () => 10,
    pushUndo: (undo) => undoStack.push(undo),
    persist,
    flushPending,
    refresh,
    showError,
    onAdjusted,
    onUndone
  })
  return {
    controller,
    tracks,
    playlistId,
    blocked,
    undoStack,
    persist,
    flushPending,
    refresh,
    showError,
    onAdjusted,
    onUndone
  }
}

afterEach(() => vi.restoreAllMocks())

describe('project gain envelope adjustments', () => {
  it.each([-1, 1] as const)(
    'shifts every track by %s × 0.5 dB with unchanged timing and ratios',
    async (direction) => {
      const h = harness()
      const before = structuredClone(toRaw(h.tracks.value))
      await h.controller.adjust(direction)
      expect(h.persist).toHaveBeenCalledOnce()
      expect(h.persist.mock.calls[0][0]).toHaveLength(2)
      h.tracks.value.forEach((item, index) => {
        expect(item.gainEnvelope?.map((point) => point.sec)).toEqual([0, 5, 10])
        item.gainEnvelope?.forEach((point, pointIndex) => {
          expect(point.gain / before[index].gainEnvelope![pointIndex].gain).toBeCloseTo(
            dbToLinearGain(direction * 0.5),
            5
          )
        })
        expect(item.volumeEnvelope).toEqual(before[index].volumeEnvelope)
        expect(item.volumeMuteSegments).toEqual(before[index].volumeMuteSegments)
      })
      expect(h.undoStack).toHaveLength(1)
      expect(h.onAdjusted).toHaveBeenCalledWith(direction * 0.5, 2)
      expect(h.refresh).toHaveBeenCalledOnce()
    }
  )

  it('preserves instantaneous jumps and materializes a flat envelope for an unedited track', () => {
    const a = track('a')
    a.gainEnvelope!.splice(2, 0, { sec: 5, gain: 0.2 })
    const b = track('b')
    delete b.gainEnvelope
    const state = readProjectGainState([a, b], () => 10)!
    const next = shiftProjectGain(state, -0.5)
    expect(next[0].gainEnvelope.map((point) => point.sec)).toEqual([0, 5, 5, 10])
    expect(next[1].gainEnvelope).toEqual([
      { sec: 0, gain: 0.944061 },
      { sec: 10, gain: 0.944061 }
    ])
    expect(a.gainEnvelope![1].gain).toBe(1)
  })

  it('blocks the whole step at a limit instead of clipping individual points', async () => {
    const h = harness([track('a', [0.0001, 1, 16]), track('b')])
    const before = h.tracks.value
    expect(h.controller.canDecrease.value).toBe(false)
    expect(h.controller.canIncrease.value).toBe(false)
    expect(h.controller.unavailableReason.value).toBeNull()
    await h.controller.adjust(-1)
    await h.controller.adjust(1)
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.tracks.value).toBe(before)
    expect(h.undoStack).toHaveLength(0)
  })

  it('disables actions for an empty, blocked, or unresolved project', async () => {
    const empty = harness([])
    expect(empty.controller.canIncrease.value).toBe(false)
    expect(empty.controller.unavailableReason.value).toBe('empty')
    expect(readProjectGainState([track('a')], () => 0)).toBeNull()
    const h = harness()
    h.blocked.value = true
    expect(h.controller.canDecrease.value).toBe(false)
    expect(h.controller.unavailableReason.value).toBe('blocked')
    await h.controller.adjust(1)
    expect(h.persist).not.toHaveBeenCalled()
  })

  it('finishes pending point edits before reading and saving the complete batch', async () => {
    const h = harness()
    h.flushPending.mockImplementationOnce(async () => {
      h.tracks.value[0].gainEnvelope![1].gain = 3
    })
    await h.controller.adjust(-1)
    expect(h.tracks.value[0].gainEnvelope![1].gain).toBeCloseTo(3 * dbToLinearGain(-0.5), 6)
    expect(h.flushPending.mock.invocationCallOrder[0]).toBeLessThan(
      h.persist.mock.invocationCallOrder[0]
    )
  })

  it('keeps metadata updates and records one undo step per accepted click', async () => {
    const h = harness()
    h.persist.mockImplementationOnce(async () => {
      h.tracks.value[0] = { ...h.tracks.value[0], title: 'new metadata' }
    })
    const before = h.tracks.value.map((item) => item.gainEnvelope)
    await h.controller.adjust(-1)
    await h.controller.adjust(-1)
    expect(h.undoStack).toHaveLength(2)
    expect(h.tracks.value[0].title).toBe('new metadata')
    expect(h.undoStack.pop()!()).toBe(true)
    await vi.waitFor(() => expect(h.controller.busy.value).toBe(false))
    expect(h.tracks.value[0].gainEnvelope![1].gain).toBeCloseTo(dbToLinearGain(-0.5), 6)
    expect(h.undoStack.pop()!()).toBe(true)
    await vi.waitFor(() => expect(h.controller.busy.value).toBe(false))
    expect(h.tracks.value.map((item) => item.gainEnvelope)).toEqual(before)
    expect(h.onUndone).toHaveBeenCalledWith(2)
    expect(h.tracks.value[0].title).toBe('new metadata')
  })

  it('prevents overlapping saves and leaves playback-related track fields intact', async () => {
    const h = harness()
    let finish!: () => void
    h.persist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const applying = h.controller.adjust(-1)
    await vi.waitFor(() => expect(h.persist).toHaveBeenCalledOnce())
    expect(h.controller.canDecrease.value).toBe(false)
    expect(h.controller.canIncrease.value).toBe(false)
    await h.controller.adjust(1)
    expect(h.persist).toHaveBeenCalledOnce()
    finish()
    await applying
    expect(h.controller.busy.value).toBe(false)
  })

  it('leaves view and undo unchanged when persistence fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness()
    const before = h.tracks.value
    h.persist.mockRejectedValueOnce(new Error('database unavailable'))
    await h.controller.adjust(-1)
    expect(h.tracks.value).toBe(before)
    expect(h.undoStack).toHaveLength(0)
    expect(h.showError).toHaveBeenCalledOnce()
    expect(h.onAdjusted).not.toHaveBeenCalled()
    expect(h.controller.busy.value).toBe(false)
  })

  it('restores the undo step after a failed undo so the user can retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness()
    const before = h.tracks.value.map((item) => item.gainEnvelope)
    await h.controller.adjust(-1)
    const adjusted = h.tracks.value
    h.persist.mockRejectedValueOnce(new Error('write failed'))
    h.undoStack.pop()!()
    await vi.waitFor(() => expect(h.controller.busy.value).toBe(false))
    expect(h.tracks.value).toBe(adjusted)
    expect(h.undoStack).toHaveLength(1)
    h.undoStack.pop()!()
    await vi.waitFor(() => expect(h.controller.busy.value).toBe(false))
    expect(h.tracks.value.map((item) => item.gainEnvelope)).toEqual(before)
  })

  it('does not apply an old save to a newly opened project', async () => {
    const h = harness()
    h.persist.mockImplementationOnce(async () => {
      h.playlistId.value = 'new-project'
      h.tracks.value = [track('new')]
    })
    await h.controller.adjust(-1)
    expect(h.tracks.value[0].id).toBe('new')
    expect(h.tracks.value[0].gainEnvelope![1].gain).toBe(1)
    expect(h.undoStack).toHaveLength(0)
  })
})
