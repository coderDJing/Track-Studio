import type { KeyAnalysisJob } from './types'
import { resolveAudioTimeBasisOffsetMsForFile } from '../audioTimeBasisOffset'
import { resolveAnalysisBpmRange } from '../../../shared/analysisBpmRange'
import { normalizeAnalysisGridMode } from '../../../shared/analysisGridMode'
import { resolveDynamicGridAudioDurationSec } from './dynamicGridAudioDuration'
import { isSqliteReadDiagnosticsEnabled } from '../sqliteReadDiagnostics'

export const buildKeyAnalysisWorkerMessage = async (job: KeyAnalysisJob) => {
  const analysisBpmRange = resolveAnalysisBpmRange(job.analysisBpmRange?.id)
  const analysisGridMode = normalizeAnalysisGridMode(job.analysisGridMode)
  const needsAnalysisTimeBasis =
    job.needsBpm === true && (job.needsStructure === true || analysisGridMode === 'dynamic')
  const analyzedTimeBasisOffsetMs = needsAnalysisTimeBasis
    ? await resolveAudioTimeBasisOffsetMsForFile(job.filePath)
    : undefined
  const audioDurationSec =
    analysisGridMode === 'dynamic' && job.needsBpm === true
      ? await resolveDynamicGridAudioDurationSec({
          filePath: job.filePath,
          probeDurationSec: job.probe?.durationSec
        })
      : undefined
  return {
    jobId: job.jobId,
    diagnostics: isSqliteReadDiagnosticsEnabled(),
    filePath: job.filePath,
    fastAnalysis: job.fastAnalysis,
    needsKey: job.needsKey,
    needsBpm: job.needsBpm,
    needsWaveform: job.needsWaveform,
    needsEnergy: job.needsEnergy,
    needsStructure: job.needsStructure,
    analysisBpmRange,
    analysisGridMode,
    audioDurationSec,
    // 冻结的音频身份，供 worker/持久化侧复核文件未被替换。
    fileSize: job.fileSize,
    fileMtimeMs: job.fileMtimeMs,
    cachedBpm: job.cachedBpm,
    cachedBeatGridMap: job.cachedBeatGridMap,
    cachedUnifiedDisplayWaveformData: job.cachedUnifiedDisplayWaveformData,
    analyzedTimeBasisOffsetMs
  }
}
