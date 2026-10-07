import { describe, expect, it } from 'vitest'
import {
  areSongHotCuesEqual,
  normalizeSongHotCues,
  upsertSongHotCue,
  upsertSongHotCueDefinition
} from './hotCues'

const loop = {
  slot: 1,
  sec: 30.029,
  isLoop: true,
  loopEndSec: 33.34,
  loopNumerator: 8,
  loopDenominator: 1
}

describe('hot cue loop beat metadata', () => {
  it('preserves native beats and detects beat-only changes during list comparison', () => {
    expect(normalizeSongHotCues([loop])[0]).toMatchObject(loop)
    expect(areSongHotCuesEqual([loop], [{ ...loop, loopNumerator: 4 }])).toBe(false)
    expect(areSongHotCuesEqual([loop], [loop])).toBe(true)
  })

  it('retains beats for an unrelated edit and clears them when a plain point replaces a loop', () => {
    const position = { slot: loop.slot, sec: loop.sec, isLoop: true, loopEndSec: loop.loopEndSec }
    expect(upsertSongHotCueDefinition([loop], { ...position, comment: 'Edited' })[0]).toMatchObject(
      { loopNumerator: 8, loopDenominator: 1, comment: 'Edited' }
    )
    expect(upsertSongHotCue([loop], 1, 40)[0].loopNumerator).toBeUndefined()
  })

  it('keeps changed endpoints manual unless a new beat size is supplied explicitly', () => {
    const changed = { slot: 1, sec: 31, isLoop: true, loopEndSec: 34 }
    expect(upsertSongHotCueDefinition([loop], changed)[0].loopNumerator).toBeUndefined()
    expect(
      upsertSongHotCueDefinition([loop], { ...changed, loopNumerator: 4, loopDenominator: 1 })[0]
    ).toMatchObject({ loopNumerator: 4, loopDenominator: 1 })
  })
})
