import { describe, expect, it } from 'vitest'
import {
  resolveHorizontalBrowseLoopClockDriftSec,
  resolveHorizontalBrowseLoopPlaybackSeconds
} from './horizontalBrowseLoopClock'

describe('horizontal browse loop clock', () => {
  const range = { startSec: 10.123, endSec: 10.248 }

  it('wraps after several audio cycles between native snapshots', () => {
    expect(resolveHorizontalBrowseLoopPlaybackSeconds(10.823, range)).toBeCloseTo(10.198, 9)
  })

  it('wraps at the loop end and retains positions inside the loop', () => {
    expect(resolveHorizontalBrowseLoopPlaybackSeconds(range.endSec, range)).toBe(range.startSec)
    expect(resolveHorizontalBrowseLoopPlaybackSeconds(10.18, range)).toBe(10.18)
    expect(resolveHorizontalBrowseLoopPlaybackSeconds(10.1, range)).toBe(range.startSec)
  })

  it.each([null, { startSec: 1, endSec: 1 }, { startSec: 2, endSec: 1 }])(
    'does not change the clock without a valid active loop: %j',
    (invalidRange) => {
      expect(resolveHorizontalBrowseLoopPlaybackSeconds(10.823, invalidRange)).toBe(10.823)
    }
  )

  it('compares phase across the boundary without treating a wrap as a seek', () => {
    expect(resolveHorizontalBrowseLoopClockDriftSec(10.247, 10.124, range)).toBeCloseTo(0.002, 9)
    expect(resolveHorizontalBrowseLoopClockDriftSec(10.247, 10.124, null)).toBeCloseTo(0.123, 9)
  })
})
