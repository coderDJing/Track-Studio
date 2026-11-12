import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromClips } from '../../../shared/songBeatGridMapV2'
import { isCachedEnergyGridCurrent, readEnergySourceGridSignature } from './energyCachePolicy'

const singleClip = createSongBeatGridMapV2FromClips(
  [{ startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 }],
  'analysis',
  { allowSingleClip: true }
)!

const multiClip = createSongBeatGridMapV2FromClips(
  [
    { startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 },
    { startSec: 30, anchorSec: 30, bpm: 126, downbeatBeatOffset: 0 }
  ],
  'analysis',
  { allowSingleClip: true }
)!

describe('isCachedEnergyGridCurrent', () => {
  it('accepts legacy fixed-grid energy without a signature (no library-wide invalidation)', () => {
    expect(isCachedEnergyGridCurrent({ energyScore: 50 }, singleClip)).toBe(true)
  })

  it('treats signature-less energy as stale once the grid is a dynamic multi-clip map', () => {
    expect(isCachedEnergyGridCurrent({ energyScore: 50 }, multiClip)).toBe(false)
  })

  it('requires an exact signature match when one is recorded', () => {
    expect(
      isCachedEnergyGridCurrent({ energySourceGridSignature: singleClip.signature }, singleClip)
    ).toBe(true)
    expect(
      isCachedEnergyGridCurrent({ energySourceGridSignature: singleClip.signature }, multiClip)
    ).toBe(false)
  })

  it('does not claim validity when the signature exists but no grid is available', () => {
    expect(
      isCachedEnergyGridCurrent({ energySourceGridSignature: multiClip.signature }, null)
    ).toBe(false)
  })

  it('normalizes the persisted signature', () => {
    expect(readEnergySourceGridSignature({ energySourceGridSignature: '  sbgm_x ' })).toBe('sbgm_x')
    expect(readEnergySourceGridSignature({})).toBeUndefined()
    expect(readEnergySourceGridSignature(null)).toBeUndefined()
  })
})
