import { describe, expect, it } from 'vitest'
import { readIcloudDownloadPercent, toIcloudDownloadProgressEvent } from './icloudLibrary'

describe('readIcloudDownloadPercent', () => {
  it('keeps finite 0–100 values and rounds to a display integer', () => {
    expect(readIcloudDownloadPercent(0)).toBe(0)
    expect(readIcloudDownloadPercent(100)).toBe(100)
    expect(readIcloudDownloadPercent(37)).toBe(37)
    expect(readIcloudDownloadPercent(37.4)).toBe(37)
    expect(readIcloudDownloadPercent(37.5)).toBe(38)
  })

  it('omits missing or illegal values instead of inventing progress', () => {
    for (const value of [
      undefined,
      null,
      NaN,
      Infinity,
      -Infinity,
      -0.1,
      100.1,
      '37',
      { percent: 37 },
      true
    ]) {
      expect(readIcloudDownloadPercent(value)).toBeUndefined()
    }
  })
})

describe('toIcloudDownloadProgressEvent', () => {
  it('includes percent only when it is a real 0–100 value', () => {
    expect(toIcloudDownloadProgressEvent('req', 'song.mp3', 'downloading', 37)).toEqual({
      requestId: 'req',
      relative: 'song.mp3',
      state: 'downloading',
      percent: 37
    })
    expect(toIcloudDownloadProgressEvent('req', 'song.mp3', 'downloading', Number.NaN)).toEqual({
      requestId: 'req',
      relative: 'song.mp3',
      state: 'downloading'
    })
    expect(toIcloudDownloadProgressEvent('req', 'song.mp3', 'waiting')).toEqual({
      requestId: 'req',
      relative: 'song.mp3',
      state: 'waiting'
    })
  })
})
