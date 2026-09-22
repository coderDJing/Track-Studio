import { normalizeSongHotCues } from '../../shared/hotCues'
import { normalizeSongMemoryCues } from '../../shared/memoryCues'
import { hasUsableSongEnergyAnalysis } from '../../shared/songEnergy'
import { hasUsableKeyAnalysis } from '../../shared/songAnalysisCompleteness'
import {
  hasUsableSongStructureAnalysis,
  normalizeSongStructureAnalysis
} from '../../shared/songStructure'
import type { ISongInfo } from '../../types/globals'

const hasPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value && value > 0

export function buildSetAnalysisSnapshot(
  source: Partial<ISongInfo> | null
): Record<string, unknown> | null {
  if (!source) return null
  const snapshot: Record<string, unknown> = {}
  if (hasUsableKeyAnalysis(source)) {
    snapshot.key = source.key
    if (hasPositiveInteger(source.keyAnalysisAlgorithmVersion)) {
      snapshot.keyAnalysisAlgorithmVersion = source.keyAnalysisAlgorithmVersion
    }
  }
  if (hasUsableSongEnergyAnalysis(source)) {
    snapshot.energyScore = source.energyScore
    if (hasPositiveInteger(source.energyAlgorithmVersion)) {
      snapshot.energyAlgorithmVersion = source.energyAlgorithmVersion
    }
    if (source.energyAnalysis) snapshot.energyAnalysis = source.energyAnalysis
  }
  if (hasUsableSongStructureAnalysis(source)) {
    snapshot.songStructure = normalizeSongStructureAnalysis(source.songStructure)
  }
  const hotCues = normalizeSongHotCues(source.hotCues)
  if (hotCues.length > 0) snapshot.hotCues = hotCues
  const memoryCues = normalizeSongMemoryCues(source.memoryCues)
  if (memoryCues.length > 0) snapshot.memoryCues = memoryCues
  return Object.keys(snapshot).length > 0 ? snapshot : null
}
