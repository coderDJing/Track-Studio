import { describe, expect, it } from 'vitest'
import {
  areSongMemoryCuesEqual,
  normalizeSongMemoryCues,
  upsertSongMemoryCueDefinition
} from './memoryCues'

describe('memory cue active loop state', () => {
  it('preserves loop beat metadata through normalization and detects beat-only changes', () => {
    const cue = { sec: 1, isLoop: true, loopEndSec: 2, loopNumerator: 8, loopDenominator: 1 }
    expect(normalizeSongMemoryCues([cue])[0]).toMatchObject(cue)
    expect(areSongMemoryCuesEqual([cue], [{ ...cue, loopNumerator: 4 }])).toBe(false)
    const changed = upsertSongMemoryCueDefinition([cue], { ...cue, loopNumerator: 4 })
    expect(changed[0].loopNumerator).toBe(4)
    expect(
      upsertSongMemoryCueDefinition([cue], {
        sec: 1,
        isLoop: true,
        loopEndSec: 2,
        activeLoop: true
      })[0]
    ).toMatchObject({ loopNumerator: 8, loopDenominator: 1, activeLoop: true })
    expect(
      normalizeSongMemoryCues([{ sec: 1, loopNumerator: 8, loopDenominator: 1 }])[0].loopNumerator
    ).toBeUndefined()
  })
  it('preserves known active and inactive loop states but leaves unknown state unspecified', () => {
    const cues = normalizeSongMemoryCues([
      { sec: 1, isLoop: true, loopEndSec: 2, activeLoop: true },
      { sec: 3, isLoop: true, loopEndSec: 4, activeLoop: false },
      { sec: 5, isLoop: true, loopEndSec: 6 },
      { sec: 7, activeLoop: true }
    ])
    expect(cues.map((cue) => cue.activeLoop)).toEqual([true, false, undefined, false])
  })

  it('updates explicit active status for an existing loop while retaining its native comment and color', () => {
    const original = [
      { sec: 1, isLoop: true, loopEndSec: 2, activeLoop: false, comment: 'Native', colorIndex: 2 }
    ]
    const updated = upsertSongMemoryCueDefinition(original, {
      sec: 1,
      isLoop: true,
      loopEndSec: 2,
      activeLoop: true
    })
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ activeLoop: true, comment: 'Native', colorIndex: 2 })
    expect(
      upsertSongMemoryCueDefinition(updated, { sec: 1, isLoop: true, loopEndSec: 2 })[0].activeLoop
    ).toBe(true)
  })

  it('distinguishes unknown, inactive and active native states when comparing rows', () => {
    const cue = { sec: 1, isLoop: true, loopEndSec: 2 }
    expect(areSongMemoryCuesEqual([cue], [{ ...cue, activeLoop: false }])).toBe(false)
    expect(
      areSongMemoryCuesEqual([{ ...cue, activeLoop: false }], [{ ...cue, activeLoop: true }])
    ).toBe(false)
    expect(
      areSongMemoryCuesEqual([{ ...cue, activeLoop: true }], [{ ...cue, activeLoop: true }])
    ).toBe(true)
  })
})
