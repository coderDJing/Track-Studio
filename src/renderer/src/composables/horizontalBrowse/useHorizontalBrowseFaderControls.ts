import { computed, nextTick, reactive, ref, watch, type Ref } from 'vue'
import type { ISettingConfig, ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseClearLinkedPresentationState } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformPresentationCoordinator'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportBandState,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseRenderSync'
import type { HorizontalBrowseLinkedGridVisualTransactionDeckState } from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualTransaction'

type DeckKey = HorizontalBrowseDeckKey
export type HorizontalBrowseBandKey = keyof HorizontalBrowseTransportBandState
const DUAL_DECKS: DeckKey[] = ['top', 'bottom']

type UseHorizontalBrowseFaderControlsParams = {
  topDeckSong: Ref<ISongInfo | null>
  bottomDeckSong: Ref<ISongInfo | null>
  setting: ISettingConfig
  deckSyncState: {
    leaderDeck?: string
  }
  nativeTransport: {
    setBandState: (deck: DeckKey, bands: HorizontalBrowseTransportBandState) => Promise<unknown>
    setCueMonitorEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    setLeader: (deck?: DeckKey | null) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    alignToLeader: (deck: DeckKey, targetSec?: number, skipGridSnap?: boolean) => Promise<unknown>
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
  }
  commitDeckStatesToNative: () => Promise<unknown>
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  commitLinkedGridVisualTransaction?: (
    payload: {
      leader: DeckKey
      follower: DeckKey
      deckStates?: Partial<Record<DeckKey, HorizontalBrowseLinkedGridVisualTransactionDeckState>>
    },
    options?: { begin?: boolean }
  ) => Promise<boolean> | boolean
  beginLinkedGridVisualTransaction?: (payload: { leader: DeckKey; follower: DeckKey }) => void
  cancelLinkedGridVisualTransaction?: (payload: { leader: DeckKey; follower: DeckKey }) => void
  clearLinkedPresentation?: (playbackStates?: HorizontalBrowseClearLinkedPresentationState) => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

const createDefaultBandState = (): HorizontalBrowseTransportBandState => ({
  high: true,
  mid: true,
  low: true
})

const waitForAnimationFrame = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 16)
  })

const waitForLinkedGridVisualHold = async () => {
  await nextTick()
  await waitForAnimationFrame()
}

