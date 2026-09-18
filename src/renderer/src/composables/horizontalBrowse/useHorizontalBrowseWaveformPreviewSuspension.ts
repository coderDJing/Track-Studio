import { onScopeDispose } from 'vue'
import emitter from '@renderer/utils/mitt'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRenderSync'
import {
  stopWaveformPreviewForTransportInteraction,
  WAVEFORM_PREVIEW_TRANSPORT_RESUME_EVENT,
  WAVEFORM_PREVIEW_TRANSPORT_SUSPEND_EVENT,
  type WaveformPreviewTransportGatePayload
} from '@renderer/utils/exclusivePlayback'

type UseHorizontalBrowseWaveformPreviewSuspensionParams = {
  nativeTransport: {
    state: {
      auditionSuspended?: boolean
    }
    setAuditionSuspended: (suspended: boolean) => Promise<unknown>
  }
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  setAuditionPresentationSuspended: (suspended: boolean) => void
  playerInteractionEnabled: () => boolean
}

const isGatePayload = (payload: unknown): payload is WaveformPreviewTransportGatePayload => {
  if (!payload || typeof payload !== 'object') return false
  const candidate = payload as Partial<WaveformPreviewTransportGatePayload>
  return typeof candidate.sessionId === 'string' && typeof candidate.waitUntil === 'function'
}

export const useHorizontalBrowseWaveformPreviewSuspension = (
  params: UseHorizontalBrowseWaveformPreviewSuspensionParams
) => {
  let activeSessionId = ''
  let disposed = false
  let operationQueue: Promise<void> = Promise.resolve()

  const enqueue = (operation: () => Promise<void>) => {
    const pending = operationQueue.then(operation, operation)
    operationQueue = pending.catch(() => undefined)
    return pending
  }

  const syncFrozenPresentation = () => {
    params.syncDeckRenderState({ force: 'all', preserveRevision: true })
  }

  const handleSuspend = (payload: unknown) => {
    if (!isGatePayload(payload)) return
    payload.waitUntil(
      enqueue(async () => {
        if (disposed) return
        if (params.nativeTransport.state.auditionSuspended === true) {
          activeSessionId = payload.sessionId
          params.setAuditionPresentationSuspended(true)
          return
        }
        await params.nativeTransport.setAuditionSuspended(true)
        if (disposed) return
        activeSessionId = payload.sessionId
        params.setAuditionPresentationSuspended(true)
      })
    )
  }

  const handleResume = (payload: unknown) => {
    if (!isGatePayload(payload)) return
    payload.waitUntil(
      enqueue(async () => {
        if (activeSessionId !== payload.sessionId) return
        await params.nativeTransport.setAuditionSuspended(false)
        params.setAuditionPresentationSuspended(false)
        activeSessionId = ''
        if (!disposed) {
          syncFrozenPresentation()
        }
      })
    )
  }

  emitter.on(WAVEFORM_PREVIEW_TRANSPORT_SUSPEND_EVENT, handleSuspend)
  emitter.on(WAVEFORM_PREVIEW_TRANSPORT_RESUME_EVENT, handleResume)

  const handlePlayerInteraction = () => {
    if (!activeSessionId || !params.playerInteractionEnabled()) return
    stopWaveformPreviewForTransportInteraction()
  }

  onScopeDispose(() => {
    disposed = true
    emitter.off(WAVEFORM_PREVIEW_TRANSPORT_SUSPEND_EVENT, handleSuspend)
    emitter.off(WAVEFORM_PREVIEW_TRANSPORT_RESUME_EVENT, handleResume)
    void enqueue(async () => {
      if (params.nativeTransport.state.auditionSuspended === true) {
        await params.nativeTransport.setAuditionSuspended(false)
      }
      params.setAuditionPresentationSuspended(false)
      activeSessionId = ''
    }).catch(() => undefined)
  })

  return { handlePlayerInteraction }
}
