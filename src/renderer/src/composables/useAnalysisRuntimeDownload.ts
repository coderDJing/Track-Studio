import { computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  formatAnalysisRuntimeBytes,
  isAnalysisRuntimeDownloadActiveStatus,
  resolveAnalysisRuntimeDownloadPercent,
  resolveAnalysisRuntimeDownloadText,
  resolveAnalysisRuntimeDownloadTitle
} from '@renderer/utils/analysisRuntimeDownloadUi'

type TranslateFn = (key: string, params?: Record<string, unknown>) => string
type ConfirmDialogFn = typeof import('@renderer/components/confirmDialog').default

type AnalysisRuntimePromptSource = 'startup' | 'help' | 'horizontal' | 'stem' | 'bpm-fix'
type AnalysisRuntimePromptResult = 'ready' | 'started' | 'blocked'

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
  appVersion: string
}) => {
  let analysisRuntimeDownloadProgressHintAt = 0
  const normalizedAppVersion = String(options.appVersion || '').trim()

  const persistAnalysisRuntimeStartupPromptShownVersion = async () => {
    if (!normalizedAppVersion) return
    if (options.runtime.setting.analysisRuntimeStartupPromptShownVersion === normalizedAppVersion) {
      return
    }
    options.runtime.setting.analysisRuntimeStartupPromptShownVersion = normalizedAppVersion
    try {
      await window.electron.ipcRenderer.invoke(
        'setSetting',
        JSON.parse(JSON.stringify(options.runtime.setting))
      )
    } catch (error) {
      console.error('[analysis-runtime] 保存启动提示状态失败', error)
    }
  }

  const hasShownAnalysisRuntimeStartupPromptForCurrentVersion = () => {
    if (!normalizedAppVersion) return false
    return options.runtime.setting.analysisRuntimeStartupPromptShownVersion === normalizedAppVersion
  }

  const showAnalysisRuntimeDownloadInProgressHint = async () => {
    const now = Date.now()
    if (now - analysisRuntimeDownloadProgressHintAt < 1200) return
    analysisRuntimeDownloadProgressHintAt = now
    const state = options.runtime.analysisRuntime.state
    const title = state.title
      ? options.t('analysisRuntime.downloadInProgressTitle', { title: state.title })
      : options.t('analysisRuntime.downloadInProgressTitleGeneric')
    await options.confirmDialog({
      title,
      content: [
        options.t('analysisRuntime.downloadInProgressHint'),
        options.t('analysisRuntime.downloadInProgressProgressHint')
      ],
      confirmShow: false,
      textAlign: 'left',
      innerWidth: 560,
      innerHeight: 0
    })
  }

  const applyAnalysisRuntimeStatus = (params: { preferred?: unknown; state?: unknown }) => {
    const prevStatus = options.runtime.analysisRuntime.state.status
    const preferred = normalizeAnalysisRuntimePreferredInfo(params.preferred)
    const state = normalizeAnalysisRuntimeDownloadState(params.state)
    options.runtime.analysisRuntime.preferred = preferred
    options.runtime.analysisRuntime.state = state
    options.runtime.analysisRuntime.available =
      preferred.alreadyAvailable || state.status === 'ready'
    const nextActive = isAnalysisRuntimeDownloadActiveStatus(state.status)
    const prevActive = isAnalysisRuntimeDownloadActiveStatus(prevStatus)
    if ((nextActive && !prevActive) || !nextActive) {
      options.runtime.setAnalysisRuntimeDownloadOverlayMinimized(false)
    }
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

  const analysisRuntimeDownloadVisible = computed(() => {
    const status = options.runtime.analysisRuntime.state.status
    return isAnalysisRuntimeDownloadActiveStatus(status)
  })

  const analysisRuntimeDownloadPercent = computed(() =>
    resolveAnalysisRuntimeDownloadPercent(options.runtime.analysisRuntime.state)
  )

  const analysisRuntimeDownloadTitle = computed(() =>
    resolveAnalysisRuntimeDownloadTitle(options.t, options.runtime.analysisRuntime.state)
  )

  const analysisRuntimeDownloadText = computed(() =>
    resolveAnalysisRuntimeDownloadText(options.t, options.runtime.analysisRuntime.state)
  )

  const resolvePromptResultFromCurrentState = (): AnalysisRuntimePromptResult => {
    if (options.runtime.analysisRuntime.available) return 'ready'
    const status = options.runtime.analysisRuntime.state.status
    if (status === 'downloading' || status === 'extracting') return 'started'
    return 'blocked'
  }

  const promptAnalysisRuntimeDownload = async (
    source: AnalysisRuntimePromptSource
  ): Promise<AnalysisRuntimePromptResult> => {
    if (options.runtime.analysisRuntime.available) return 'ready'
    if (analysisRuntimePromptBusy) {
      const currentResult = resolvePromptResultFromCurrentState()
      if (currentResult === 'started' && source !== 'startup') {
        options.runtime.setAnalysisRuntimeDownloadOverlayMinimized(false)
        await showAnalysisRuntimeDownloadInProgressHint()
      }
      return currentResult
    }
    analysisRuntimePromptBusy = true
    try {
      const { preferred, state } = await refreshAnalysisRuntimeStatus()
      if (options.runtime.analysisRuntime.available) return 'ready'
      if (isAnalysisRuntimeDownloadActiveStatus(state.status)) {
        if (source !== 'startup') {
          options.runtime.setAnalysisRuntimeDownloadOverlayMinimized(false)
          await showAnalysisRuntimeDownloadInProgressHint()
        }
        return 'started'
      }

      if (!preferred.supported) {
        if (source !== 'startup') {
          await options.confirmDialog({
            title: options.t('analysisRuntime.unsupportedTitle'),
            content: [options.t('analysisRuntime.unsupportedHint')],
            confirmShow: false,
            textAlign: 'left',
            innerWidth: 560,
            innerHeight: 0
          })
        }
        return 'blocked'
      }

      if (preferred.reason === 'manifest unavailable') {
        if (source !== 'startup') {
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
        }
        return 'blocked'
      }

      if (!preferred.downloadable || !preferred.profile) return 'blocked'
      if (source === 'startup' && hasShownAnalysisRuntimeStartupPromptForCurrentVersion()) {
        return 'blocked'
      }
      if (source === 'startup') {
        await persistAnalysisRuntimeStartupPromptShownVersion()
      }

      const confirmResult = await options.confirmDialog({
        title: options.t('analysisRuntime.promptTitle'),
        content: [
          options.t('analysisRuntime.promptBody', {
            title: preferred.title,
            size: formatAnalysisRuntimeBytes(preferred.archiveSize)
          }),
          options.t('analysisRuntime.promptHint')
        ],
        confirmShow: true,
        confirmText: options.t('analysisRuntime.downloadNow'),
        cancelText: options.t('analysisRuntime.downloadLater'),
        textAlign: 'left',
        innerWidth: 560,
        innerHeight: 0
      })
      if (confirmResult !== 'confirm') return 'blocked'

      const response = await window.electron.ipcRenderer.invoke(
        'analysis-runtime:download-preferred'
      )
      const next = applyAnalysisRuntimeStatus({
        preferred,
        state: response?.state
      })
      if (options.runtime.analysisRuntime.available) return 'ready'
      if (next.state.status === 'downloading' || next.state.status === 'extracting')
        return 'started'
      return 'blocked'
    } catch (error) {
      if (source !== 'startup') {
        await options.confirmDialog({
          title: options.t('analysisRuntime.unsupportedTitle'),
          content: [
            options.t('analysisRuntime.downloadFailedHint'),
            options.t('analysisRuntime.downloadErrorHint', {
              error: error instanceof Error ? error.message : String(error || 'unknown')
            })
          ],
          confirmShow: false,
          textAlign: 'left',
          innerWidth: 560,
          innerHeight: 0
        })
      }
      return 'blocked'
    } finally {
      analysisRuntimePromptBusy = false
    }
  }

  const ensureAnalysisRuntimeForFeature = async (params: {
    source: Exclude<AnalysisRuntimePromptSource, 'startup'>
    blockedHintKey: string
  }) => {
    if (options.runtime.analysisRuntime.available) {
      return true
    }

    const result = await promptAnalysisRuntimeDownload(params.source)
    if (result === 'ready' || options.runtime.analysisRuntime.available) {
      return true
    }
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
      const content = [options.t('analysisRuntime.downloadFailedHint')]
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
    analysisRuntimeDownloadVisible,
    analysisRuntimeDownloadPercent,
    analysisRuntimeDownloadTitle,
    analysisRuntimeDownloadText,
    refreshAnalysisRuntimeStatus,
    promptAnalysisRuntimeDownload,
    ensureAnalysisRuntimeForHorizontalMode,
    ensureAnalysisRuntimeForStemWorkbench,
    ensureAnalysisRuntimeForBpmFix,
    handleAnalysisRuntimeDownloadState
  }
}
