import type { AnalysisRuntimeFeature } from '@shared/analysisRuntimeFeatures'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  formatAnalysisRuntimeBytes,
  isAnalysisRuntimeDownloadActiveStatus
} from '@renderer/utils/analysisRuntimeDownloadUi'

type TranslateFn = (key: string, params?: Record<string, unknown>) => string
type ConfirmDialogFn = typeof import('@renderer/components/confirmDialog').default

type AnalysisRuntimePromptSource = 'help' | 'horizontal' | 'stem' | 'bpm-fix' | 'analysis'
type AnalysisRuntimePromptResult = 'ready' | 'started' | 'blocked' | 'handled'

type AnalysisRuntimeDownloadStatus =
  'idle' | 'available' | 'downloading' | 'extracting' | 'ready' | 'failed'

type AnalysisRuntimeDownloadState = {
  status: AnalysisRuntimeDownloadStatus
  profile: string
  runtimeKey: string
  version: string
  percent: number
  downloadedBytes: number
  totalBytes: number
  archiveSize: number
  title: string
  message: string
  error: string
  updatedAt: number
}

type AnalysisRuntimePreferredInfo = {
  supported: boolean
  downloadable: boolean
  alreadyAvailable: boolean
  profile: string
  runtimeKey: string
  version: string
  archiveSize: number
  title: string
  reason: string
  manifestUrl: string
  releaseTag: string
  error: string
}

const normalizeAnalysisRuntimeDownloadStatus = (value: unknown): AnalysisRuntimeDownloadStatus => {
  return value === 'available' ||
    value === 'downloading' ||
    value === 'extracting' ||
    value === 'ready' ||
    value === 'failed'
    ? value
    : 'idle'
}

const normalizeAnalysisRuntimeDownloadState = (value: unknown): AnalysisRuntimeDownloadState => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    status: normalizeAnalysisRuntimeDownloadStatus(raw.status),
    profile: typeof raw.profile === 'string' ? raw.profile.trim() : '',
    runtimeKey: typeof raw.runtimeKey === 'string' ? raw.runtimeKey.trim() : '',
    version: typeof raw.version === 'string' ? raw.version.trim() : '',
    percent: Math.max(0, Math.min(100, Math.round((Number(raw.percent) || 0) * 10) / 10)),
    downloadedBytes: Math.max(0, Number(raw.downloadedBytes) || 0),
    totalBytes: Math.max(0, Number(raw.totalBytes) || 0),
    archiveSize: Math.max(0, Number(raw.archiveSize) || 0),
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    message: typeof raw.message === 'string' ? raw.message.trim() : '',
    error: typeof raw.error === 'string' ? raw.error.trim() : '',
    updatedAt: Math.max(0, Math.floor(Number(raw.updatedAt) || 0))
  }
}

const normalizeAnalysisRuntimePreferredInfo = (value: unknown): AnalysisRuntimePreferredInfo => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    supported: raw.supported === true,
    downloadable: raw.downloadable === true,
    alreadyAvailable: raw.alreadyAvailable === true,
    profile: typeof raw.profile === 'string' ? raw.profile.trim() : '',
    runtimeKey: typeof raw.runtimeKey === 'string' ? raw.runtimeKey.trim() : '',
    version: typeof raw.version === 'string' ? raw.version.trim() : '',
    archiveSize: Math.max(0, Number(raw.archiveSize) || 0),
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
    manifestUrl: typeof raw.manifestUrl === 'string' ? raw.manifestUrl.trim() : '',
    releaseTag: typeof raw.releaseTag === 'string' ? raw.releaseTag.trim() : '',
    error: typeof raw.error === 'string' ? raw.error.trim() : ''
  }
}

type AnalysisRuntimeStatusResponse = {
  preferred?: unknown
  state?: unknown
}

const normalizeAnalysisRuntimeStatusResponse = (value: unknown): AnalysisRuntimeStatusResponse => {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    preferred: record.preferred,
    state: record.state
  }
}

// 模块级 mutex，防止多个 composable 实例同时弹出提示
let analysisRuntimePromptBusy = false
let analysisRuntimeStatusRequestPromise: Promise<AnalysisRuntimeStatusResponse> | null = null