export const useHorizontalBrowseFaderControls = (
  params: UseHorizontalBrowseFaderControlsParams
) => {
  const deckBandState = reactive<Record<DeckKey, HorizontalBrowseTransportBandState>>({
    top: createDefaultBandState(),
    bottom: createDefaultBandState()
  })
  const deckCueMonitorState = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  const faderControlsExpanded = ref(Boolean(params.setting.horizontalBrowseFaderControlsExpanded))
  const dualTransportSyncEnabled = ref(false)
  const dualTransportSyncActivating = ref(false)
  const dualTransportSyncDeactivating = ref(false)
  let dualTransportSyncActivationToken = 0
  let dualTransportSyncDeactivationPromise: Promise<void> | null = null
  const canUseDualTransportSync = computed(() =>
    Boolean(params.topDeckSong.value && params.bottomDeckSong.value)
  )
  const DECK_END_EPSILON_SEC = 0.08

  const buildClearLinkedPresentationPlaybackStates =
    (): HorizontalBrowseClearLinkedPresentationState => {
      const startedAtMs = performance.now()
      const buildDeckState = (deck: DeckKey) => {
        const snapshot = params.resolveTransportDeckSnapshot(deck)
        return {
          currentSec: Number(snapshot.renderCurrentSec ?? snapshot.currentSec) || 0,
          playbackRate: Math.max(0.25, Number(snapshot.playbackRate) || 1),
          playing: snapshot.playing === true,
          startedAtMs
        }
      }
      return {
        top: buildDeckState('top'),
        bottom: buildDeckState('bottom')
      }
    }

  const isDeckAtEnd = (deck: DeckKey) => {
    const duration = Number(params.resolveDeckDurationSeconds(deck)) || 0
    if (duration <= 0) return false
    const current = Number(params.resolveDeckCurrentSeconds(deck)) || 0
    return current >= Math.max(0, duration - DECK_END_EPSILON_SEC)
  }

  const waitForPendingDualTransportSyncDeactivation = async () => {
    if (!dualTransportSyncDeactivationPromise) return
    await dualTransportSyncDeactivationPromise
  }

  const deactivateDualTransportSync = () => {
    if (
      !dualTransportSyncEnabled.value &&
      !dualTransportSyncActivating.value &&
      !dualTransportSyncDeactivating.value
    ) {
      return
    }
    const deactivationToken = dualTransportSyncActivationToken + 1
    dualTransportSyncActivationToken = deactivationToken
    dualTransportSyncEnabled.value = false
    dualTransportSyncActivating.value = false
    dualTransportSyncDeactivating.value = true
    let deactivationTask: Promise<void> | null = null
    deactivationTask = (async () => {
      try {
        await Promise.allSettled([
          params.nativeTransport.setSyncEnabled('top', false),
          params.nativeTransport.setSyncEnabled('bottom', false)
        ])
        params.syncDeckRenderState()
        await nextTick()
        params.clearLinkedPresentation?.(buildClearLinkedPresentationPlaybackStates())
      } catch {
        // Keep deactivation best-effort so the UI state can still clear in finally.
      } finally {
        await waitForLinkedGridVisualHold()
        if (dualTransportSyncActivationToken === deactivationToken) {
          dualTransportSyncDeactivating.value = false
        }
        if (deactivationTask && dualTransportSyncDeactivationPromise === deactivationTask) {
          dualTransportSyncDeactivationPromise = null
        }
      }
    })()
    dualTransportSyncDeactivationPromise = deactivationTask
  }

  const resolveDualTransportLeader = (sourceDeck?: DeckKey): DeckKey => {
    if (sourceDeck && params.resolveDeckSong(sourceDeck)) return sourceDeck
    const leaderDeck = params.deckSyncState.leaderDeck
    if ((leaderDeck === 'top' || leaderDeck === 'bottom') && params.resolveDeckSong(leaderDeck)) {
      return leaderDeck
    }
    if (params.resolveDeckPlaying('top')) return 'top'
    if (params.resolveDeckPlaying('bottom')) return 'bottom'
    return 'top'
  }

  const isDeckFullBeatSyncPlaying = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const playbackActive =
      params.resolveDeckPlaying(deck) ||
      snapshot.playing === true ||
      snapshot.playingAudible === true
    return playbackActive && snapshot.syncEnabled === true && snapshot.syncLock === 'full'
  }

  const canActivateDualTransportSyncWithoutAlignment = () =>
    DUAL_DECKS.every(
      (deck) => Boolean(params.resolveDeckSong(deck)) && isDeckFullBeatSyncPlaying(deck)
    )

  const activateDualTransportSync = async (sourceDeck?: DeckKey) => {
    if (!canUseDualTransportSync.value) return false
    await waitForPendingDualTransportSyncDeactivation()
    if (dualTransportSyncEnabled.value) return true
    if (dualTransportSyncActivating.value) return true
    const activationToken = dualTransportSyncActivationToken + 1
    dualTransportSyncActivationToken = activationToken
    if (canActivateDualTransportSyncWithoutAlignment()) {
      dualTransportSyncEnabled.value = true
      dualTransportSyncActivating.value = false
      return true
    }
    const leader = resolveDualTransportLeader(sourceDeck)
    const follower: DeckKey = leader === 'top' ? 'bottom' : 'top'
    const visualTransaction = { leader, follower }
    let visualTransactionStarted = false
    let visualTransactionFinished = false
    dualTransportSyncActivating.value = true
    params.beginLinkedGridVisualTransaction?.(visualTransaction)
    visualTransactionStarted = true
    await nextTick()
    try {
      const topWasPlaying = params.resolveDeckPlaying('top')
      const bottomWasPlaying = params.resolveDeckPlaying('bottom')
      await params.commitDeckStatesToNative()
      await params.nativeTransport.setLeader(leader)
      await params.nativeTransport.setSyncEnabled('top', true)
      await params.nativeTransport.setSyncEnabled('bottom', true)
      const alignTargetSec = params.resolveDeckCurrentSeconds(follower)
      await params.nativeTransport.alignToLeader(follower, alignTargetSec)
      if (topWasPlaying || bottomWasPlaying) {
        if (!topWasPlaying) {
          await params.nativeTransport.setPlaying('top', true)
        }
        if (!bottomWasPlaying) {
          await params.nativeTransport.setPlaying('bottom', true)
        }
      }
      // visualPending 会抑制普通 render sync，但此时 native 已完成对齐。这里必须先把
      // 两轨 Renderer 时钟重锚到最新 snapshot，再提交最终视觉帧；同时保留现有
      // playback revision，避免额外生成一轮替代帧和联结开启卡顿。
      params.syncDeckRenderState({
        force: 'all',
        preserveRevision: true
      })
      await nextTick()
      try {
        const commitStartedAtMs = performance.now()
        const resolveCommitDeckState = (
          deck: DeckKey
        ): HorizontalBrowseLinkedGridVisualTransactionDeckState => {
          const snapshot = params.resolveTransportDeckSnapshot(deck)
          return {
            currentSeconds: Number(snapshot.currentSec ?? snapshot.renderCurrentSec) || 0,
            playbackRate: Math.max(0.25, Number(snapshot.playbackRate) || 1),
            playbackActive: snapshot.playing === true || snapshot.playingAudible === true,
            startedAtMs: commitStartedAtMs
          }
        }
        await params.commitLinkedGridVisualTransaction?.(
          {
            ...visualTransaction,
            deckStates: {
              top: resolveCommitDeckState('top'),
              bottom: resolveCommitDeckState('bottom')
            }
          },
          {
            begin: false
          }
        )
        visualTransactionFinished = true
      } catch {
        // Failed visual transaction commits are handled by the cancellation path below.
      }
      if (dualTransportSyncActivationToken === activationToken) {
        dualTransportSyncEnabled.value = true
      }
      return true
    } finally {
      if (visualTransactionStarted && !visualTransactionFinished) {
        params.cancelLinkedGridVisualTransaction?.(visualTransaction)
      }
      await waitForLinkedGridVisualHold()
      if (dualTransportSyncActivationToken === activationToken) {
        dualTransportSyncActivating.value = false
      }
    }
  }

  const handleDualTransportSyncToggle = () => {
    if (dualTransportSyncActivating.value || dualTransportSyncDeactivating.value) return
    if (dualTransportSyncEnabled.value || dualTransportSyncActivating.value) {
      deactivateDualTransportSync()
      return
    }
    if (!canUseDualTransportSync.value) return
    void activateDualTransportSync().catch(() => {
      dualTransportSyncEnabled.value = false
      dualTransportSyncActivating.value = false
    })
  }

  const handleDeckBandToggle = (deck: DeckKey, band: HorizontalBrowseBandKey) => {
    const nextValue = !deckBandState[deck][band]
    deckBandState[deck][band] = nextValue
    void params.nativeTransport.setBandState(deck, { ...deckBandState[deck] }).catch(() => {
      deckBandState[deck][band] = !nextValue
    })
  }

  const setDeckCueMonitorEnabled = (deck: DeckKey, enabled: boolean, revertOnFailure = true) => {
    const nextValue = Boolean(enabled && params.resolveDeckSong(deck))
    const previousValue = deckCueMonitorState[deck]
    deckCueMonitorState[deck] = nextValue
    void params.nativeTransport.setCueMonitorEnabled(deck, nextValue).catch(() => {
      if (revertOnFailure) {
        deckCueMonitorState[deck] = previousValue
      }
    })
  }

  const handleDeckCueMonitorToggle = (deck: DeckKey) => {
    if (!params.resolveDeckSong(deck)) return
    setDeckCueMonitorEnabled(deck, !deckCueMonitorState[deck])
  }

  const clearDeckCueMonitor = (deck: DeckKey) => {
    if (!deckCueMonitorState[deck]) return
    setDeckCueMonitorEnabled(deck, false, false)
  }

  const clearAllDeckCueMonitor = () => {
    clearDeckCueMonitor('top')
    clearDeckCueMonitor('bottom')
  }

  watch(canUseDualTransportSync, (canUse) => {
    if (canUse) return
    deactivateDualTransportSync()
  })

  watch(
    () => params.resolveDeckSong('top'),
    (song) => {
      if (!song) clearDeckCueMonitor('top')
    }
  )

  watch(
    () => params.resolveDeckSong('bottom'),
    (song) => {
      if (!song) clearDeckCueMonitor('bottom')
    }
  )

  watch(
    () =>
      [
        params.resolveDeckPlaying('top'),
        params.resolveDeckCurrentSeconds('top'),
        params.resolveDeckDurationSeconds('top'),
        params.resolveDeckPlaying('bottom'),
        params.resolveDeckCurrentSeconds('bottom'),
        params.resolveDeckDurationSeconds('bottom')
      ] as const,
    () => {
      if (!dualTransportSyncEnabled.value) return
      if (isDeckAtEnd('top') || isDeckAtEnd('bottom')) {
        deactivateDualTransportSync()
      }
    }
  )

  watch(faderControlsExpanded, (expanded) => {
    params.setting.horizontalBrowseFaderControlsExpanded = expanded
  })

  return {
    deckBandState,
    deckCueMonitorState,
    faderControlsExpanded,
    dualTransportSyncEnabled,
    dualTransportSyncActivating,
    dualTransportSyncDeactivating,
    canUseDualTransportSync,
    activateDualTransportSync,
    deactivateDualTransportSync,
    handleDualTransportSyncToggle,
    handleDeckBandToggle,
    handleDeckCueMonitorToggle,
    clearAllDeckCueMonitor
  }
}
