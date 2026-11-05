import type { AnalysisRuntimeFeature } from '../../shared/analysisRuntimeFeatures'
import {
  clearInstalledStemRuntimes,
  downloadPreferredStemRuntime,
  getPreferredStemRuntimeDownloadInfo,
  getStemRuntimeDownloadState,
  stemRuntimeDownloadEvents,
  type MixtapeStemRuntimeDownloadInfo,
  type MixtapeStemRuntimeDownloadState
} from './mixtapeStemRuntimeDownload'
import { resetBeatThisRuntimeResolution } from '../workers/beatThisRuntime'

type AnalysisRuntimeDownloadInfo = MixtapeStemRuntimeDownloadInfo
export type AnalysisRuntimeDownloadState = MixtapeStemRuntimeDownloadState

export const analysisRuntimeDownloadEvents = stemRuntimeDownloadEvents

export const getPreferredAnalysisRuntimeDownloadInfo = async (
  feature: AnalysisRuntimeFeature = 'analysis'
): Promise<AnalysisRuntimeDownloadInfo> => await getPreferredStemRuntimeDownloadInfo(feature)

export const getAnalysisRuntimeDownloadState = (): AnalysisRuntimeDownloadState =>
  getStemRuntimeDownloadState()

export const downloadPreferredAnalysisRuntime = async (
  feature: AnalysisRuntimeFeature = 'analysis'
): Promise<boolean> => {
  const downloaded = await downloadPreferredStemRuntime(feature)
  if (downloaded) {
    resetBeatThisRuntimeResolution()
  }
  return downloaded
}

export const isAnalysisRuntimeAvailable = async (
  feature: AnalysisRuntimeFeature = 'analysis'
): Promise<boolean> => {
  const preferred = await getPreferredAnalysisRuntimeDownloadInfo(feature)
  return preferred.alreadyAvailable
}

export const clearInstalledAnalysisRuntimes = async () => {
  const result = await clearInstalledStemRuntimes()
  resetBeatThisRuntimeResolution()
  return result
}