// 功能名与 i18n key 的映射：i18n 里用 camelCase，避免 key 中出现连字符
const FEATURE_LABEL_KEY: Record<AnalysisRuntimeFeature, string> = {
  analysis: 'analysis',
  horizontal: 'horizontal',
  stem: 'stem',
  'bpm-fix': 'bpmFix'
}

const isHelpPromptSource = (source: AnalysisRuntimePromptSource) => source === 'help'

const resolvePromptFeature = (source: AnalysisRuntimePromptSource): AnalysisRuntimeFeature =>
  source === 'horizontal' || source === 'stem' || source === 'bpm-fix' ? source : 'analysis'

const requestAnalysisRuntimeStatus = async () => {
  if (analysisRuntimeStatusRequestPromise) return await analysisRuntimeStatusRequestPromise
  analysisRuntimeStatusRequestPromise = window.electron.ipcRenderer
    .invoke('analysis-runtime:get-status')
    .then(normalizeAnalysisRuntimeStatusResponse)
    .finally(() => {
      analysisRuntimeStatusRequestPromise = null
    })
  return await analysisRuntimeStatusRequestPromise
}

export const useAnalysisRuntimeDownload = (options: {
  runtime: ReturnType<typeof useRuntimeStore>
  t: TranslateFn
  confirmDialog: ConfirmDialogFn
}) => {
  let analysisRuntimeDownloadProgressHintAt = 0

  const resolveFeatureLabel = (feature: AnalysisRuntimeFeature) =>
    options.t(`analysisRuntime.feature.label.${FEATURE_LABEL_KEY[feature]}`)

  const showAnalysisRuntimeDownloadInProgressHint = async (source: AnalysisRuntimePromptSource) => {
    const now = Date.now()
    if (now - analysisRuntimeDownloadProgressHintAt < 1200) return
    analysisRuntimeDownloadProgressHintAt = now
    const state = options.runtime.analysisRuntime.state
    const title = state.title
      ? options.t('analysisRuntime.downloadInProgressTitle', { title: state.title })
      : options.t('analysisRuntime.downloadInProgressTitleGeneric')
    const featureHint = isHelpPromptSource(source)
      ? options.t('analysisRuntime.downloadInProgressHintGeneric')
      : options.t('analysisRuntime.downloadInProgressHint', {
          feature: resolveFeatureLabel(resolvePromptFeature(source))
        })
    await options.confirmDialog({
      title,
      content: [featureHint, options.t('analysisRuntime.downloadInProgressProgressHint')],
      confirmShow: false,
      textAlign: 'left',
      innerWidth: 560,
      innerHeight: 0
    })
  }

  const applyAnalysisRuntimeStatus = (params: { preferred?: unknown; state?: unknown }) => {
    const preferred = normalizeAnalysisRuntimePreferredInfo(params.preferred)
    const state = normalizeAnalysisRuntimeDownloadState(params.state)
    options.runtime.analysisRuntime.preferred = preferred
    options.runtime.analysisRuntime.state = state
    options.runtime.analysisRuntime.available = preferred.alreadyAvailable
    if (
      !options.runtime.analysisRuntime.available &&
      options.runtime.mainWindowBrowseMode !== 'browser'
    ) {
      options.runtime.mainWindowBrowseMode = 'browser'
    }
    return {
      preferred,
      state
    }
  }

  const refreshAnalysisRuntimeStatus = async () => {
    const response = await requestAnalysisRuntimeStatus()
    return applyAnalysisRuntimeStatus({
      preferred: response?.preferred,
      state: response?.state
    })
  }

  const refreshAnalysisRuntimeStatusAfterInstall = async () => {
    try {
      await refreshAnalysisRuntimeStatus()
    } catch (error) {
      console.error('[analysis-runtime] 安装后检查组件状态失败', error)
    }
  }

  const resolvePromptResultFromCurrentState = (): AnalysisRuntimePromptResult => {
    if (options.runtime.analysisRuntime.available) return 'ready'
    const status = options.runtime.analysisRuntime.state.status
    if (status === 'downloading' || status === 'extracting') return 'started'
    return 'blocked'
  }

  const promptAnalysisRuntimeDownload = async (
    source: AnalysisRuntimePromptSource
  ): Promise<AnalysisRuntimePromptResult> => {
    const feature: AnalysisRuntimeFeature = resolvePromptFeature(source)
    const isHelp = isHelpPromptSource(source)
    const featureLabel = resolveFeatureLabel(feature)
    const isFeatureRequest = feature !== 'analysis'
    if (!isFeatureRequest && options.runtime.analysisRuntime.available) return 'ready'
    if (analysisRuntimePromptBusy) {
      const currentResult = isFeatureRequest
        ? isAnalysisRuntimeDownloadActiveStatus(options.runtime.analysisRuntime.state.status)
          ? 'started'
          : 'blocked'
        : resolvePromptResultFromCurrentState()
      if (currentResult === 'started') {
        await showAnalysisRuntimeDownloadInProgressHint(source)
      }
      return currentResult
    }
    analysisRuntimePromptBusy = true
    try {
      const featureStatus = isFeatureRequest
        ? normalizeAnalysisRuntimeStatusResponse(
            await window.electron.ipcRenderer.invoke('analysis-runtime:get-status', feature)
          )
        : null
      const { preferred, state } = featureStatus
        ? {
            preferred: normalizeAnalysisRuntimePreferredInfo(featureStatus.preferred),
            state: normalizeAnalysisRuntimeDownloadState(featureStatus.state)
          }
        : await refreshAnalysisRuntimeStatus()
      if (preferred.alreadyAvailable) return 'ready'
      if (isAnalysisRuntimeDownloadActiveStatus(state.status)) {
        await showAnalysisRuntimeDownloadInProgressHint(source)
        return 'started'
      }

      if (!preferred.supported) {
        await options.confirmDialog({
          title: options.t('analysisRuntime.unsupportedTitle'),
          content: [
            isHelp
              ? options.t('analysisRuntime.unsupportedHint')
              : options.t('analysisRuntime.unsupportedHintFeature', { feature: featureLabel })
          ],
          confirmShow: false,
          textAlign: 'left',
          innerWidth: 560,
          innerHeight: 0
        })
        return 'blocked'
      }

      if (preferred.reason === 'manifest unavailable') {
        const content = [
          options.t('analysisRuntime.manifestUnavailableHint'),
          options.t('mixtape.stemRuntimeNetworkHint')
        ]
        if (preferred.error) {
          content.push(options.t('analysisRuntime.downloadErrorHint', { error: preferred.error }))
        }
        await options.confirmDialog({
          title: options.t('analysisRuntime.unsupportedTitle'),
          content,
          confirmShow: false,
          textAlign: 'left',
          innerWidth: 560,
          innerHeight: 0
        })
        return 'blocked'
      }

      if (preferred.reason === 'bpm fix asset unavailable') {
        await options.confirmDialog({
          title: options.t('analysisRuntime.unsupportedTitle'),
          content: [options.t('bpmFix.componentUpdateUnavailable')],
          confirmShow: false,
          innerHeight: 0,
          textAlign: 'left'
        })
        return 'handled'
      }
      if (!preferred.downloadable || !preferred.profile) return 'blocked'

      const confirmResult = await options.confirmDialog({
        title: isHelp
          ? options.t('analysisRuntime.promptTitleHelp')
          : options.t('analysisRuntime.promptTitleFeature', { feature: featureLabel }),
        content: [
          isHelp
            ? options.t('analysisRuntime.promptBody', {
                title: preferred.title,
                size: formatAnalysisRuntimeBytes(preferred.archiveSize)
              })
            : options.t(
                options.runtime.analysisRuntime.available
                  ? 'analysisRuntime.featureUpdateBody'
                  : 'analysisRuntime.promptBodyFeature',
                {
                  feature: featureLabel,
                  title: preferred.title,
                  size: formatAnalysisRuntimeBytes(preferred.archiveSize)
                }
              ),
          options.t('analysisRuntime.promptHint')
        ],
        confirmShow: true,
        confirmText: options.t('analysisRuntime.downloadNow'),
        cancelText: options.t('analysisRuntime.downloadLater'),
        textAlign: 'left',
        innerWidth: 560,
        innerHeight: 0
      })
      if (confirmResult !== 'confirm') return source === 'bpm-fix' ? 'handled' : 'blocked'

      const response = await window.electron.ipcRenderer.invoke(
        'analysis-runtime:download-preferred',
        feature
      )
      const next = applyAnalysisRuntimeStatus({
        preferred: isFeatureRequest ? options.runtime.analysisRuntime.preferred : preferred,
        state: response?.state
      })
      if (response?.started && next.state.status === 'ready') {
        await refreshAnalysisRuntimeStatusAfterInstall()
        return 'ready'
      }
      if (next.state.status === 'downloading' || next.state.status === 'extracting')
        return 'started'
      return 'blocked'
    } catch (error) {
      await options.confirmDialog({
        title: options.t('analysisRuntime.unsupportedTitle'),
        content: [
          isHelp
            ? options.t('analysisRuntime.downloadFailedHintGeneric')
            : options.t('analysisRuntime.downloadFailedHint', { feature: featureLabel }),
          options.t('analysisRuntime.downloadErrorHint', {
            error: error instanceof Error ? error.message : String(error || 'unknown')
          })
        ],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 560,
        innerHeight: 0
      })
      return 'blocked'
    } finally {
      analysisRuntimePromptBusy = false
    }
  }

  const ensureAnalysisRuntimeForFeature = async (params: {
    source: Exclude<AnalysisRuntimeFeature, 'analysis'>
    blockedHintKey: string
  }) => {
    const result = await promptAnalysisRuntimeDownload(params.source)
    if (result === 'ready') return true
    if (result === 'handled') return false
    if (
      result === 'started' ||
      isAnalysisRuntimeDownloadActiveStatus(options.runtime.analysisRuntime.state.status)
    ) {
      return false
    }
    await options.confirmDialog({
      title: options.t('analysisRuntime.unsupportedTitle'),
      content: [options.t(params.blockedHintKey)],
      confirmShow: false,
      textAlign: 'left',
      innerWidth: 560,
      innerHeight: 0
    })
    return false
  }

  const ensureAnalysisRuntimeForHorizontalMode = () =>
    ensureAnalysisRuntimeForFeature({
      source: 'horizontal',
      blockedHintKey: 'analysisRuntime.horizontalBlockedHint'
    })

  const ensureAnalysisRuntimeForStemWorkbench = () =>
    ensureAnalysisRuntimeForFeature({
      source: 'stem',
      blockedHintKey: 'analysisRuntime.stemBlockedHint'
    })

  const ensureAnalysisRuntimeForBpmFix = () =>
    ensureAnalysisRuntimeForFeature({ source: 'bpm-fix', blockedHintKey: 'bpmFix.runtimeHint' })

  const handleAnalysisRuntimeDownloadState = async (payload: unknown) => {
    const prevStatus = options.runtime.analysisRuntime.state.status
    const next = applyAnalysisRuntimeStatus({
      preferred: options.runtime.analysisRuntime.preferred,
      state: payload
    })
    if (next.state.status === 'ready' && prevStatus !== 'ready' && next.state.title) {
      await refreshAnalysisRuntimeStatusAfterInstall()
      await options.confirmDialog({
        title: options.t('common.success'),
        content: [options.t('analysisRuntime.readyHint', { title: next.state.title })],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 520,
        innerHeight: 0
      })
      return
    }
    if (next.state.status === 'failed' && prevStatus !== 'failed') {
      const content = [options.t('analysisRuntime.downloadFailedHintGeneric')]
      if (next.state.error) {
        content.push(options.t('analysisRuntime.downloadErrorHint', { error: next.state.error }))
      }
      await options.confirmDialog({
        title: options.t('common.warning'),
        content,
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 560,
        innerHeight: 0
      })
    }
  }

  return {
    refreshAnalysisRuntimeStatus,
    promptAnalysisRuntimeDownload,
    ensureAnalysisRuntimeForHorizontalMode,
    ensureAnalysisRuntimeForStemWorkbench,
    ensureAnalysisRuntimeForBpmFix,
    handleAnalysisRuntimeDownloadState
  }
}
