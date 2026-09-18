import emitter from '@renderer/utils/mitt'

export const EXCLUSIVE_PLAYBACK_PAUSE_OTHERS_EVENT = 'exclusive-playback:pause-others'
export const WAVEFORM_PREVIEW_TRANSPORT_SUSPEND_EVENT = 'waveform-preview:transport-suspend'
export const WAVEFORM_PREVIEW_TRANSPORT_RESUME_EVENT = 'waveform-preview:transport-resume'

export type ExclusivePlaybackOwner =
  | 'stem-preview'
  | 'waveform-preview'
  | 'main-player'
  | 'horizontal-browse'

export type ExclusivePlaybackPauseOthersPayload = {
  owner: ExclusivePlaybackOwner
}

export type WaveformPreviewTransportGatePayload = {
  sessionId: string
  waitUntil: (operation: Promise<unknown>) => void
}

const EXCLUSIVE_PLAYBACK_OWNERS = new Set<ExclusivePlaybackOwner>([
  'stem-preview',
  'waveform-preview',
  'main-player',
  'horizontal-browse'
])

export const isExclusivePlaybackPauseOthersPayload = (
  payload: unknown
): payload is ExclusivePlaybackPauseOthersPayload => {
  if (!payload || typeof payload !== 'object') return false
  const owner = (payload as { owner?: unknown }).owner
  return typeof owner === 'string' && EXCLUSIVE_PLAYBACK_OWNERS.has(owner as ExclusivePlaybackOwner)
}

export const pauseOtherAppPlayback = (owner: ExclusivePlaybackOwner) => {
  emitter.emit(EXCLUSIVE_PLAYBACK_PAUSE_OTHERS_EVENT, {
    owner
  } satisfies ExclusivePlaybackPauseOthersPayload)
  if (owner !== 'waveform-preview') {
    try {
      emitter.emit('waveform-preview:stop', { reason: 'switch' })
    } catch {}
  }
  if (owner !== 'main-player') {
    try {
      emitter.emit('waveform-preview:pause-main')
    } catch {}
  }
}

const runWaveformPreviewTransportGate = async (event: string, sessionId: string) => {
  const operations: Promise<unknown>[] = []
  emitter.emit(event, {
    sessionId,
    waitUntil: (operation) => {
      operations.push(Promise.resolve(operation))
    }
  } satisfies WaveformPreviewTransportGatePayload)
  if (!operations.length) return
  await Promise.all(operations)
}

export const suspendTransportForWaveformPreview = async (sessionId: string) => {
  await runWaveformPreviewTransportGate(WAVEFORM_PREVIEW_TRANSPORT_SUSPEND_EVENT, sessionId)
}

export const resumeTransportAfterWaveformPreview = async (sessionId: string) => {
  await runWaveformPreviewTransportGate(WAVEFORM_PREVIEW_TRANSPORT_RESUME_EVENT, sessionId)
}
