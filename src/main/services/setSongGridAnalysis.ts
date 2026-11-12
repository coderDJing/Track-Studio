import type { ISongInfo } from '../../types/globals'
import { resolveCanonicalSongBeatGridV2 } from '../../shared/songAnalysisCompleteness'

// source 必须来自已通过音频 size/mtime 校验的缓存，SET 条目快照不保存网格。
export const mergeSetSongGridAnalysis = (
  target: ISongInfo,
  source: Partial<ISongInfo>
): ISongInfo => {
  if (resolveCanonicalSongBeatGridV2(target).kind !== 'missing') return target
  const grid = resolveCanonicalSongBeatGridV2(source)
  if (grid.kind === 'missing') return target
  const next = { ...target }
  delete next.bpm
  delete next.firstBeatMs
  delete next.downbeatBeatOffset
  delete next.beatGridSource
  delete next.beatGridStatus
  delete next.beatGridMap
  delete next.beatGridAnalysisMode
  delete next.beatGridResultShape
  delete next.beatGridPolicyVersion
  delete next.timeBasisOffsetMs
  delete next.timeBasisOffsetAlgorithmVersion
  if (grid.kind === 'grid') {
    next.beatGridMap = grid.beatGridMap
    next.timeBasisOffsetMs = source.timeBasisOffsetMs
    next.timeBasisOffsetAlgorithmVersion = source.timeBasisOffsetAlgorithmVersion
    if (source.beatGridAnalysisMode) next.beatGridAnalysisMode = source.beatGridAnalysisMode
    if (source.beatGridResultShape) next.beatGridResultShape = source.beatGridResultShape
    if (source.beatGridPolicyVersion) next.beatGridPolicyVersion = source.beatGridPolicyVersion
  } else {
    next.beatGridStatus = 'no-bpm'
  }
  next.beatGridAlgorithmVersion = source.beatGridAlgorithmVersion
  return next
}
