import { describe, expect, it } from 'vitest'
import {
  isValidPioneerUsbLoopBeatPair,
  normalizePioneerUsbLoopBeatFields
} from './pioneerUsbLoopBeats'

describe('native quantized loop beat representation', () => {
  it('accepts manual loops and the observed power-of-two beat sizes', () => {
    for (const [numerator, denominator] of [
      [0, 0],
      [8, 1],
      [1, 2],
      [32768, 1],
      [1, 32768]
    ])
      expect(isValidPioneerUsbLoopBeatPair(numerator, denominator)).toBe(true)
  })

  it('rejects unsupported, incomplete, nonnumeric and overflowing pairs', () => {
    for (const [numerator, denominator] of [
      [3, 1],
      [16, 2],
      [0, 1],
      [1, 0],
      [1.5, 1],
      [65536, 1],
      ['8', 1],
      [null, null],
      [8, undefined]
    ])
      expect(isValidPioneerUsbLoopBeatPair(numerator, denominator)).toBe(false)
  })

  it('keeps loop metadata and drops it when a saved loop becomes a plain point', () => {
    const ratio = { loopNumerator: 8, loopDenominator: 1 }
    expect(normalizePioneerUsbLoopBeatFields(ratio, true)).toEqual(ratio)
    expect(normalizePioneerUsbLoopBeatFields(ratio, false)).toEqual({})
    expect(normalizePioneerUsbLoopBeatFields({ loopNumerator: 8 }, true)).toEqual({})
  })
})
