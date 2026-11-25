import type { ISongInfo } from '../../../types/globals'
import {
  isSameSongBeatGridQuality,
  normalizeSongBeatGridQuality,
  type SongBeatGridQuality
} from '../../../shared/beatGridQuality'

export type GridAnalysisModeMetadata = 'normal' | 'dynamic'
export type GridResultShapeMetadata = 'fixed' | 'dynamic'

export type GridAnalysisMetadata = {
  mode?: GridAnalysisModeMetadata
  shape?: GridResultShapeMetadata
  policyVersion?: string
  /** 网格质量标记：只在网格有问题时出现。 */
  quality?: SongBeatGridQuality
}

const normalizeMode = (value: unknown): GridAnalysisModeMetadata | undefined =>
  value === 'normal' || value === 'dynamic' ? value : undefined

const normalizeShape = (value: unknown): GridResultShapeMetadata | undefined =>
  value === 'fixed' || value === 'dynamic' ? value : undefined

const normalizePolicy = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

export const readGridAnalysisMetadata = (info: unknown): GridAnalysisMetadata => {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return {}
  const carrier = info as Partial<ISongInfo>
  const mode = normalizeMode(carrier.beatGridAnalysisMode)
  const shape = normalizeShape(carrier.beatGridResultShape)
  const policyVersion = normalizePolicy(carrier.beatGridPolicyVersion)
  const quality = normalizeSongBeatGridQuality(carrier.beatGridQuality)
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(shape === undefined ? {} : { shape }),
    ...(policyVersion === undefined ? {} : { policyVersion }),
    ...(quality === undefined ? {} : { quality })
  }
}

export const isSameGridAnalysisMetadata = (
  left: GridAnalysisMetadata,
  right: GridAnalysisMetadata
) =>
  left.mode === right.mode &&
  left.shape === right.shape &&
  left.policyVersion === right.policyVersion &&
  isSameSongBeatGridQuality(left.quality, right.quality)

/**
 * 写入共享歌曲定义。字段缺失时删除，避免“空补丁”在旧记录里反复出现。
 */
export const applyGridAnalysisMetadata = (info: ISongInfo, metadata: GridAnalysisMetadata) => {
  if (metadata.mode) info.beatGridAnalysisMode = metadata.mode
  else delete info.beatGridAnalysisMode
  if (metadata.shape) info.beatGridResultShape = metadata.shape
  else delete info.beatGridResultShape
  if (metadata.policyVersion) info.beatGridPolicyVersion = metadata.policyVersion
  else delete info.beatGridPolicyVersion
  if (metadata.quality) info.beatGridQuality = metadata.quality
  else delete info.beatGridQuality
  return info
}
