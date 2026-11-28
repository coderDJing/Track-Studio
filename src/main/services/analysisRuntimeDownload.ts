import type { AnalysisRuntimeFeature } from '../../shared/analysisRuntimeFeatures'
import { resetBeatThisRuntimeResolution } from '../workers/beatThisRuntime'
import {
  getStemRuntimeDownloadState,
  stemRuntimeDownloadEvents,
  type MixtapeStemRuntimeDownloadInfo,
  type MixtapeStemRuntimeDownloadState
} from './mixtapeStemRuntimeDownloadState'

type AnalysisRuntimeDownloadInfo = MixtapeStemRuntimeDownloadInfo
export type AnalysisRuntimeDownloadState = MixtapeStemRuntimeDownloadState

export const analysisRuntimeDownloadEvents = stemRuntimeDownloadEvents

const loadStemRuntimeDownload = () => import('./mixtapeStemRuntimeDownload')

export const getPreferredAnalysisRuntimeDownloadInfo = async (
  feature: AnalysisRuntimeFeature = 'analysis'
): Promise<AnalysisRuntimeDownloadInfo> => {
  const { getPreferredStemRuntimeDownloadInfo } = await loadStemRuntimeDownload()
  return await getPreferredStemRuntimeDownloadInfo(feature)
}

export const getAnalysisRuntimeDownloadState = (): AnalysisRuntimeDownloadState =>
  getStemRuntimeDownloadState()

export const downloadPreferredAnalysisRuntime = async (
  feature: AnalysisRuntimeFeature = 'analysis'
): Promise<boolean> => {
  const { downloadPreferredStemRuntime } = await loadStemRuntimeDownload()
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
  const { clearInstalledStemRuntimes } = await loadStemRuntimeDownload()
  const result = await clearInstalledStemRuntimes()
  resetBeatThisRuntimeResolution()
  return result
}
