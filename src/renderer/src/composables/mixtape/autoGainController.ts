import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import {
  type AutoGainAnalysisSnapshot,
  buildAutoGainEnvelopes,
  pickLoudestReferenceTrackId,
  pickQuietestReferenceTrackId
} from '@renderer/composables/mixtape/autoGain'
import type { MixtapeTrack } from '@renderer/composables/mixtape/types'

type PersistEntry = {
  itemId: string
  gainEnvelope: Array<{ sec: number; gain: number }>
}

type CreateMixtapeAutoGainControllerParams = {
  tracks: Ref<MixtapeTrack[]>
  selectedTrackId: Ref<string>
  bpmAnalysisActive: Ref<boolean>
  resolveTrackTitle: (track: MixtapeTrack) => string
  t: (key: string, payload?: Record<string, unknown>) => string
  onEnvelopeApplied: () => void
  persistGainEnvelope: (entries: PersistEntry[]) => Promise<void>
  showErrorDialog: (message: string) => Promise<void>
}

export const createMixtapeAutoGainController = (params: CreateMixtapeAutoGainControllerParams) => {
  const autoGainDialogVisible = ref(false)
  const autoGainReferenceTrackId = ref('')
  const autoGainReferenceFeedback = ref('')
  const autoGainBusy = ref(false)
  const autoGainProgressDone = ref(0)
  const autoGainProgressTotal = ref(0)
  const autoGainProgressLabel = ref('')
  const autoGainSaving = ref(false)
  let autoGainAnalysisSnapshot: AutoGainAnalysisSnapshot | null = null
  let autoGainToken = 0

  const autoGainReferenceOptions = computed(() =>
    params.tracks.value.map((track) => ({
      id: track.id,
      label: `${track.mixOrder}. ${params.resolveTrackTitle(track)}`
    }))
  )

  const autoGainProgressText = computed(() => {
    if (!autoGainBusy.value) return ''
    if (autoGainSaving.value) return params.t('mixtape.autoGainSaving')
    if (!autoGainProgressTotal.value) return params.t('mixtape.autoGainPreparing')
    return params.t('mixtape.autoGainProgress', {
      done: autoGainProgressDone.value,
      total: autoGainProgressTotal.value,
      title: autoGainProgressLabel.value || params.t('tracks.unknownTrack')
    })
  })

  const canStartAutoGain = computed(
    () => !autoGainBusy.value && params.tracks.value.length >= 2 && !params.bpmAnalysisActive.value
  )

  const resetAutoGainProgress = () => {
    autoGainSaving.value = false
    autoGainProgressDone.value = 0
    autoGainProgressTotal.value = 0
    autoGainProgressLabel.value = ''
  }

  const resetAutoGainReferenceFeedback = () => {
    autoGainReferenceFeedback.value = ''
  }

  const syncReferenceTrack = () => {
    if (params.tracks.value.some((track) => track.id === autoGainReferenceTrackId.value)) return
    autoGainReferenceTrackId.value =
      params.selectedTrackId.value || params.tracks.value[0]?.id || ''
  }

  const resetAutoGainState = () => {
    autoGainToken += 1
    autoGainDialogVisible.value = false
    autoGainReferenceTrackId.value = ''
    autoGainAnalysisSnapshot = null
    resetAutoGainReferenceFeedback()
    autoGainBusy.value = false
    resetAutoGainProgress()
  }

  const openAutoGainDialog = () => {
    if (params.tracks.value.length < 2 || autoGainBusy.value) return
    syncReferenceTrack()
    if (!autoGainReferenceTrackId.value) {
      autoGainReferenceTrackId.value = params.tracks.value[0]?.id || ''
    }
    resetAutoGainReferenceFeedback()
    resetAutoGainProgress()
    autoGainDialogVisible.value = true
  }

  const handleAutoGainDialogCancel = () => {
    if (autoGainBusy.value) return
    resetAutoGainReferenceFeedback()
    autoGainDialogVisible.value = false
  }

  const handleAutoGainDialogConfirm = async () => {
    const referenceTrackId = autoGainReferenceTrackId.value
    if (!referenceTrackId || autoGainBusy.value) return
    if (params.tracks.value.length < 2) {
      autoGainDialogVisible.value = false
      return
    }
    const token = (autoGainToken += 1)
    autoGainBusy.value = true
    resetAutoGainProgress()
    try {
      const results = await buildAutoGainEnvelopes({
        tracks: params.tracks.value.map((track) => ({ ...track })),
        referenceTrackId,
        analysisSnapshot: autoGainAnalysisSnapshot || undefined,
        onProgress: ({ done, total, currentTitle }) => {
          if (token !== autoGainToken) return
          autoGainProgressDone.value = done
          autoGainProgressTotal.value = total
          autoGainProgressLabel.value = currentTitle
        }
      })
      if (token !== autoGainToken) return
      const envelopeByTrackId = new Map(results.map((item) => [item.trackId, item.points]))
      const nextTracks = params.tracks.value.map((track) => {
        const points = envelopeByTrackId.get(track.id)
        if (!points) return track
        return {
          ...track,
          gainEnvelope: points
        }
      })
      params.tracks.value = nextTracks
      // 播放器逐帧读取最新增益包络，无需停止播放或重建音频节点。
      params.onEnvelopeApplied()
      const persistEntries = nextTracks
        .map((track) => {
          if (!Array.isArray(track.gainEnvelope) || track.gainEnvelope.length < 2) return null
          return {
            itemId: String(track.id || '').trim(),
            gainEnvelope: track.gainEnvelope.map((point) => ({
              sec: Number(point.sec),
              gain: Number(point.gain)
            }))
          }
        })
        .filter((item): item is PersistEntry => !!item && item.itemId.length > 0)
      autoGainSaving.value = true
      await params.persistGainEnvelope(persistEntries)
      if (token !== autoGainToken) return
      autoGainDialogVisible.value = false
    } catch (error) {
      console.error('[mixtape] auto gain failed', error)
      await params.showErrorDialog(params.t('mixtape.autoGainFailed'))
    } finally {
      if (token === autoGainToken) {
        autoGainBusy.value = false
        resetAutoGainProgress()
      }
    }
  }

  const handleAutoGainSelectReference = async (mode: 'loudest' | 'quietest') => {
    if (autoGainBusy.value || params.tracks.value.length < 2) return
    const previousReferenceId = autoGainReferenceTrackId.value
    const token = (autoGainToken += 1)
    autoGainBusy.value = true
    resetAutoGainReferenceFeedback()
    resetAutoGainProgress()
    try {
      const picker =
        mode === 'quietest' ? pickQuietestReferenceTrackId : pickLoudestReferenceTrackId
      const result = await picker({
        tracks: params.tracks.value.map((track) => ({ ...track })),
        analysisSnapshot: autoGainAnalysisSnapshot || undefined,
        onProgress: ({ done, total, currentTitle }) => {
          if (token !== autoGainToken) return
          autoGainProgressDone.value = done
          autoGainProgressTotal.value = total
          autoGainProgressLabel.value = currentTitle
        }
      })
      if (token !== autoGainToken) return
      autoGainAnalysisSnapshot = result.analysisSnapshot
      const nextReferenceId = result.trackId
      if (!nextReferenceId) {
        autoGainReferenceFeedback.value = params.t(
          mode === 'quietest'
            ? 'mixtape.autoGainSelectQuietestNoCandidate'
            : 'mixtape.autoGainSelectLoudestNoCandidate'
        )
        return
      }
      const nextReferenceTrack = params.tracks.value.find((track) => track.id === nextReferenceId)
      if (!nextReferenceTrack) {
        autoGainReferenceFeedback.value = params.t(
          mode === 'quietest'
            ? 'mixtape.autoGainSelectQuietestNoCandidate'
            : 'mixtape.autoGainSelectLoudestNoCandidate'
        )
        return
      }
      autoGainReferenceTrackId.value = nextReferenceId
      const pickedTitle = params.resolveTrackTitle(nextReferenceTrack)
      if (previousReferenceId && previousReferenceId === nextReferenceId) {
        autoGainReferenceFeedback.value = params.t(
          mode === 'quietest'
            ? 'mixtape.autoGainSelectQuietestNoChange'
            : 'mixtape.autoGainSelectLoudestNoChange',
          {
            title: pickedTitle
          }
        )
      } else {
        autoGainReferenceFeedback.value = params.t(
          mode === 'quietest'
            ? 'mixtape.autoGainSelectQuietestPicked'
            : 'mixtape.autoGainSelectLoudestPicked',
          {
            title: pickedTitle
          }
        )
      }
    } catch (error) {
      console.error(
        `[mixtape] auto gain select ${mode === 'quietest' ? 'quietest' : 'loudest'} failed`,
        error
      )
      await params.showErrorDialog(
        params.t(
          mode === 'quietest'
            ? 'mixtape.autoGainSelectQuietestFailed'
            : 'mixtape.autoGainSelectLoudestFailed'
        )
      )
    } finally {
      if (token === autoGainToken) {
        autoGainBusy.value = false
        resetAutoGainProgress()
      }
    }
  }

  const handleAutoGainSelectLoudestReference = async () => {
    await handleAutoGainSelectReference('loudest')
  }

  const handleAutoGainSelectQuietestReference = async () => {
    await handleAutoGainSelectReference('quietest')
  }

  return {
    autoGainDialogVisible,
    autoGainReferenceTrackId,
    autoGainReferenceFeedback,
    autoGainBusy,
    autoGainReferenceOptions,
    autoGainProgressText,
    canStartAutoGain,
    openAutoGainDialog,
    handleAutoGainDialogCancel,
    handleAutoGainDialogConfirm,
    handleAutoGainSelectLoudestReference,
    handleAutoGainSelectQuietestReference,
    syncReferenceTrack,
    resetAutoGainState
  }
}
