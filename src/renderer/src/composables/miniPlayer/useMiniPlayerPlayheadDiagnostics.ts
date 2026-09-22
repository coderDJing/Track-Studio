import { onMounted, onUnmounted, type Ref } from 'vue'
import {
  MINI_PLAYER_CHANNELS,
  type MiniPlayerHostState,
  type MiniPlayerPlayhead
} from '@shared/miniPlayerWindow'

const PLAYHEAD_DELAY_THRESHOLD_MS = 1500
const PLAYHEAD_DELAY_REPORT_COOLDOWN_MS = 15_000
const PLAYHEAD_DELAY_WATCH_INTERVAL_MS = 500

type PlayheadState = Pick<MiniPlayerPlayhead, 'currentSeconds' | 'durationSeconds' | 'isPlaying'>
type PlayheadUpdateMetadata = {
  source: 'playhead' | 'host-state'
  sequence?: number | null
  publishedAtMs?: number | null
}

export const useMiniPlayerPlayheadDiagnostics = (hostState: Ref<MiniPlayerHostState | null>) => {
  let lastPlayheadAtMs = 0
  let lastReportAtMs = 0
  let wasPlaying = false
  let watchTimer: number | null = null
  let lastUpdateSource: PlayheadUpdateMetadata['source'] = 'host-state'
  let lastUpdateSequence: number | null = null
  let lastUpdatePublishedAtMs: number | null = null
  let lastUpdateReceivedAtMs: number | null = null

  const reportDelayedPlayhead = (nowMs: number, state: PlayheadState) => {
    const delayedMs = nowMs - lastPlayheadAtMs
    if (
      delayedMs < PLAYHEAD_DELAY_THRESHOLD_MS ||
      nowMs - lastReportAtMs < PLAYHEAD_DELAY_REPORT_COOLDOWN_MS
    ) {
      return
    }
    lastReportAtMs = nowMs
    window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.playheadGap, {
      delayedMs: Math.round(delayedMs),
      currentSeconds: Math.max(0, Number(state.currentSeconds) || 0),
      durationSeconds: Math.max(0, Number(state.durationSeconds) || 0),
      detectedAtMs: nowMs,
      lastUpdateSource,
      lastUpdateSequence,
      lastUpdatePublishedAtMs,
      lastUpdateReceivedAtMs
    })
  }

  const notePlaybackUpdate = (state: PlayheadState, metadata?: PlayheadUpdateMetadata) => {
    const nowMs = Date.now()
    if (lastPlayheadAtMs > 0 && wasPlaying && state.isPlaying) {
      reportDelayedPlayhead(nowMs, state)
    }
    lastPlayheadAtMs = nowMs
    wasPlaying = state.isPlaying
    lastUpdateReceivedAtMs = nowMs
    lastUpdateSource = metadata?.source || 'host-state'
    if (metadata?.source === 'playhead') {
      lastUpdateSequence = metadata.sequence ?? null
      lastUpdatePublishedAtMs = metadata.publishedAtMs ?? null
    }
  }

  onMounted(() => {
    watchTimer = window.setInterval(() => {
      const state = hostState.value
      if (!state?.isPlaying || !wasPlaying || lastPlayheadAtMs === 0) return
      reportDelayedPlayhead(Date.now(), state)
    }, PLAYHEAD_DELAY_WATCH_INTERVAL_MS)
  })

  onUnmounted(() => {
    if (watchTimer !== null) {
      window.clearInterval(watchTimer)
      watchTimer = null
    }
  })

  return { notePlaybackUpdate }
}
