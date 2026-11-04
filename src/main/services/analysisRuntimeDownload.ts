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
  requireBpmFix = false
): Promise<AnalysisRuntimeDownloadInfo> => await getPreferredStemRuntimeDownloadInfo(requireBpmFix)

export const getAnalysisRuntimeDownloadState = (): AnalysisRuntimeDownloadState =>
  getStemRuntimeDownloadState()

export const downloadPreferredAnalysisRuntime = async (requireBpmFix = false): Promise<boolean> => {
  const downloaded = await downloadPreferredStemRuntime(requireBpmFix)
  if (downloaded) {
    resetBeatThisRuntimeResolution()
  }
  return downloaded
}

export const isAnalysisRuntimeAvailable = async (): Promise<boolean> => {
  const preferred = await getPreferredAnalysisRuntimeDownloadInfo()
  if (preferred.alreadyAvailable) return true
  const state = getAnalysisRuntimeDownloadState()
  return state.status === 'ready'
}

export const clearInstalledAnalysisRuntimes = async () => {
  const result = await clearInstalledStemRuntimes()
  resetBeatThisRuntimeResolution()
  return result
}
