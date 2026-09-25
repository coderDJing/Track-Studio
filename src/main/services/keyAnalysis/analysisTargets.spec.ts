import { describe, expect, it } from 'vitest'
import {
  hasUncoveredForcedReanalysisTarget,
  resolveInitialAnalysisNeeds,
  shouldSkipEnergyWithoutPreparedGrid,
  shouldSkipStructureWithoutPreparedGrid
} from './analysisTargets'

describe('key analysis reanalysis targets', () => {
  it('只强制勾选的项，未勾选项即使缺失也不补算', () => {
    const needs = resolveInitialAnalysisNeeds({
      includeStructure: true,
      analysisTargets: { key: true, energy: true }
    })
    expect(needs).toMatchObject({
      needsKey: true,
      needsBpm: true,
      needsWaveform: false,
      needsEnergy: true,
      needsStructure: false,
      forceKey: false,
      forceBpm: false,
      forceEnergy: false,
      forceStructure: false
    })
  })

  it('勾选网格和段落时只处理这两项，未勾选不强制覆盖缓存', () => {
    const needs = resolveInitialAnalysisNeeds({
      includeStructure: true,
      analysisTargets: { bpm: true, structure: true }
    })
    expect(needs.needsBpm).toBe(true)
    expect(needs.needsStructure).toBe(true)
    expect(needs.forceBpm).toBe(false)
    expect(needs.forceStructure).toBe(false)
  })

  it('只勾段落时只处理段落', () => {
    const needs = resolveInitialAnalysisNeeds({
      includeStructure: true,
      analysisTargets: { structure: true }
    })
    expect(needs).toMatchObject({
      needsKey: false,
      needsBpm: false,
      needsWaveform: false,
      needsEnergy: false,
      needsStructure: true,
      forceStructure: false,
      forceBpm: false
    })
  })

  it('forceAnalysis 仍按完整五项处理', () => {
    const needs = resolveInitialAnalysisNeeds({
      forceAnalysis: true,
      includeStructure: true,
      analysisTargets: { key: true }
    })
    expect(needs.needsKey).toBe(true)
    expect(needs.needsBpm).toBe(true)
    expect(needs.needsWaveform).toBe(true)
    expect(needs.needsEnergy).toBe(true)
    expect(needs.needsStructure).toBe(true)
    expect(needs.forceKey).toBe(true)
    expect(needs.forceBpm).toBe(true)
  })

  it('没有已准备网格且不重算网格时，必须跳过段落', () => {
    expect(shouldSkipStructureWithoutPreparedGrid(true, false, false)).toBe(true)
    expect(shouldSkipStructureWithoutPreparedGrid(true, true, false)).toBe(false)
    expect(shouldSkipStructureWithoutPreparedGrid(true, false, true)).toBe(false)
    expect(shouldSkipStructureWithoutPreparedGrid(false, false, false)).toBe(false)
  })

  it('没有已准备网格且不重算网格时，必须跳过能量', () => {
    expect(shouldSkipEnergyWithoutPreparedGrid(true, false, false)).toBe(true)
    expect(shouldSkipEnergyWithoutPreparedGrid(true, true, false)).toBe(false)
    expect(shouldSkipEnergyWithoutPreparedGrid(true, false, true)).toBe(false)
    expect(shouldSkipEnergyWithoutPreparedGrid(false, false, false)).toBe(false)
  })

  it('进行中的补缺任务不能覆盖强制重算', () => {
    expect(
      hasUncoveredForcedReanalysisTarget(
        { includeStructure: true },
        { analysisTargets: { key: true } }
      )
    ).toBe(true)
    expect(
      hasUncoveredForcedReanalysisTarget(
        { forceAnalysis: true, includeStructure: true },
        { analysisTargets: { key: true } }
      )
    ).toBe(false)
  })
})
