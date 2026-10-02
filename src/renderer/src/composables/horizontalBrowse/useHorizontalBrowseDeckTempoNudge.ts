import { onUnmounted, reactive } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRenderSync'

type DeckKey = HorizontalBrowseDeckKey
export type HorizontalBrowseTempoNudgeDirection = 'slow' | 'fast'

type TempoNudgeSession = {
  direction: HorizontalBrowseTempoNudgeDirection
  basePlaybackRate: number
}

type UseHorizontalBrowseDeckTempoNudgeParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  nativeTransport: {
    setTempoNudgePlaybackRate: (deck: DeckKey, playbackRate: number) => Promise<unknown>
  }
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

const TEMPO_NUDGE_RATIO = 0.04
const MIN_PLAYBACK_RATE = 0.25
const MAX_PLAYBACK_RATE = 4

const clampPlaybackRate = (value: number) =>
  Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, value))

const normalizePlaybackRate = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1
}

export const useHorizontalBrowseDeckTempoNudge = (
  params: UseHorizontalBrowseDeckTempoNudgeParams
) => {
  const activeTempoNudge = reactive<Record<DeckKey, TempoNudgeSession | null>>({
    top: null,
    bottom: null
  })
  const operationQueue: Record<DeckKey, Promise<void>> = {
    top: Promise.resolve(),
    bottom: Promise.resolve()
  }
  const pendingRestorePlaybackRate = reactive<Record<DeckKey, number | null>>({
    top: null,
    bottom: null
  })

  const enqueueTempoNudgeRate = (deck: DeckKey, playbackRate: number, afterApply?: () => void) => {
    operationQueue[deck] = operationQueue[deck]
      .catch(() => {})
      .then(async () => {
        await params.nativeTransport.setTempoNudgePlaybackRate(deck, playbackRate)
        params.syncDeckRenderState({ force: deck })
        afterApply?.()
      })
      .catch((error) => {
        console.error('[horizontal-browse-tempo-nudge] set playback rate failed', error)
      })
  }

  const resolveTempoNudgeBasePlaybackRate = (deck: DeckKey) =>
    activeTempoNudge[deck]?.basePlaybackRate ??
    pendingRestorePlaybackRate[deck] ??
    normalizePlaybackRate(params.resolveTransportDeckSnapshot(deck).playbackRate)

  const resolveDeckPlaybackRateForTransport = (deck: DeckKey) =>
    resolveTempoNudgeBasePlaybackRate(deck)

  const resolveDeckTempoNudgeDirection = (deck: DeckKey) =>
    activeTempoNudge[deck]?.direction ?? null

  const startDeckTempoNudge = (deck: DeckKey, direction: HorizontalBrowseTempoNudgeDirection) => {
    if (!params.resolveDeckSong(deck)) return

    const currentSession = activeTempoNudge[deck]
    if (currentSession?.direction === direction) return

    params.touchDeckInteraction(deck)
    const basePlaybackRate =
      currentSession?.basePlaybackRate ??
      pendingRestorePlaybackRate[deck] ??
      normalizePlaybackRate(params.resolveTransportDeckSnapshot(deck).playbackRate)
    // 先接管基准倍率再清理恢复状态，避免同步观察者短暂读到 native 的临时倍率。
    activeTempoNudge[deck] = {
      direction,
      basePlaybackRate
    }
    pendingRestorePlaybackRate[deck] = null
    const ratio = direction === 'slow' ? 1 - TEMPO_NUDGE_RATIO : 1 + TEMPO_NUDGE_RATIO
    enqueueTempoNudgeRate(deck, clampPlaybackRate(basePlaybackRate * ratio))
  }

  const stopDeckTempoNudge = (deck: DeckKey, direction?: HorizontalBrowseTempoNudgeDirection) => {
    const currentSession = activeTempoNudge[deck]
    if (!currentSession) return
    if (direction && currentSession.direction !== direction) return

    params.touchDeckInteraction(deck)
    const restorePlaybackRate = clampPlaybackRate(currentSession.basePlaybackRate)
    // 松手后 native 尚未恢复，密度需要继续由待恢复的正式倍率接管。
    pendingRestorePlaybackRate[deck] = restorePlaybackRate
    activeTempoNudge[deck] = null
    enqueueTempoNudgeRate(deck, restorePlaybackRate, () => {
      if (!activeTempoNudge[deck] && pendingRestorePlaybackRate[deck] === restorePlaybackRate) {
        pendingRestorePlaybackRate[deck] = null
      }
    })
  }

  const stopAllDeckTempoNudge = () => {
    stopDeckTempoNudge('top')
    stopDeckTempoNudge('bottom')
  }

  const resetDeckTempoNudgePlaybackRate = async (deck: DeckKey, playbackRate = 1) => {
    const restorePlaybackRate = clampPlaybackRate(normalizePlaybackRate(playbackRate))
    pendingRestorePlaybackRate[deck] = restorePlaybackRate
    activeTempoNudge[deck] = null
    operationQueue[deck] = operationQueue[deck]
      .catch(() => {})
      .then(async () => {
        await params.nativeTransport.setTempoNudgePlaybackRate(deck, restorePlaybackRate)
        params.syncDeckRenderState({ force: deck })
        if (!activeTempoNudge[deck] && pendingRestorePlaybackRate[deck] === restorePlaybackRate) {
          pendingRestorePlaybackRate[deck] = null
        }
      })
      .catch((error) => {
        console.error('[horizontal-browse-tempo-nudge] reset playback rate failed', error)
      })
    await operationQueue[deck]
  }

  const resetAllDeckTempoNudgePlaybackRates = async (playbackRate = 1) => {
    await Promise.all([
      resetDeckTempoNudgePlaybackRate('top', playbackRate),
      resetDeckTempoNudgePlaybackRate('bottom', playbackRate)
    ])
  }

  const handleWindowBlur = () => {
    stopAllDeckTempoNudge()
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      stopAllDeckTempoNudge()
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('blur', handleWindowBlur)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  onUnmounted(() => {
    stopAllDeckTempoNudge()
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', handleWindowBlur)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  })

  return {
    resolveDeckPlaybackRateForTransport,
    resolveDeckTempoNudgeDirection,
    startDeckTempoNudge,
    stopDeckTempoNudge,
    stopAllDeckTempoNudge,
    resetAllDeckTempoNudgePlaybackRates
  }
}
