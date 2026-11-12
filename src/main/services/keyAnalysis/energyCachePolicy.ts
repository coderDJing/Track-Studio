import {
  hasUsableSongEnergyAnalysis,
  normalizeSongEnergyScore,
  type SongEnergyAnalysisV5
} from '../../../shared/songEnergy'
import type { SongBeatGridMapV2 } from '../../../shared/songBeatGridMapV2'

export const normalizeEnergySourceGridSignature = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

export const readEnergySourceGridSignature = (info: unknown): string | undefined => {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined
  return normalizeEnergySourceGridSignature(
    (info as { energySourceGridSignature?: unknown }).energySourceGridSignature
  )
}

export type UsableSongEnergy = {
  energyScore: number
  energyAlgorithmVersion?: number
  energyAnalysis?: SongEnergyAnalysisV5
  energySourceGridSignature?: string
}

export type SongEnergyCacheCarrier = {
  energyScore?: unknown
  energyAlgorithmVersion?: unknown
  energyAnalysis?: SongEnergyAnalysisV5
  energySourceGridSignature?: unknown
}

export const resolveUsableSongEnergy = (
  info: SongEnergyCacheCarrier | null | undefined
): UsableSongEnergy | null => {
  if (!hasUsableSongEnergyAnalysis(info)) return null
  const energyScore = normalizeSongEnergyScore(info?.energyScore)
  if (energyScore === undefined) return null
  const version = Number(info?.energyAlgorithmVersion)
  return {
    energyScore,
    energyAlgorithmVersion:
      Number.isFinite(version) && version > 0 ? Math.floor(version) : undefined,
    energyAnalysis: info?.energyAnalysis,
    energySourceGridSignature: readEnergySourceGridSignature(info)
  }
}

// 能量派生结果绑定源网格签名。
// - 有签名：必须与当前网格签名一致。
// - 无签名（旧缓存）：当前仍是单段固定网格时兼容旧行为；
//   当前已是多段 Dynamic map 时，无签名旧能量无法证明其来源，必须视为 stale。
export const isCachedEnergyGridCurrent = (
  info: SongEnergyCacheCarrier | null | undefined,
  currentGridMap: SongBeatGridMapV2 | null | undefined
) => {
  const recorded = readEnergySourceGridSignature(info)
  if (!currentGridMap) return !recorded
  if (recorded) return recorded === currentGridMap.signature
  return currentGridMap.clips.length <= 1
}
