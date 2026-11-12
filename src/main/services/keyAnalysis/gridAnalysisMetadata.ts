import type { ISongInfo } from '../../../types/globals'

export type GridAnalysisModeMetadata = 'normal' | 'dynamic'
export type GridResultShapeMetadata = 'fixed' | 'dynamic'

export type GridAnalysisMetadata = {
  mode?: GridAnalysisModeMetadata
  shape?: GridResultShapeMetadata
  policyVersion?: string
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
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(shape === undefined ? {} : { shape }),
    ...(policyVersion === undefined ? {} : { policyVersion })
  }
}

export const isSameGridAnalysisMetadata = (
  left: GridAnalysisMetadata,
  right: GridAnalysisMetadata
) =>
  left.mode === right.mode &&
  left.shape === right.shape &&
  left.policyVersion === right.policyVersion

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
  return info
}
