import { CURRENT_SONG_ENERGY_ALGORITHM_VERSION } from '../../shared/songEnergy'
import {
  UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
  UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION
} from '../../shared/unifiedDisplayWaveform'
import {
  WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION,
  WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
  WAVEFORM_SURFACE_CACHE_VERSION
} from '../../shared/waveformSurfaceCache'
import { CURRENT_BEAT_GRID_ALGORITHM_VERSION } from './beatGridAlgorithmVersion'
import { CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION } from './keyAnalysisAlgorithmVersion'

/**
 * 随包预置的示例分析结果只在版本完全一致时可用。
 * 任何算法/缓存版本变化都会让旧 seed 失效，必须重新导出。
 */
export type DemoAnalysisSeedVersions = {
  waveformSurfaceCacheVersion: number
  waveformListPreviewParameterVersion: number
  waveformGlobalOverviewParameterVersion: number
  unifiedDisplayWaveformCacheVersion: number
  unifiedDisplayWaveformParameterVersion: number
  beatGridAlgorithmVersion: number
  keyAnalysisAlgorithmVersion: number
  songEnergyAlgorithmVersion: number
}

export const DEMO_ANALYSIS_SEED_META_KEYS = [
  'waveformSurfaceCacheVersion',
  'waveformListPreviewParameterVersion',
  'waveformGlobalOverviewParameterVersion',
  'unifiedDisplayWaveformCacheVersion',
  'unifiedDisplayWaveformParameterVersion',
  'beatGridAlgorithmVersion',
  'keyAnalysisAlgorithmVersion',
  'songEnergyAlgorithmVersion'
] as const satisfies ReadonlyArray<keyof DemoAnalysisSeedVersions>

export const getDemoAnalysisSeedVersions = (): DemoAnalysisSeedVersions => ({
  waveformSurfaceCacheVersion: WAVEFORM_SURFACE_CACHE_VERSION,
  waveformListPreviewParameterVersion: WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
  waveformGlobalOverviewParameterVersion: WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION,
  unifiedDisplayWaveformCacheVersion: UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
  unifiedDisplayWaveformParameterVersion: UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
  beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION,
  keyAnalysisAlgorithmVersion: CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION,
  songEnergyAlgorithmVersion: CURRENT_SONG_ENERGY_ALGORITHM_VERSION
})

export const assertDemoAnalysisSeedVersions = (
  readMeta: (key: string) => string | null
): DemoAnalysisSeedVersions | null => {
  const expected = getDemoAnalysisSeedVersions()
  for (const key of DEMO_ANALYSIS_SEED_META_KEYS) {
    const raw = readMeta(key)
    if (raw === null) return null
    const value = Number(raw)
    if (!Number.isFinite(value) || value !== expected[key]) return null
  }
  return expected
}
