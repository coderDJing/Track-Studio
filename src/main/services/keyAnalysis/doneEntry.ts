import type { SongBeatGridMapV2 } from '../../../shared/songBeatGridMapV2'
import type { DoneEntry } from './types'

/**
 * 复用已有 done 记录的非网格字段，只替换网格/版本/文件身份。
 * 统一构造避免多条写入路径各自维护一份字段列表而漏字段。
 */
export const buildDoneEntry = (params: {
  existing?: DoneEntry
  size: number
  mtimeMs: number
  beatGridMap?: SongBeatGridMapV2 | null
  beatGridAlgorithmVersion: number
}): DoneEntry => {
  const existing = params.existing
  return {
    size: params.size,
    mtimeMs: params.mtimeMs,
    keyText: existing?.keyText,
    keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
    beatGridAlgorithmVersion: params.beatGridAlgorithmVersion,
    beatGridMap: params.beatGridMap ?? existing?.beatGridMap,
    energyScore: existing?.energyScore,
    energyAlgorithmVersion: existing?.energyAlgorithmVersion,
    energyAnalysis: existing?.energyAnalysis,
    energySourceGridSignature: existing?.energySourceGridSignature,
    songStructure: existing?.songStructure,
    hasWaveform: existing?.hasWaveform
  }
}
