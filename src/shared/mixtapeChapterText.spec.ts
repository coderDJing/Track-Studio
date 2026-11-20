import { describe, expect, it } from 'vitest'
import {
  buildMixtapeChapterText,
  formatMixtapeChapterTimestamp,
  resolveMixtapeChapterTitle,
  resolveMutedIntroOffsetSec
} from './mixtapeChapterText'

describe('formatMixtapeChapterTimestamp', () => {
  it('formats minutes and seconds without hours', () => {
    expect(formatMixtapeChapterTimestamp(0)).toBe('0:00')
    expect(formatMixtapeChapterTimestamp(61.4)).toBe('1:01')
  })

  it('formats hours when the mix is an hour or longer', () => {
    expect(formatMixtapeChapterTimestamp(3600)).toBe('1:00:00')
    expect(formatMixtapeChapterTimestamp(3723)).toBe('1:02:03')
  })

  it('clamps negative values to 0:00', () => {
    expect(formatMixtapeChapterTimestamp(-8)).toBe('0:00')
  })
})

describe('resolveMutedIntroOffsetSec', () => {
  it('returns 0 when the intro is not muted', () => {
    expect(resolveMutedIntroOffsetSec(undefined)).toBe(0)
    expect(resolveMutedIntroOffsetSec([])).toBe(0)
    expect(resolveMutedIntroOffsetSec([{ startSec: 10, endSec: 20 }])).toBe(0)
  })

  it('uses the continuous muted prefix from 0, including adjacent and overlapping segments', () => {
    expect(resolveMutedIntroOffsetSec([{ startSec: 0, endSec: 16.4 }])).toBe(16.4)
    expect(
      resolveMutedIntroOffsetSec([
        { startSec: 8, endSec: 16 },
        { startSec: 0, endSec: 8 }
      ])
    ).toBe(16)
    expect(
      resolveMutedIntroOffsetSec([
        { startSec: 0, endSec: 8 },
        { startSec: 6, endSec: 16 }
      ])
    ).toBe(16)
  })

  it('stops at the first gap and clamps a negative start to 0', () => {
    expect(
      resolveMutedIntroOffsetSec([
        { startSec: 0, endSec: 8 },
        { startSec: 10, endSec: 20 }
      ])
    ).toBe(8)
    expect(resolveMutedIntroOffsetSec([{ startSec: -2, endSec: 9 }])).toBe(9)
  })
})

describe('buildMixtapeChapterText', () => {
  it('returns an empty string when there are no tracks', () => {
    expect(buildMixtapeChapterText([])).toBe('')
  })

  it('forces the first line to 0:00 and sorts by timeline entry', () => {
    expect(
      buildMixtapeChapterText([
        { startSec: 95, title: 'Second', artist: 'B' },
        { startSec: 12.4, title: 'First', artist: 'A' },
        { startSec: 200, title: 'Third', artist: 'C' }
      ])
    ).toBe(['0:00 First - A', '1:35 Second - B', '3:20 Third - C'].join('\n'))
  })

  it('omits a trailing dash when the artist is missing', () => {
    expect(buildMixtapeChapterText([{ startSec: 0, title: 'Intro' }])).toBe('0:00 Intro')
  })

  it('falls back to the file name when the title is missing', () => {
    expect(resolveMixtapeChapterTitle({ filePath: 'D:\\library\\Midnight City.mp3' })).toBe(
      'Midnight City'
    )
    expect(
      buildMixtapeChapterText([
        { startSec: 0, filePath: 'D:\\library\\Midnight City.mp3', artist: 'M83' }
      ])
    ).toBe('0:00 Midnight City - M83')
  })

  it('lists every overlapping entry on a 4-lane timeline', () => {
    expect(
      buildMixtapeChapterText([
        { startSec: 0, title: 'One', artist: 'A' },
        { startSec: 8.2, title: 'Two', artist: 'B' },
        { startSec: 10, title: 'Three', artist: 'C' },
        { startSec: 11.6, title: 'Four', artist: 'D' }
      ])
    ).toBe(['0:00 One - A', '0:08 Two - B', '0:10 Three - C', '0:12 Four - D'].join('\n'))
  })

  it('uses a precomputed audible entrySec instead of the clip origin', () => {
    expect(
      buildMixtapeChapterText([
        { startSec: 0, title: 'One', artist: 'A' },
        { startSec: 30, entrySec: 46.4, title: 'Two', artist: 'B' }
      ])
    ).toBe(['0:00 One - A', '0:46 Two - B'].join('\n'))
  })

  it('omits a track whose audible entry is explicitly null', () => {
    expect(
      buildMixtapeChapterText([
        { startSec: 0, title: 'One', artist: 'A' },
        { startSec: 30, entrySec: null, title: 'Two', artist: 'B' }
      ])
    ).toBe('0:00 One - A')
  })

  it('keeps the first listed line at 0:00 even if its audible entry is later', () => {
    expect(
      buildMixtapeChapterText([
        { startSec: 0, entrySec: 16, title: 'One', artist: 'A' },
        { startSec: 30, title: 'Two', artist: 'B' }
      ])
    ).toBe(['0:00 One - A', '0:30 Two - B'].join('\n'))
  })

  it('forces the first remaining line to 0:00 after an omitted leading track', () => {
    expect(
      buildMixtapeChapterText([
        { startSec: 0, entrySec: null, title: 'One', artist: 'A' },
        { startSec: 30, title: 'Two', artist: 'B' }
      ])
    ).toBe('0:00 Two - B')
  })
})
