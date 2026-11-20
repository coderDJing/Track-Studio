import { afterEach, describe, expect, it } from 'vitest'
import { mapBaseTrackLocalToFirstLoopedLocal } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import { resetMixtapeGlobalTempoState } from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import type { MixtapeTrack } from '@renderer/composables/mixtape/types'
import { resolveMixtapeChapterAudibleEntrySec } from './mixtapeChapterEntry'

const track = (overrides: Partial<MixtapeTrack> = {}): MixtapeTrack => ({
  id: 't1',
  mixOrder: 1,
  title: 'One',
  artist: 'A',
  duration: '1:40',
  filePath: 'one.mp3',
  originPath: '',
  bpm: 120,
  originalBpm: 120,
  startSec: 30,
  ...overrides
})

describe('resolveMixtapeChapterAudibleEntrySec', () => {
  afterEach(() => {
    resetMixtapeGlobalTempoState()
  })

  it('uses the clip origin when the intro is not muted', () => {
    expect(resolveMixtapeChapterAudibleEntrySec(track(), 100)).toBe(30)
  })

  it('adds a muted intro in unlooped base-local seconds', () => {
    expect(
      resolveMixtapeChapterAudibleEntrySec(
        track({ volumeMuteSegments: [{ startSec: 0, endSec: 16.4 }] }),
        100
      )
    ).toBe(46.4)
  })

  it('maps the muted prefix through loop expansion instead of adding the raw offset', () => {
    const loopSegments = [{ startSec: 0, endSec: 8, repeatCount: 2 }]
    const mutedPrefixSec = 16
    const mappedOffset = mapBaseTrackLocalToFirstLoopedLocal(mutedPrefixSec, 100, loopSegments)
    expect(mappedOffset).toBe(32)
    expect(
      resolveMixtapeChapterAudibleEntrySec(
        track({
          loopSegments,
          volumeMuteSegments: [{ startSec: 0, endSec: mutedPrefixSec }]
        }),
        100
      )
    ).toBe(62)
    expect(
      resolveMixtapeChapterAudibleEntrySec(
        track({
          loopSegments,
          volumeMuteSegments: [{ startSec: 0, endSec: mutedPrefixSec }]
        }),
        100
      )
    ).not.toBe(30 + mutedPrefixSec)
  })

  it('omits a clip whose unlooped base duration stays muted', () => {
    expect(
      resolveMixtapeChapterAudibleEntrySec(
        track({
          volumeMuteSegments: [{ startSec: 0, endSec: 100 }]
        }),
        100
      )
    ).toBeNull()
  })

  it('treats mute length as base-local time after a 2x tempo change, not source seconds', () => {
    expect(
      resolveMixtapeChapterAudibleEntrySec(
        track({
          bpm: 240,
          originalBpm: 120,
          volumeMuteSegments: [{ startSec: 0, endSec: 10 }]
        }),
        100
      )
    ).toBe(40)
  })
})
