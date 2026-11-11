import { nextTick } from 'vue'
import type ConfirmDialog from '@renderer/components/confirmDialog'
import type {
  MixtapeMixMode,
  MixtapeOpenPayload,
  MixtapeStemProfile,
  MixtapeStemStatus,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'
import type {
  MixtapeOutputProgressPayload,
  MixtapeRenderedWavResult
} from '@renderer/composables/mixtape/timelineTransportRenderWav'
import type { MixtapeOutputProgressState } from '@renderer/composables/mixtape/mixtapeOutputProgress'

type ValueRef<T> = {
  value: T
}

type MixtapeOutputUiContext = {
  payload: ValueRef<MixtapeOpenPayload>
  tracks: ValueRef<MixtapeTrack[]>
  mixtapeMixMode: ValueRef<MixtapeMixMode>
  mixtapeStemMode: ValueRef<string>
  mixtapeStemProfile: ValueRef<MixtapeStemProfile>
  outputDialogVisible: ValueRef<boolean>
  outputRunning: ValueRef<boolean>
  outputPath: ValueRef<string>
  outputFormat: ValueRef<'wav' | 'mp3'>
  outputFilename: ValueRef<string>
  outputProgressKey: ValueRef<string>
  outputProgressPercent: ValueRef<number>
  outputProgressDone: ValueRef<number>
  outputProgressTotal: ValueRef<number>
  renderMixtapeOutputWav: (params: {
    onProgress: (payload: MixtapeOutputProgressPayload) => void
    shouldAbort?: () => boolean
  }) => Promise<MixtapeRenderedWavResult>
  normalizeMixtapeFilePath: (value: unknown) => string
  normalizeStemProfile: (value: unknown, fallback?: MixtapeStemProfile) => MixtapeStemProfile
  normalizeMixtapeStemStatus: (value: unknown) => MixtapeStemStatus
  hasTrackStemPathsReady: (track: MixtapeTrack, stemMode: unknown) => boolean
  resolveTrackStemModel: (track: MixtapeTrack) => string
  resolveTrackTitle: (track: MixtapeTrack) => string
  resolveMixtapeStemModelByProfile: (profile: MixtapeStemProfile) => string
  resolveMixtapeOutputProgressState: (
    current: MixtapeOutputProgressState,
    nextPayload?: MixtapeOutputProgressPayload | null
  ) => MixtapeOutputProgressState
  DEFAULT_MIXTAPE_STEM_PROFILE: MixtapeStemProfile
  confirmDialog: typeof ConfirmDialog
  t: (key: string, payload?: Record<string, unknown>) => string
}

export const createMixtapeOutputUi = (ctx: MixtapeOutputUiContext) => {
  const {
    payload,
    tracks,
    mixtapeMixMode,
    mixtapeStemMode,
    mixtapeStemProfile,
    outputDialogVisible,
    outputRunning,
    outputPath,
    outputFormat,
    outputFilename,
    outputProgressKey,
    outputProgressPercent,
    outputProgressDone,
    outputProgressTotal,
    renderMixtapeOutputWav,
    normalizeMixtapeFilePath,
    normalizeStemProfile,
    normalizeMixtapeStemStatus,
    hasTrackStemPathsReady,
    resolveTrackStemModel,
    resolveTrackTitle,
    resolveMixtapeStemModelByProfile,
    resolveMixtapeOutputProgressState,
    DEFAULT_MIXTAPE_STEM_PROFILE,
    confirmDialog,
    t
  } = ctx
  let currentOutputRequestId = ''
  let outputCancelRequested = false

  const createOutputRequestId = () =>
    `mixtape_output_${Date.now()}_${Math.random().toString(16).slice(2)}`

  const openOutputDialog = () => {
    if (outputRunning.value) return
    outputDialogVisible.value = true
  }

  const applyOutputProgressPayload = (payload: MixtapeOutputProgressPayload | null) => {
    const nextState = resolveMixtapeOutputProgressState(
      {
        stageKey: outputProgressKey.value,
        done: outputProgressDone.value,
        total: outputProgressTotal.value,
        percent: outputProgressPercent.value
      },
      payload
    )
    outputProgressKey.value = nextState.stageKey
    outputProgressDone.value = nextState.done
    outputProgressTotal.value = nextState.total
    outputProgressPercent.value = nextState.percent
  }

  const runMixtapeOutput = async () => {
    if (outputRunning.value) return
    const normalizedOutputPath = outputPath.value.trim()
    const normalizedFilename = outputFilename.value.trim()
    if (!normalizedOutputPath) {
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputPathRequired')],
        confirmShow: false
      })
      return
    }
    if (!normalizedFilename) {
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputFilenameRequired')],
        confirmShow: false
      })
      return
    }
    if (!tracks.value.length) {
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputNoTracks')],
        confirmShow: false
      })
      return
    }
    if (mixtapeMixMode.value === 'stem') {
      const exportProfile = normalizeStemProfile(
        mixtapeStemProfile.value,
        DEFAULT_MIXTAPE_STEM_PROFILE
      )
      const exportModel = resolveMixtapeStemModelByProfile(exportProfile)
      const notReadyTracks = tracks.value.filter((track: MixtapeTrack) => {
        if (normalizeMixtapeStemStatus(track.stemStatus) !== 'ready') return true
        if (!hasTrackStemPathsReady(track, mixtapeStemMode.value)) return true
        return resolveTrackStemModel(track) !== exportModel
      })
      if (notReadyTracks.length > 0) {
        const trackSample = notReadyTracks
          .slice(0, 3)
          .map((track: MixtapeTrack) => resolveTrackTitle(track))
        const filePaths = Array.from(
          new Set(
            notReadyTracks
              .map((track: MixtapeTrack) => normalizeMixtapeFilePath(track.filePath))
              .filter((filePath: string): filePath is string => !!filePath)
          )
        )
        if (
          filePaths.length > 0 &&
          window?.electron?.ipcRenderer?.invoke &&
          payload.value.playlistId
        ) {
          try {
            await window.electron.ipcRenderer.invoke('mixtape:stem:enqueue', {
              playlistId: payload.value.playlistId,
              filePaths,
              stemMode: mixtapeStemMode.value,
              profile: exportProfile,
              force: false
            })
          } catch (error) {
            console.error('[mixtape] enqueue export stem profile failed', {
              playlistId: payload.value.playlistId,
              profile: exportProfile,
              count: filePaths.length,
              error
            })
          }
        }
        await confirmDialog({
          title: t('common.warning'),
          content: [
            t('mixtape.exportStemPreparing', { count: notReadyTracks.length }),
            ...trackSample
          ],
          confirmShow: false
        })
        return
      }
    }

    outputRunning.value = true
    outputCancelRequested = false
    currentOutputRequestId = createOutputRequestId()
    outputProgressKey.value = 'mixtape.outputProgressPreparing'
    outputProgressDone.value = 0
    outputProgressTotal.value = 100
    outputProgressPercent.value = 0
    await nextTick()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    const outputRequest = {
      requestId: currentOutputRequestId,
      outputPath: normalizedOutputPath,
      outputFormat: outputFormat.value,
      outputFilename: normalizedFilename
    }

    try {
      const rendered = await renderMixtapeOutputWav({
        onProgress: applyOutputProgressPayload,
        // 取消要能在离线渲染途中生效，否则用户点了取消也只能干等整段混音渲染完
        shouldAbort: () => outputCancelRequested
      })
      if (outputCancelRequested) {
        throw new Error('mixtape.outputCancelled')
      }
      // 渲染/编码完成后还要把整段 WAV 交给主进程写盘，这一步不能没有反馈
      applyOutputProgressPayload({
        stageKey: 'mixtape.outputProgressFinalizing',
        done: 98,
        total: 100,
        percent: 98
      })
      const result = await window.electron.ipcRenderer.invoke('mixtape:output', {
        ...outputRequest,
        wavBytes: rendered.wavBytes,
        durationSec: rendered.durationSec,
        sampleRate: rendered.sampleRate,
        channels: rendered.channels
      })
      if (!result?.ok) {
        throw new Error(result?.error || t('common.unknownError'))
      }
      applyOutputProgressPayload({
        stageKey: 'mixtape.outputProgressFinished',
        done: 100,
        total: 100,
        percent: 100
      })
      outputRunning.value = false
      await confirmDialog({
        title: t('common.finished'),
        content: [t('mixtape.outputFinishedHint', { path: String(result?.outputPath || '') })],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 500
      })
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error || t('common.error'))
      const isCancelled = rawMessage === 'mixtape.outputCancelled'
      const isTimeout = rawMessage === 'mixtape.outputTimeout'
      const message = t(rawMessage)
      applyOutputProgressPayload({
        stageKey: isCancelled ? 'mixtape.outputProgressCancelled' : 'mixtape.outputProgressFailed',
        done: 100,
        total: 100,
        percent: 100
      })
      outputRunning.value = false
      await confirmDialog({
        title: isCancelled ? t('common.cancel') : t('common.error'),
        content: [
          isCancelled
            ? t('mixtape.outputCancelledHint')
            : isTimeout
              ? t('mixtape.outputFailedHint', { reason: t('mixtape.outputTimeout') })
              : t('mixtape.outputFailedHint', { reason: message })
        ],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 500
      })
    } finally {
      outputRunning.value = false
      outputCancelRequested = false
      currentOutputRequestId = ''
    }
  }

  const handleOutputCancelRunning = async () => {
    if (!outputRunning.value) return
    outputCancelRequested = true
    outputProgressKey.value = 'mixtape.outputProgressCancelling'
    const requestId = currentOutputRequestId
    if (!requestId) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:output:cancel', { requestId })
    } catch (error) {
      console.error('[mixtape] cancel output failed', error)
    }
  }

  const handleOutputDialogConfirm = async (payloadValue: {
    outputPath: string
    outputFormat: 'wav' | 'mp3'
    outputFilename: string
  }) => {
    outputPath.value = payloadValue.outputPath
    outputFormat.value = payloadValue.outputFormat
    outputFilename.value = payloadValue.outputFilename
    outputDialogVisible.value = false
    await runMixtapeOutput()
  }

  const handleOutputDialogCancel = () => {
    outputDialogVisible.value = false
  }

  return {
    openOutputDialog,
    applyOutputProgressPayload,
    handleOutputDialogConfirm,
    handleOutputDialogCancel,
    handleOutputCancelRunning
  }
}
