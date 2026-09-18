import { reactive, ref } from 'vue'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { rebaseHorizontalBrowsePlaybackClock } from '@renderer/composables/horizontalBrowse/horizontalBrowseLivePlaybackClock'
import {
  publishHorizontalBrowseLinkedGridRenderClock,
  publishHorizontalBrowseLinkedGridRenderClockPair
} from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualPhase'

type DeckKey = HorizontalBrowseDeckKey
type HorizontalBrowseRenderSyncTarget = DeckKey | DeckKey[] | 'all'
export type HorizontalBrowseRenderSyncOptions = {
  nowMs?: number
  snapshotAtMs?: number
  force?: HorizontalBrowseRenderSyncTarget
  forceRevision?: boolean
  preserveRevision?: boolean
}

type UseHorizontalBrowseRenderSyncParams = {
  nativeTransport: {
    state?: {
      stateRevision?: number
      auditionSuspended?: boolean
    }
    snapshot: (nowMs?: number) => Promise<unknown>
    resolveLiveClockPlaybackRate?: (deck: DeckKey) => number | null
  }
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckPlaying: (deck: DeckKey) => boolean
  linkedGridVisualPending?: () => boolean
}

const TRANSPORT_SNAPSHOT_FALLBACK_INTERVAL_IDLE_MS = 1000
const TRANSPORT_SNAPSHOT_FALLBACK_INTERVAL_PLAYING_MS = 4000
const RENDER_SYNC_REANCHOR_DRIFT_SEC = 0.35
const RENDER_SYNC_FULL_SYNC_PHASE_REANCHOR_SEC = 0.002
const RENDER_SYNC_PENDING_INTENT_EPSILON_SEC = 0.05
const RENDER_SYNC_PENDING_INTENT_MAX_MS = 1500
const RENDER_SYNC_RECENT_INTENT_CONFIRM_MS = 1000
const RENDER_SYNC_POSITION_HOLD_MAX_MS = 700

type PendingRenderSeekIntent = {
  seconds: number
  startedAtMs: number
}

const TIMELINE_ZERO_EPSILON_SEC = 0.0001
const normalizeTimelineSeconds = (seconds: number) => {
  const numeric = Number(seconds)
  return Number.isFinite(numeric) ? numeric : 0
}

const resolveDeckRenderLimitSec = (snapshot: HorizontalBrowseTransportDeckSnapshot) => {
  const effectiveDurationSec = Math.max(0, Number(snapshot.effectiveDurationSec) || 0)
  if (effectiveDurationSec > 0) return effectiveDurationSec
  return Math.max(0, Number(snapshot.durationSec) || 0)
}

const assignDeckRenderCurrentSeconds = (
  deck: DeckKey,
  seconds: number,
  topDeckRenderCurrentSeconds: { value: number },
  bottomDeckRenderCurrentSeconds: { value: number },
  atMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
) => {
  if (deck === 'top') {
    topDeckRenderCurrentSeconds.value = seconds
    publishHorizontalBrowseLinkedGridRenderClock('up', seconds, atMs)
    return
  }
  bottomDeckRenderCurrentSeconds.value = seconds
  publishHorizontalBrowseLinkedGridRenderClock('down', seconds, atMs)
}

