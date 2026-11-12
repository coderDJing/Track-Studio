import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ANALYSIS_GRID_MODE,
  DYNAMIC_ANALYSIS_GRID_RELEASE_ENABLED,
  isAnalysisGridMode,
  isAnalysisGridModeSupported,
  isDynamicAnalysisGridAvailable,
  isDynamicGridReanalysis,
  normalizeAnalysisGridMode,
  resolveAnalysisGridMode,
  resolveGridReanalysisClearPlan,
  resolveGridReanalysisTargets,
  shouldForceGridReanalysis
} from './analysisGridMode'

const FULL_PLAN = {
  key: true,
  beatGrid: true,
  waveform: true,
  energy: true,
  structure: true
}

describe('analysisGridMode', () => {
  it('defaults to normal when nothing is stored', () => {
    expect(DEFAULT_ANALYSIS_GRID_MODE).toBe('normal')
    expect(normalizeAnalysisGridMode(undefined)).toBe('normal')
    expect(normalizeAnalysisGridMode('unexpected')).toBe('normal')
  })

  it('accepts only the two known modes', () => {
    expect(isAnalysisGridMode('normal')).toBe(true)
    expect(isAnalysisGridMode('dynamic')).toBe(true)
    expect(isAnalysisGridMode('auto')).toBe(false)
    expect(isAnalysisGridMode(null)).toBe(false)
  })

  it('keeps the provided default mode instead of overriding to normal', () => {
    expect(normalizeAnalysisGridMode(undefined, 'dynamic')).toBe('dynamic')
    expect(normalizeAnalysisGridMode('broken', 'dynamic')).toBe('dynamic')
    expect(normalizeAnalysisGridMode('normal', 'dynamic')).toBe('normal')
  })

  it('resolves the first valid candidate in order', () => {
    expect(resolveAnalysisGridMode(undefined, 'dynamic', 'normal')).toBe('dynamic')
    expect(resolveAnalysisGridMode(undefined, null, 'normal')).toBe('normal')
    expect(resolveAnalysisGridMode(undefined, undefined)).toBe('normal')
  })

  it('enables dynamic in packaged release through the release switch', () => {
    expect(DYNAMIC_ANALYSIS_GRID_RELEASE_ENABLED).toBe(true)
    expect(isDynamicAnalysisGridAvailable({ isDevelopment: true })).toBe(true)
    expect(isDynamicAnalysisGridAvailable({ isDevelopment: false })).toBe(true)
    expect(isAnalysisGridModeSupported('dynamic', { isDevelopment: false })).toBe(true)
    expect(isAnalysisGridModeSupported('normal', { isDevelopment: false })).toBe(true)
  })

  it('only treats dynamic grid requests as dynamic reanalysis', () => {
    expect(isDynamicGridReanalysis(FULL_PLAN, 'dynamic')).toBe(true)
    expect(isDynamicGridReanalysis(FULL_PLAN, 'normal')).toBe(false)
    expect(isDynamicGridReanalysis({ ...FULL_PLAN, beatGrid: false }, 'dynamic')).toBe(false)
  })

  it('keeps the old grid for normal reanalysis but preserves it for dynamic', () => {
    expect(resolveGridReanalysisClearPlan(FULL_PLAN, 'normal')).toEqual(FULL_PLAN)
    expect(resolveGridReanalysisClearPlan(FULL_PLAN, 'dynamic')).toEqual({
      key: true,
      beatGrid: false,
      waveform: true,
      energy: false,
      structure: false
    })
  })

  it('forces bpm but only isolates structure for dynamic reanalysis', () => {
    expect(resolveGridReanalysisTargets(FULL_PLAN, 'normal')).toEqual({
      key: true,
      bpm: true,
      waveform: true,
      energy: true,
      structure: true
    })
    expect(resolveGridReanalysisTargets(FULL_PLAN, 'dynamic')).toEqual({
      key: true,
      bpm: true,
      waveform: true,
      energy: true,
      structure: false
    })
    expect(
      resolveGridReanalysisTargets({ ...FULL_PLAN, structure: false, energy: false }, 'dynamic')
    ).toEqual({
      key: true,
      bpm: true,
      waveform: true,
      energy: false,
      structure: false
    })
    expect(shouldForceGridReanalysis(FULL_PLAN, 'dynamic')).toBe(true)
    expect(shouldForceGridReanalysis(FULL_PLAN, 'normal')).toBe(false)
  })

  it('supports dynamic requests without touching normal when the release switch is on', () => {
    expect(isAnalysisGridModeSupported('normal', { isDevelopment: false })).toBe(true)
    expect(isAnalysisGridModeSupported('dynamic', { isDevelopment: true })).toBe(true)
    expect(isAnalysisGridModeSupported('dynamic', { isDevelopment: false })).toBe(true)
  })
})
