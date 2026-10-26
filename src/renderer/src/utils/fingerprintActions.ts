import { t } from '@renderer/utils/translate'
import { RendererFilePathSet } from '@renderer/utils/filePathComparison'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'

type FingerprintActionOrigin = 'player' | 'selection' | 'playlist' | 'rekordboxLibrary'

interface AnalyzeOptions {
  origin?: FingerprintActionOrigin
}

type ErrorLike = {
  message?: unknown
}

const normalizePaths = (paths: string[]): string[] => {
  return Array.from(
    new RendererFilePathSet(
      (paths || []).map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0)
    )
  )
}

export const analyzeFingerprintsForPaths = async (
  filePaths: string[],
  options?: AnalyzeOptions
) => {
  const runtime = useRuntimeStore()
  const normalized = normalizePaths(filePaths)

  if (normalized.length === 0) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('fingerprints.noTracksSelected')],
      confirmShow: false
    })
    return
  }

  if (runtime.isProgressing) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }

  runtime.isProgressing = true
  try {
    await window.electron.ipcRenderer.invoke('fingerprints:addExistingFromPaths', {
      filePaths: normalized,
      origin: options?.origin || 'selection'
    })
  } catch (error) {
    runtime.isProgressing = false
    let message: string
    const detail = error && typeof error === 'object' ? (error as ErrorLike) : null
    const errorMessage = String(detail?.message || '')
    if (errorMessage === 'NO_ELIGIBLE_AUDIO') {
      message = t('fingerprints.noEligibleTracks')
    } else if (errorMessage === 'FINGERPRINT_TASK_RUNNING') {
      message = t('import.waitForTask')
    } else {
      message = errorMessage || t('common.unknownError')
    }
    await confirm({
      title: t('common.error'),
      content: [message],
      confirmShow: false
    })
  }
}

export default analyzeFingerprintsForPaths