export const useHorizontalBrowseRenderSync = (params: UseHorizontalBrowseRenderSyncParams) => {
  const topDeckRenderCurrentSeconds = ref(0)
  const bottomDeckRenderCurrentSeconds = ref(0)
  const topDeckPlaybackSyncRevision = ref(0)
  const bottomDeckPlaybackSyncRevision = ref(0)
  const auditionPresentationSuspended = ref(false)
  const auditionPresentationFrozenSec: Record<DeckKey, number> = {
    top: 0,
    bottom: 0
  }

  const deckRenderSyncBaseSec = reactive<Record<DeckKey, number>>({
    top: 0,
    bottom: 0
  })
  const deckRenderSyncBaseAtMs = reactive<Record<DeckKey, number>>({
    top: 0,
    bottom: 0
  })
  const deckRenderTimelineSignature = reactive<Record<DeckKey, string>>({
    top: '',
    bottom: ''
  })
  const deckRenderStateRevision = reactive<Record<DeckKey, number>>({
    top: 0,
    bottom: 0
  })
  const pendingRenderSeekIntent = reactive<Record<DeckKey, PendingRenderSeekIntent | null>>({
    top: null,
    bottom: null
  })
  const pendingRenderPositionHold = reactive<Record<DeckKey, PendingRenderSeekIntent | null>>({
    top: null,
    bottom: null
  })
  const recentRenderSeekIntent = reactive<Record<DeckKey, PendingRenderSeekIntent | null>>({
    top: null,
    bottom: null
  })

  let renderSyncRaf = 0
  let transportSnapshotInFlight = false
  let lastTransportSnapshotAt = 0

  const resolveAuditionSuspended = () =>
    auditionPresentationSuspended.value || params.nativeTransport.state?.auditionSuspended === true

  const lastClockPlaybackRate: Record<DeckKey, number | null> = {
    top: null,
    bottom: null
  }

  const estimateDeckRenderCurrentSeconds = (deck: DeckKey, nowMs = performance.now()) => {
    if (auditionPresentationSuspended.value) {
      return auditionPresentationFrozenSec[deck]
    }
    const pendingHold = pendingRenderPositionHold[deck]
    if (pendingHold && nowMs - pendingHold.startedAtMs < RENDER_SYNC_POSITION_HOLD_MAX_MS) {
      return pendingHold.seconds
    }
    const pendingIntent = pendingRenderSeekIntent[deck]
    if (pendingIntent) return pendingIntent.seconds
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const renderLimitSec = resolveDeckRenderLimitSec(snapshot)
    const liveClockRate = params.nativeTransport.resolveLiveClockPlaybackRate?.(deck)
    const playbackRate = Math.max(0.25, Number(liveClockRate ?? snapshot.playbackRate) || 1)
    const previousClockRate = lastClockPlaybackRate[deck]
    const baseSec = normalizeTimelineSeconds(deckRenderSyncBaseSec[deck])
    const baseAtMs = Math.max(0, Number(deckRenderSyncBaseAtMs[deck]) || 0)
    const canEstimatePlayback =
      !resolveAuditionSuspended() &&
      baseAtMs > 0 &&
      (snapshot.playingAudible || (snapshot.playing && baseSec < 0))
    if (canEstimatePlayback && previousClockRate != null) {
      const rebased = rebaseHorizontalBrowsePlaybackClock(
        deckRenderSyncBaseSec[deck],
        deckRenderSyncBaseAtMs[deck],
        previousClockRate,
        playbackRate,
        nowMs
      )
      deckRenderSyncBaseSec[deck] = rebased.baseSec
      deckRenderSyncBaseAtMs[deck] = rebased.baseAtMs
    }
    lastClockPlaybackRate[deck] = playbackRate
    const nextBaseSec = normalizeTimelineSeconds(deckRenderSyncBaseSec[deck])
    const nextBaseAtMs = Math.max(0, Number(deckRenderSyncBaseAtMs[deck]) || 0)
    const deltaSec = canEstimatePlayback ? Math.max(0, nowMs - nextBaseAtMs) / 1000 : 0
    const nextSec = nextBaseSec + deltaSec * playbackRate
    return renderLimitSec > 0 ? Math.min(renderLimitSec, nextSec) : nextSec
  }

  const resolveDeckRenderCurrentSeconds = (deck: DeckKey) => estimateDeckRenderCurrentSeconds(deck)

  // 只有时间线坐标会变的字段才能触发渲染重锚；解码/可听状态变化不能打断负时间外推。
  const buildDeckRenderTimelineSignature = (snapshot: HorizontalBrowseTransportDeckSnapshot) =>
    [
      snapshot.label || '',
      snapshot.loaded ? 1 : 0,
      snapshot.playing ? 1 : 0,
      Number(snapshot.durationSec || 0).toFixed(3),
      Number(snapshot.effectiveDurationSec || 0).toFixed(3),
      Number(snapshot.playbackRate || 1).toFixed(6),
      snapshot.loopActive ? 1 : 0,
      Number(snapshot.loopStartSec || 0).toFixed(6),
      Number(snapshot.loopEndSec || 0).toFixed(6)
    ].join('|')

  const resolveTransportStateRevision = () => {
    const revision = Number(params.nativeTransport.state?.stateRevision)
    return Number.isFinite(revision) ? Math.max(0, Math.floor(revision)) : 0
  }

  const resolveForcedDecks = (target?: HorizontalBrowseRenderSyncTarget) => {
    if (!target) return new Set<DeckKey>()
    if (target === 'all') return new Set<DeckKey>(['top', 'bottom'])
    return new Set<DeckKey>(Array.isArray(target) ? target : [target])
  }

  const bumpDeckPlaybackSyncRevision = (deck: DeckKey) => {
    if (deck === 'top') {
      topDeckPlaybackSyncRevision.value += 1
      return
    }
    bottomDeckPlaybackSyncRevision.value += 1
  }

  const syncDeckFromSnapshot = (
    deck: DeckKey,
    snapshotAtMs: number,
    renderNowMs: number,
    force: boolean,
    forceRevision: boolean,
    preserveRevision: boolean
  ) => {
    if (auditionPresentationSuspended.value) {
      assignDeckRenderCurrentSeconds(
        deck,
        auditionPresentationFrozenSec[deck],
        topDeckRenderCurrentSeconds,
        bottomDeckRenderCurrentSeconds,
        renderNowMs
      )
      return
    }
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const snapshotSec = normalizeTimelineSeconds(snapshot.renderCurrentSec)
    const estimatedSec = estimateDeckRenderCurrentSeconds(deck, snapshotAtMs)
    const renderEstimatedSec = estimateDeckRenderCurrentSeconds(deck, renderNowMs)
    const pendingHold = pendingRenderPositionHold[deck]
    const holdExpired =
      pendingHold && renderNowMs - pendingHold.startedAtMs >= RENDER_SYNC_POSITION_HOLD_MAX_MS
    const holdConfirmed =
      pendingHold &&
      Math.abs(snapshotSec - pendingHold.seconds) <= RENDER_SYNC_FULL_SYNC_PHASE_REANCHOR_SEC
    if (pendingHold && !holdExpired && !holdConfirmed) {
      assignDeckRenderCurrentSeconds(
        deck,
        pendingHold.seconds,
        topDeckRenderCurrentSeconds,
        bottomDeckRenderCurrentSeconds
      )
      return
    }
    pendingRenderPositionHold[deck] = null
    const pendingIntent = pendingRenderSeekIntent[deck]
    let confirmedPendingIntent = false
    if (pendingIntent) {
      const intentAgeMs = renderNowMs - pendingIntent.startedAtMs
      const pendingEstimatedSec = pendingIntent.seconds
      const nativeConfirmedNegativeIntent =
        pendingIntent.seconds < -TIMELINE_ZERO_EPSILON_SEC &&
        snapshotSec < -TIMELINE_ZERO_EPSILON_SEC
      const shouldKeepNegativeIntent =
        pendingIntent.seconds < -TIMELINE_ZERO_EPSILON_SEC &&
        !nativeConfirmedNegativeIntent &&
        pendingEstimatedSec < -TIMELINE_ZERO_EPSILON_SEC
      if (shouldKeepNegativeIntent) {
        pendingRenderSeekIntent[deck] = {
          seconds: pendingEstimatedSec,
          startedAtMs: renderNowMs
        }
        deckRenderSyncBaseSec[deck] = pendingEstimatedSec
        deckRenderSyncBaseAtMs[deck] = renderNowMs
        assignDeckRenderCurrentSeconds(
          deck,
          pendingEstimatedSec,
          topDeckRenderCurrentSeconds,
          bottomDeckRenderCurrentSeconds
        )
        return
      }
      const intentConfirmed =
        Math.abs(snapshotSec - pendingIntent.seconds) <= RENDER_SYNC_PENDING_INTENT_EPSILON_SEC
      const intentExpired = intentAgeMs >= RENDER_SYNC_PENDING_INTENT_MAX_MS
      if (!force && !intentConfirmed && !intentExpired) {
        const nextSec = estimateDeckRenderCurrentSeconds(deck, renderNowMs)
        assignDeckRenderCurrentSeconds(
          deck,
          nextSec,
          topDeckRenderCurrentSeconds,
          bottomDeckRenderCurrentSeconds
        )
        return
      }
      // intent 过期但 native snapshot 仍未确认到目标位置（连续快速 seek 时 snapshot 滞后）：
      // 不要 reanchor 回滞后的 snapshotSec（那会让渲染位置一次性回退到旧位置，造成抽动），
      // 而是把渲染基准锚定到 intent 目标值继续。后续 snapshot 一旦真正到位会通过正常 reanchor 修正。
      if (!force && intentExpired && !intentConfirmed) {
        const expiredIntentSec = pendingIntent.seconds
        pendingRenderSeekIntent[deck] = null
        deckRenderSyncBaseSec[deck] = expiredIntentSec
        deckRenderSyncBaseAtMs[deck] = renderNowMs
        deckRenderTimelineSignature[deck] = buildDeckRenderTimelineSignature(snapshot)
        deckRenderStateRevision[deck] = resolveTransportStateRevision()
        assignDeckRenderCurrentSeconds(
          deck,
          expiredIntentSec,
          topDeckRenderCurrentSeconds,
          bottomDeckRenderCurrentSeconds
        )
        return
      }
      pendingRenderSeekIntent[deck] = null
      confirmedPendingIntent = intentConfirmed
    }
    const signature = buildDeckRenderTimelineSignature(snapshot)
    const previousSignature = deckRenderTimelineSignature[deck]
    const signatureChanged = previousSignature !== signature
    const transportStateRevision = resolveTransportStateRevision()
    const previousStateRevision = deckRenderStateRevision[deck]
    const stateRevisionChanged =
      transportStateRevision > 0 &&
      previousStateRevision > 0 &&
      transportStateRevision !== previousStateRevision
    const auditionSuspended = resolveAuditionSuspended()
    const playbackSnapshotAuthoritative =
      auditionSuspended || !snapshot.playing || snapshot.playingAudible
    const previousBaseAtMs = deckRenderSyncBaseAtMs[deck]
    const stalePlayingSnapshot =
      !force &&
      !auditionSuspended &&
      snapshot.playing &&
      previousSignature === signature &&
      snapshotAtMs + 1 < previousBaseAtMs
    if (stalePlayingSnapshot) {
      const nextSec = estimateDeckRenderCurrentSeconds(deck, renderNowMs)
      assignDeckRenderCurrentSeconds(
        deck,
        nextSec,
        topDeckRenderCurrentSeconds,
        bottomDeckRenderCurrentSeconds,
        renderNowMs
      )
      return
    }
    const driftSec = Math.abs(snapshotSec - estimatedSec)
    const recentIntent = recentRenderSeekIntent[deck]
    const recentIntentAgeMs = recentIntent
      ? Math.max(0, renderNowMs - recentIntent.startedAtMs)
      : Number.POSITIVE_INFINITY
    const forceConfirmsRecentIntent =
      force &&
      !confirmedPendingIntent &&
      !!recentIntent &&
      recentIntentAgeMs <= RENDER_SYNC_RECENT_INTENT_CONFIRM_MS &&
      Math.abs(snapshotSec - recentIntent.seconds) <= RENDER_SYNC_PENDING_INTENT_EPSILON_SEC
    const fullSyncPhaseChanged =
      stateRevisionChanged &&
      snapshot.syncEnabled &&
      snapshot.syncLock === 'full' &&
      playbackSnapshotAuthoritative &&
      driftSec >= RENDER_SYNC_FULL_SYNC_PHASE_REANCHOR_SEC
    const shouldReanchor =
      force ||
      auditionSuspended ||
      !previousSignature ||
      !snapshot.playing ||
      signatureChanged ||
      fullSyncPhaseChanged ||
      (playbackSnapshotAuthoritative && driftSec >= RENDER_SYNC_REANCHOR_DRIFT_SEC)
    const shouldBumpPlaybackRevision =
      !preserveRevision &&
      ((shouldReanchor && forceRevision) ||
        (shouldReanchor &&
          !confirmedPendingIntent &&
          !forceConfirmsRecentIntent &&
          (force ||
            fullSyncPhaseChanged ||
            (snapshot.playing &&
              (!previousSignature || driftSec >= RENDER_SYNC_REANCHOR_DRIFT_SEC)))))
    const visualPending = params.linkedGridVisualPending?.() === true
    const suppressedByVisualPending = visualPending && !force

    if (suppressedByVisualPending) {
      assignDeckRenderCurrentSeconds(
        deck,
        renderEstimatedSec,
        topDeckRenderCurrentSeconds,
        bottomDeckRenderCurrentSeconds,
        renderNowMs
      )
      return
    }

    if (shouldReanchor) {
      deckRenderSyncBaseSec[deck] = snapshotSec
      deckRenderSyncBaseAtMs[deck] = snapshotAtMs
      if (shouldBumpPlaybackRevision) {
        bumpDeckPlaybackSyncRevision(deck)
      }
    }
    deckRenderTimelineSignature[deck] = signature
    deckRenderStateRevision[deck] = transportStateRevision

    const nextSec = shouldReanchor
      ? estimateDeckRenderCurrentSeconds(deck, renderNowMs)
      : renderEstimatedSec
    assignDeckRenderCurrentSeconds(
      deck,
      nextSec,
      topDeckRenderCurrentSeconds,
      bottomDeckRenderCurrentSeconds
    )
  }

  const syncDeckRenderState = (
    input: number | HorizontalBrowseRenderSyncOptions = performance.now()
  ) => {
    const nowMs = typeof input === 'number' ? input : (input.nowMs ?? performance.now())
    const snapshotAtMs = typeof input === 'number' ? nowMs : (input.snapshotAtMs ?? nowMs)
    const forcedDecks = resolveForcedDecks(typeof input === 'number' ? undefined : input.force)
    const forceRevision = typeof input === 'number' ? false : input.forceRevision === true
    const preserveRevision = typeof input === 'number' ? false : input.preserveRevision === true
    if (forcedDecks.size > 0) {
      for (const deck of forcedDecks) {
        syncDeckFromSnapshot(deck, snapshotAtMs, nowMs, true, forceRevision, preserveRevision)
      }
      return
    }
    syncDeckFromSnapshot('top', snapshotAtMs, nowMs, false, false, false)
    syncDeckFromSnapshot('bottom', snapshotAtMs, nowMs, false, false, false)
  }

  const setAuditionPresentationSuspended = (suspended: boolean) => {
    if (auditionPresentationSuspended.value === suspended) return
    const nowMs = performance.now()
    for (const deck of ['top', 'bottom'] as const) {
      const snapshot = params.resolveTransportDeckSnapshot(deck)
      const frozenSec = normalizeTimelineSeconds(snapshot.renderCurrentSec)
      auditionPresentationFrozenSec[deck] = frozenSec
      deckRenderSyncBaseSec[deck] = frozenSec
      deckRenderSyncBaseAtMs[deck] = nowMs
      assignDeckRenderCurrentSeconds(
        deck,
        frozenSec,
        topDeckRenderCurrentSeconds,
        bottomDeckRenderCurrentSeconds,
        nowMs
      )
    }
    auditionPresentationSuspended.value = suspended
  }

  // 强制把某条 deck 的"渲染当前播放位置"立刻拉到指定秒数。
  // 和 syncDeckRenderState() 读取 nativeTransport snapshot 不同，这里是"目标优先"：
  //   点 cue / 拖动落点 / 概览点击等会发起 seek 的交互，发起瞬间就知道最终要到的位置，
  //   但 nativeTransport.seek 的 IPC 来回要 10~30ms，这期间如果放任：
  //     * startRenderSyncLoop 的 RAF tick 会用 playing=true&baseSec=旧值 继续外推，
  //       把 topDeckRenderCurrentSeconds 往前推；
  //     * HorizontalBrowseRawWaveformDetail 会继续吃旧的 currentSeconds，
  //       previewStartSec / 大波形 canvas 还会沿着旧时间基准往前滚几个像素；
  //   视觉上就是"点了 cue 波形先往前跳一下再顿住"。
  //
  // 通过在 notifyDeckSeekIntent 里先调用本函数，把 baseSec=目标秒、baseAtMs=now、
  // topDeckRenderCurrentSeconds.value=目标秒 一起提交，相当于让所有依赖渲染时间的插值器
  // 立刻 teleport 到新位置：
  //   * RAF tick: pending seek 确认前固定返回目标秒，避免联结模式下另一轨
  //     先沿旧播放状态外推一小段再被 native seek 拉回。
  //   * currentSeconds watcher: 大波形收到新的 topDeckRenderCurrentSeconds 后会立刻把
  //     previewStartSec 推到目标秒对应的位置，不会再沿着旧位置继续外推。
  //   * drawWaveform: previewStartSec 经 watcher → applyPreviewPlaybackPosition 推到
  //     目标秒 - visible/2，配合 rawData 覆盖判断立刻进入 stream-live，用户看到大波形
  //     瞬间锚定在目标位置。
  //
  // 当真正的 nativeTransport.seek IPC 完成后，调用方仍然会 syncDeckRenderState() 兜底一次，
  // 那时 snapshot.renderCurrentSec 已经是目标秒，本函数的提交与之一致，不会造成回跳。
  const applyDeckRenderCurrentSeconds = (deck: DeckKey, seconds: number) => {
    const nowMs = performance.now()
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const renderLimitSec = resolveDeckRenderLimitSec(snapshot)
    const normalizedSeconds = normalizeTimelineSeconds(seconds)
    const safeSeconds =
      renderLimitSec > 0 ? Math.min(normalizedSeconds, renderLimitSec) : normalizedSeconds
    pendingRenderPositionHold[deck] = null
    pendingRenderSeekIntent[deck] = {
      seconds: safeSeconds,
      startedAtMs: nowMs
    }
    recentRenderSeekIntent[deck] = {
      seconds: safeSeconds,
      startedAtMs: nowMs
    }
    deckRenderSyncBaseSec[deck] = safeSeconds
    deckRenderSyncBaseAtMs[deck] = nowMs
    bumpDeckPlaybackSyncRevision(deck)
    assignDeckRenderCurrentSeconds(
      deck,
      safeSeconds,
      topDeckRenderCurrentSeconds,
      bottomDeckRenderCurrentSeconds,
      nowMs
    )
  }

  const holdDeckRenderCurrentSeconds = (deck: DeckKey, seconds: number) => {
    const nowMs = performance.now()
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const renderLimitSec = resolveDeckRenderLimitSec(snapshot)
    const normalizedSeconds = normalizeTimelineSeconds(seconds)
    const safeSeconds =
      renderLimitSec > 0 ? Math.min(normalizedSeconds, renderLimitSec) : normalizedSeconds
    pendingRenderPositionHold[deck] = {
      seconds: safeSeconds,
      startedAtMs: nowMs
    }
    deckRenderSyncBaseSec[deck] = safeSeconds
    deckRenderSyncBaseAtMs[deck] = nowMs
    assignDeckRenderCurrentSeconds(
      deck,
      safeSeconds,
      topDeckRenderCurrentSeconds,
      bottomDeckRenderCurrentSeconds,
      nowMs
    )
  }

  const startDeckRenderPlaybackClock = (deck: DeckKey, seconds: number) => {
    const nowMs = performance.now()
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const renderLimitSec = resolveDeckRenderLimitSec(snapshot)
    const normalizedSeconds = normalizeTimelineSeconds(seconds)
    const safeSeconds =
      renderLimitSec > 0 ? Math.min(normalizedSeconds, renderLimitSec) : normalizedSeconds
    pendingRenderPositionHold[deck] = null
    deckRenderSyncBaseSec[deck] = safeSeconds
    deckRenderSyncBaseAtMs[deck] = nowMs
    assignDeckRenderCurrentSeconds(
      deck,
      safeSeconds,
      topDeckRenderCurrentSeconds,
      bottomDeckRenderCurrentSeconds,
      nowMs
    )
  }

  const syncNativeTransportNow = async () => {
    const snapshotAtMs = performance.now()
    await params.nativeTransport.snapshot(snapshotAtMs)
    syncDeckRenderState({
      nowMs: performance.now(),
      snapshotAtMs
    })
  }

  const markTransportStateFresh = (nowMs = performance.now()) => {
    lastTransportSnapshotAt = nowMs
  }

  const stopRenderSyncLoop = () => {
    if (!renderSyncRaf) return
    cancelAnimationFrame(renderSyncRaf)
    renderSyncRaf = 0
    transportSnapshotInFlight = false
  }

  const startRenderSyncLoop = (handleDeckLoopPlaybackTick: (deck: DeckKey) => void) => {
    stopRenderSyncLoop()
    const tick = () => {
      const nowMs = performance.now()
      if (!resolveAuditionSuspended()) {
        handleDeckLoopPlaybackTick('top')
        handleDeckLoopPlaybackTick('bottom')
      }
      const topSeconds = estimateDeckRenderCurrentSeconds('top', nowMs)
      const bottomSeconds = estimateDeckRenderCurrentSeconds('bottom', nowMs)
      topDeckRenderCurrentSeconds.value = topSeconds
      bottomDeckRenderCurrentSeconds.value = bottomSeconds
      publishHorizontalBrowseLinkedGridRenderClockPair(topSeconds, bottomSeconds, nowMs)
      const topPlaying = params.resolveDeckPlaying('top')
      const bottomPlaying = params.resolveDeckPlaying('bottom')
      const pollIntervalMs =
        topPlaying || bottomPlaying
          ? TRANSPORT_SNAPSHOT_FALLBACK_INTERVAL_PLAYING_MS
          : TRANSPORT_SNAPSHOT_FALLBACK_INTERVAL_IDLE_MS
      if (!transportSnapshotInFlight && nowMs - lastTransportSnapshotAt >= pollIntervalMs) {
        transportSnapshotInFlight = true
        markTransportStateFresh(nowMs)
        void syncNativeTransportNow()
          .catch(() => {})
          .finally(() => {
            transportSnapshotInFlight = false
          })
      }
      renderSyncRaf = requestAnimationFrame(tick)
    }
    tick()
  }

  return {
    topDeckRenderCurrentSeconds,
    bottomDeckRenderCurrentSeconds,
    topDeckPlaybackSyncRevision,
    bottomDeckPlaybackSyncRevision,
    auditionPresentationSuspended,
    resolveDeckRenderCurrentSeconds,
    syncDeckRenderState,
    setAuditionPresentationSuspended,
    markTransportStateFresh,
    applyDeckRenderCurrentSeconds,
    holdDeckRenderCurrentSeconds,
    startDeckRenderPlaybackClock,
    startRenderSyncLoop,
    stopRenderSyncLoop
  }
}
