import { describe, expect, it } from 'vitest'
import {
  DYNAMIC_GRID_PHASE_LABEL_KEYS,
  normalizeDynamicGridPublicProgress
} from './dynamicGridProgress'

describe('normalizeDynamicGridPublicProgress', () => {
  it('keeps only the public phase and counters', () => {
    expect(
      normalizeDynamicGridPublicProgress({
        phase: 'refine',
        completedWindows: 12,
        totalWindows: 40,
        coveredAudioSec: 180.5,
        sidecarPid: 4242,
        windows: [{ startSec: 0 }]
      })
    ).toEqual({
      phase: 'refine',
      completedWindows: 12,
      totalWindows: 40,
      coveredAudioSec: 180.5
    })
  })

  it('never exposes sidecar pid or implementation details', () => {
    const progress = normalizeDynamicGridPublicProgress({ phase: 'scan', sidecarPid: 9988 })
    expect(progress).toEqual({ phase: 'scan' })
    expect(Object.keys(progress || {})).toEqual(['phase'])
  })

  it('rejects unknown phases and invalid numbers', () => {
    expect(normalizeDynamicGridPublicProgress(undefined)).toBeUndefined()
    expect(normalizeDynamicGridPublicProgress({ phase: 'seam' })).toBeUndefined()
    expect(normalizeDynamicGridPublicProgress({ phase: 'scan', completedWindows: -1 })).toEqual({
      phase: 'scan'
    })
    expect(normalizeDynamicGridPublicProgress({ phase: 'scan', totalWindows: 4.2 })).toEqual({
      phase: 'scan'
    })
    expect(
      normalizeDynamicGridPublicProgress({ phase: 'scan', coveredAudioSec: Number.NaN })
    ).toEqual({ phase: 'scan' })
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -3],
    ['decimal', 2.5],
    ['string', '7']
  ])('drops invalid %s counts instead of guessing', (_label, invalidValue) => {
    expect(
      normalizeDynamicGridPublicProgress({
        phase: 'refine',
        completedWindows: invalidValue,
        totalWindows: 10
      })
    ).toEqual({ phase: 'refine', totalWindows: 10 })
    expect(
      normalizeDynamicGridPublicProgress({
        phase: 'refine',
        completedWindows: 2,
        totalWindows: invalidValue
      })
    ).toEqual({ phase: 'refine', completedWindows: 2 })
  })

  it('drops both counters when completed exceeds total', () => {
    expect(
      normalizeDynamicGridPublicProgress({
        phase: 'scan',
        completedWindows: 12,
        totalWindows: 10,
        sidecarPid: 777
      })
    ).toEqual({ phase: 'scan' })
  })

  it('keeps valid zero counters', () => {
    expect(
      normalizeDynamicGridPublicProgress({
        phase: 'scan',
        completedWindows: 0,
        totalWindows: 0
      })
    ).toEqual({ phase: 'scan', completedWindows: 0, totalWindows: 0 })
  })

  it('provides translation keys for every public phase', () => {
    expect(Object.keys(DYNAMIC_GRID_PHASE_LABEL_KEYS)).toEqual(['scan', 'refine', 'fit', 'persist'])
  })
})
