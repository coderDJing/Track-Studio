import { resolveContextMenuPoint } from '@renderer/utils/contextMenuPosition'
import type ConfirmDialog from '@renderer/components/confirmDialog'
import { FIXED_MIXTAPE_STEM_MODE } from '@shared/mixtapeStemMode'
import {
  applyMixtapeGlobalTempoTargetsToTracks,
  buildFlatMixtapeGlobalBpmEnvelope,
  buildDefaultMixtapeGlobalBpmEnvelopeSnapshot,
  normalizeMixtapeGlobalBpmEnvelopePoints,
  resolveDefaultMixtapeGlobalGridPhaseOffsetSec,
  resolveDefaultGlobalBpmFromTracks
} from '@renderer/composables/mixtape/mixtapeGlobalTempoModel'
import { createMixtapeMasterGrid } from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  resolveMixtapeAudioBeatGridMap,
  resolveMixtapeAudioFirstBeatSec
} from '@renderer/composables/mixtape/mixtapeAudioGridBasis'
import {
  applyMixtapeGlobalTempoSnapshot,
  isMixtapeGlobalTempoReady,
  mixtapeGlobalTempoEnvelope,
  mixtapeGlobalTempoSource,
  resetMixtapeGlobalTempoState
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import { resolveBeatSecByBpm } from '@renderer/composables/mixtape/beatSyncModel'
import {
  BPM_POINT_SEC_EPSILON,
  resolveTrackGridSourceBpm,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import { createDynamicSourceBeatMap } from '@renderer/composables/mixtape/trackTimeMapCore'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMixMode,
  MixtapeOpenPayload,
  MixtapeRawItem,
  MixtapeStemProfile,
  MixtapeStemStatus,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'
import type {
  MixtapeOutputProgressPayload,
  MixtapeRenderedWavResult
} from '@renderer/composables/mixtape/timelineTransportRenderWav'
import type {
  MixtapeStemSummary,
  StemRuntimeProgressEntry
} from '@renderer/composables/mixtape/useMixtapeStemRuntimeModule'
import type { MixtapeOutputProgressState } from '@renderer/composables/mixtape/mixtapeOutputProgress'
import { createMixtapeOutputUi } from '@renderer/composables/mixtape/mixtapeOutputUi'
import { createMixtapeWindowInputHandlers } from '@renderer/composables/mixtape/mixtapeWindowInput'
import {
  createMixtapeBeatAlignGridDefinitionSaver,
  type MixtapeEnvelopeField
} from '@renderer/composables/mixtape/mixtapeBeatAlignGridDefinitionSave'
type TrackMenuContextItem = {
  track?: {
    id?: string | null
  } | null
}
type BpmBatchReadyPayload = {
  results?: BpmAnalysisResultItem[]
}
type MixtapeListPayload = {
  items?: MixtapeRawItem[]
  recovery?: {
    removedPaths?: string[]
  }
  mixMode?: unknown
  stemProfile?: unknown
  stemSummary?: unknown
}
type BpmAnalysisResultItem = {
  filePath?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  downbeatBeatOffset?: unknown
  timeBasisOffsetMs?: unknown
}

type ValueRef<T> = {
  value: T
}

type UseMixtapeBpmAndUiModuleContext = {
  payload: ValueRef<MixtapeOpenPayload>
  tracks: ValueRef<MixtapeTrack[]>
  mixtapeRawItems: ValueRef<MixtapeRawItem[]>
  mixtapeItemsLoading: ValueRef<boolean>
  selectedTrackId: ValueRef<string>
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
  trackContextMenuVisible: ValueRef<boolean>
  trackContextMenuX: ValueRef<number>
  trackContextMenuY: ValueRef<number>
  trackContextTrackId: ValueRef<string>
  beatAlignDialogVisible: ValueRef<boolean>
  beatAlignTrackId: ValueRef<string>
  bpmAnalysisActive: ValueRef<boolean>
  bpmAnalysisFailed: ValueRef<boolean>
  bpmAnalysisFailedCount: ValueRef<number>
  bpmAnalysisFailedReason: ValueRef<string>
  stemSummary: ValueRef<MixtapeStemSummary>
  stemRuntimeProgressByTrackId: ValueRef<Record<string, StemRuntimeProgressEntry>>
  stemResumeBootstrappedPlaylistIdSet: Set<string>
  stemResumeSignatureByPlaylistId: Map<string, unknown>
  autoGainDialogVisible: ValueRef<boolean>
  transportPreloading: ValueRef<boolean>
  transportPlaying: ValueRef<boolean>
  transportDecoding: ValueRef<boolean>
  createEmptyStemSummary: () => MixtapeStemSummary
  applyBpmAnalysisToTracks: (results: BpmAnalysisResultItem[]) => { resolvedCount: number }
  buildBpmTargets: () => string[]
  resolveMissingBpmCount: (targets: Set<string>) => number
  buildMixtapeBpmTargetKey: (filePaths: string[]) => string
  scheduleTimelineDraw: () => void
  scheduleFullPreRender: () => void
  scheduleWorkerPreRender: () => void
  clearTimelineLayoutCache: () => void
  updateTimelineWidth: (allowAutoFit?: boolean) => void
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
  resolveTrackTitle: (track: MixtapeTrack) => string
  renderMixtapeOutputWav: (params: {
    onProgress: (payload: MixtapeOutputProgressPayload) => void
  }) => Promise<MixtapeRenderedWavResult>
  normalizeMixtapeFilePath: (value: unknown) => string
  normalizeMixtapeMixMode: (value: unknown) => MixtapeMixMode
  normalizeMixtapeStemMode: (value: unknown) => string
  normalizeStemProfile: (value: unknown, fallback?: MixtapeStemProfile) => MixtapeStemProfile
  normalizeMixtapeStemStatus: (value: unknown) => MixtapeStemStatus
  normalizeStemSummary: (value: unknown) => MixtapeStemSummary
  normalizeUniquePaths: (values: unknown[]) => string[]
  parseSnapshot: (raw: MixtapeRawItem, index: number, unknownTrackLabel: string) => MixtapeTrack
  hasTrackStemPathsReady: (track: MixtapeTrack, stemMode: unknown) => boolean
  autoResumePendingStemJobs: (params: {
    playlistId: string
    stemMode: unknown
    trackList: MixtapeTrack[]
    includeRunning?: boolean
  }) => Promise<void>
  pruneStemRuntimeProgressByTracks: (tracks: MixtapeTrack[]) => void
  resolveTrackStemModel: (track: MixtapeTrack) => string
  syncAutoGainReferenceTrack: () => void
  resetAutoGainState: () => void
  notifyMissingTracksRemoved: (playlistId: string, removedPaths: string[]) => Promise<void> | void
  resolveMixtapeStemModelByProfile: (profile: MixtapeStemProfile) => string
  resolveMixtapeOutputProgressState: (
    current: MixtapeOutputProgressState,
    nextPayload?: MixtapeOutputProgressPayload | null
  ) => MixtapeOutputProgressState
  normalizeDownbeatBeatOffset: (value: unknown) => number
  normalizeFirstBeatMs: (value: unknown) => number
  normalizeBpm: (value: unknown) => number | null
  MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL: MixtapeEnvelopeParamId[]
  MIXTAPE_ENVELOPE_PARAMS_STEM: MixtapeEnvelopeParamId[]
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM: Record<MixtapeEnvelopeParamId, MixtapeEnvelopeField>
  buildFlatMixEnvelope: (
    param: MixtapeEnvelopeParamId,
    durationSec: number,
    gain?: number
  ) => MixtapeGainPoint[]
  normalizeMixEnvelopePoints: (
    param: MixtapeEnvelopeParamId,
    value: unknown,
    durationSec?: number
  ) => MixtapeGainPoint[]
  DEFAULT_MIXTAPE_STEM_PROFILE: MixtapeStemProfile
  confirmDialog: typeof ConfirmDialog
  t: (key: string, payload?: Record<string, unknown>) => string
  handleTransportStop: () => void
  handleTransportPlayFromStart: () => void
}

export const createUseMixtapeBpmAndUiModule = (ctx: UseMixtapeBpmAndUiModuleContext) => {
  const {
    payload,
    tracks,
    mixtapeRawItems,
    mixtapeItemsLoading,
    selectedTrackId,
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
    trackContextMenuVisible,
    trackContextMenuX,
    trackContextMenuY,
    trackContextTrackId,
    beatAlignDialogVisible,
    beatAlignTrackId,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    bpmAnalysisFailedCount,
    bpmAnalysisFailedReason,
    stemSummary,
    stemRuntimeProgressByTrackId,
    stemResumeBootstrappedPlaylistIdSet,
    stemResumeSignatureByPlaylistId,
    autoGainDialogVisible,
    transportPreloading,
    transportPlaying,
    transportDecoding,
    createEmptyStemSummary,
    applyBpmAnalysisToTracks,
    buildBpmTargets,
    resolveMissingBpmCount,
    buildMixtapeBpmTargetKey,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    clearTimelineLayoutCache,
    updateTimelineWidth,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackTitle,
    renderMixtapeOutputWav,
    normalizeMixtapeFilePath,
    normalizeMixtapeMixMode,
    normalizeStemProfile,
    normalizeMixtapeStemStatus,
    normalizeStemSummary,
    normalizeUniquePaths,
    parseSnapshot,
    hasTrackStemPathsReady,
    autoResumePendingStemJobs,
    pruneStemRuntimeProgressByTracks,
    resolveTrackStemModel,
    syncAutoGainReferenceTrack,
    resetAutoGainState,
    notifyMissingTracksRemoved,
    resolveMixtapeStemModelByProfile,
    resolveMixtapeOutputProgressState,
    normalizeDownbeatBeatOffset,
    normalizeBpm,
    MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL,
    MIXTAPE_ENVELOPE_PARAMS_STEM,
    MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
    buildFlatMixEnvelope,
    normalizeMixEnvelopePoints,
    DEFAULT_MIXTAPE_STEM_PROFILE,
    confirmDialog,
    t,
    handleTransportStop,
    handleTransportPlayFromStart
  } = ctx

  let bpmAnalysisToken = 0
  let lastBpmAnalysisKey = ''
  let mixtapeItemsRequestToken = 0

  const syncTracksWithGlobalTempo = () => {
    if (!isMixtapeGlobalTempoReady()) return
    tracks.value = applyMixtapeGlobalTempoTargetsToTracks(
      tracks.value,
      mixtapeGlobalTempoEnvelope.value
    )
  }

  const refreshTimelineForGlobalTempoChange = (options?: {
    redrawOnly?: boolean
    refreshWaveform?: boolean
  }) => {
    syncTracksWithGlobalTempo()
    clearTimelineLayoutCache()
    updateTimelineWidth(false)
    scheduleTimelineDraw()
    if (options?.redrawOnly) return
    if (options?.refreshWaveform !== false) {
      scheduleFullPreRender()
      scheduleWorkerPreRender()
    }
  }

  const ensureDefaultGlobalTempoEnvelope = (
    playlistId: string,
    options?: { refreshWaveform?: boolean }
  ) => {
    const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
    if (!normalizedPlaylistId || !tracks.value.length) return
    if (
      mixtapeGlobalTempoSource.value === 'persisted' ||
      mixtapeGlobalTempoSource.value === 'user'
    ) {
      return
    }
    const nextSnapshot = buildDefaultMixtapeGlobalBpmEnvelopeSnapshot({
      tracks: tracks.value,
      resolveTrackDurationSeconds,
      resolveTrackSourceDurationSeconds,
      resolveTrackFirstBeatSeconds
    })
    applyMixtapeGlobalTempoSnapshot({
      playlistId: normalizedPlaylistId,
      snapshot: nextSnapshot,
      source: 'generated'
    })
    refreshTimelineForGlobalTempoChange({
      refreshWaveform: options?.refreshWaveform !== false
    })
  }

  const readNormalizedProjectGlobalTempoSnapshot = async (
    playlistId: string,
    trackList: MixtapeTrack[]
  ) => {
    const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
    if (!normalizedPlaylistId || !window?.electron?.ipcRenderer?.invoke) {
      return null
    }
    try {
      const result = await window.electron.ipcRenderer.invoke('mixtape:project:get-bpm-envelope', {
        playlistId: normalizedPlaylistId
      })
      const defaultBpm = resolveDefaultGlobalBpmFromTracks(trackList)
      const derivedPhaseOffsetSec = resolveDefaultMixtapeGlobalGridPhaseOffsetSec({
        tracks: trackList,
        resolveTrackSourceDurationSeconds,
        resolveTrackFirstBeatSeconds
      })
      const normalizedSnapshot = {
        bpmEnvelope: normalizeMixtapeGlobalBpmEnvelopePoints(
          result?.bpmEnvelope,
          Number(result?.bpmEnvelopeDurationSec) || 0,
          defaultBpm
        ),
        bpmEnvelopeDurationSec: Math.max(0, Number(result?.bpmEnvelopeDurationSec) || 0),
        gridPhaseOffsetSec:
          Number.isFinite(Number(result?.gridPhaseOffsetSec)) &&
          Number(result?.gridPhaseOffsetSec) >= 0
            ? roundTrackTempoSec(Number(result?.gridPhaseOffsetSec))
            : derivedPhaseOffsetSec
      }
      if (
        normalizedSnapshot.bpmEnvelope.length >= 2 &&
        normalizedSnapshot.bpmEnvelopeDurationSec > 0
      ) {
        return normalizedSnapshot
      }
    } catch (error) {
      console.error('[mixtape] load project bpm envelope failed', {
        playlistId: normalizedPlaylistId,
        error
      })
    }
    return null
  }

  const materializeGridAlignedTrackStartSecs = (
    inputTracks: MixtapeTrack[],
    globalSnapshot: {
      bpmEnvelope?: Array<{ sec: number; bpm: number }>
      gridPhaseOffsetSec?: number
    }
  ) => {
    const GRID_ALIGN_DOWNBEAT_INTERVAL = 4
    const fallbackBpm = resolveDefaultGlobalBpmFromTracks(inputTracks)
    const safePoints =
      Array.isArray(globalSnapshot?.bpmEnvelope) && globalSnapshot.bpmEnvelope.length >= 2
        ? globalSnapshot.bpmEnvelope
        : buildFlatMixtapeGlobalBpmEnvelope(0, fallbackBpm)
    const masterGrid = createMixtapeMasterGrid({
      points: safePoints,
      fallbackBpm,
      phaseOffsetSec: globalSnapshot?.gridPhaseOffsetSec
    })
    let cursorSec = 0
    const persistedEntries: Array<{ itemId: string; startSec: number }> = []
    const nextTracks = inputTracks.map((track: MixtapeTrack) => {
      const rawStartSec = Number(track?.startSec)
      const hasExplicitStartSec = Number.isFinite(rawStartSec)
      const sourceDurationSec = Math.max(0, Number(resolveTrackSourceDurationSeconds(track)) || 0)
      const gridSourceBpm = resolveTrackGridSourceBpm(track)
      const beatSourceSec = Math.max(BPM_POINT_SEC_EPSILON, resolveBeatSecByBpm(gridSourceBpm))
      const dynamicSourceBeatMap = createDynamicSourceBeatMap(
        resolveMixtapeAudioBeatGridMap(track, sourceDurationSec),
        sourceDurationSec
      )
      const firstBeatSourceSec = resolveMixtapeAudioFirstBeatSec(track)
      const firstBeatSourceBeats = dynamicSourceBeatMap
        ? dynamicSourceBeatMap.firstBeatDelta
        : firstBeatSourceSec / beatSourceSec
      const sourceDurationBeats = dynamicSourceBeatMap
        ? dynamicSourceBeatMap.beatSpan
        : sourceDurationSec / beatSourceSec
      const normalizedDownbeatBeatOffset = normalizeDownbeatBeatOffset(track?.downbeatBeatOffset)
      const firstDownbeatLineSourceBeats =
        dynamicSourceBeatMap?.firstDownbeatBeatDelta ??
        firstBeatSourceBeats + normalizedDownbeatBeatOffset
      const hasVisibleDownbeatLine = dynamicSourceBeatMap
        ? dynamicSourceBeatMap.firstDownbeatBeatDelta !== null &&
          firstDownbeatLineSourceBeats <= sourceDurationBeats + BPM_POINT_SEC_EPSILON
        : firstDownbeatLineSourceBeats <= sourceDurationBeats + BPM_POINT_SEC_EPSILON
      const sourceAnchorBeats = hasVisibleDownbeatLine
        ? firstDownbeatLineSourceBeats
        : firstBeatSourceBeats
      const anchorIntervalBeats = hasVisibleDownbeatLine ? GRID_ALIGN_DOWNBEAT_INTERVAL : 1
      const shouldPlaceTrackAtTimelineStart = cursorSec <= BPM_POINT_SEC_EPSILON
      const nextGlobalAnchorIndex = shouldPlaceTrackAtTimelineStart
        ? 0
        : Math.floor(
            (masterGrid.mapSecToBeats(cursorSec) + BPM_POINT_SEC_EPSILON) / anchorIntervalBeats
          ) + 1
      const desiredAnchorBeat = nextGlobalAnchorIndex * anchorIntervalBeats
      const minimumAnchorBeat = shouldPlaceTrackAtTimelineStart
        ? 0
        : Math.max(anchorIntervalBeats, Math.ceil(sourceAnchorBeats - BPM_POINT_SEC_EPSILON))
      const startBeat = Math.max(desiredAnchorBeat, minimumAnchorBeat) - sourceAnchorBeats
      const generatedStartSec = shouldPlaceTrackAtTimelineStart
        ? 0
        : roundTrackTempoSec(masterGrid.mapBeatsToSec(startBeat))
      const startSec = hasExplicitStartSec ? roundTrackTempoSec(rawStartSec) : generatedStartSec
      const nextTrack = hasExplicitStartSec ? track : { ...track, startSec }
      const trackStartBeat = masterGrid.mapSecToBeats(startSec)
      const trackEndSec = roundTrackTempoSec(
        beatSourceSec > BPM_POINT_SEC_EPSILON
          ? masterGrid.mapBeatsToSec(trackStartBeat + sourceDurationBeats)
          : startSec + sourceDurationSec
      )
      cursorSec = Math.max(cursorSec, trackEndSec)
      if (!hasExplicitStartSec && nextTrack?.id) {
        persistedEntries.push({
          itemId: String(nextTrack.id),
          startSec
        })
      }
      return nextTrack
    })
    return {
      tracks: nextTracks,
      persistedEntries
    }
  }

  const normalizeBpmFailureReason = (value: unknown): string => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) return ''
    return text.length <= 240 ? text : `${text.slice(0, 240)}...`
  }

  const handleBpmBatchReady = (_e: unknown, eventPayload: BpmBatchReadyPayload | null) => {
    const results = Array.isArray(eventPayload?.results) ? eventPayload.results : []
    if (!results.length) return
    const { resolvedCount } = applyBpmAnalysisToTracks(results)
    if (resolvedCount <= 0) return
    const playlistId = String(payload.value.playlistId || '').trim()
    if (playlistId) {
      ensureDefaultGlobalTempoEnvelope(playlistId)
    } else if (isMixtapeGlobalTempoReady()) {
      syncTracksWithGlobalTempo()
    }
    const filePaths = buildBpmTargets()
    const bpmTargets = new Set(filePaths)
    const missingTrackCount = resolveMissingBpmCount(bpmTargets)
    if (missingTrackCount === 0) {
      if (bpmAnalysisActive.value) {
        bpmAnalysisToken += 1
      }
      lastBpmAnalysisKey = buildMixtapeBpmTargetKey(filePaths)
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
    } else if (bpmAnalysisFailed.value) {
      bpmAnalysisFailedCount.value = missingTrackCount
    }
    scheduleTimelineDraw()
  }

  const dismissBpmAnalysisFailure = () => {
    bpmAnalysisFailed.value = false
    bpmAnalysisFailedCount.value = 0
    bpmAnalysisFailedReason.value = ''
  }

  const retryBpmAnalysis = () => {
    if (bpmAnalysisActive.value) return
    dismissBpmAnalysisFailure()
    void requestMixtapeBpmAnalysis()
  }

  const requestMixtapeBpmAnalysis = async () => {
    const filePaths = buildBpmTargets()
    if (!filePaths.length || !window?.electron?.ipcRenderer?.invoke) {
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
      return
    }
    const bpmTargets = new Set(filePaths)
    const missingPathCount = tracks.value.filter(
      (track: MixtapeTrack) => !normalizeMixtapeFilePath(track.filePath)
    ).length
    void missingPathCount
    const key = buildMixtapeBpmTargetKey(filePaths)
    const missingTrackCount = resolveMissingBpmCount(bpmTargets)
    const hasMissingBpm = missingTrackCount > 0
    if (!hasMissingBpm) {
      lastBpmAnalysisKey = key
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
      scheduleTimelineDraw()
      return
    }

    const token = (bpmAnalysisToken += 1)
    let allResolved = false
    bpmAnalysisActive.value = true
    bpmAnalysisFailed.value = false
    bpmAnalysisFailedCount.value = 0
    bpmAnalysisFailedReason.value = ''

    scheduleTimelineDraw()
    try {
      const result = await window.electron.ipcRenderer.invoke('mixtape:analyze-bpm', { filePaths })
      if (token !== bpmAnalysisToken) return
      const results = Array.isArray(result?.results) ? result.results : []
      const unresolved = Array.isArray(result?.unresolved) ? result.unresolved : []
      const unresolvedDetails = Array.isArray(result?.unresolvedDetails)
        ? result.unresolvedDetails
        : []
      const unresolvedReason = normalizeBpmFailureReason(unresolvedDetails[0]?.reason)
      if (results.length > 0) {
        const { resolvedCount } = applyBpmAnalysisToTracks(results)
        const remainMissingCount = resolveMissingBpmCount(bpmTargets)
        if (remainMissingCount > 0) {
          bpmAnalysisFailed.value = true
          bpmAnalysisFailedReason.value = unresolvedReason
          bpmAnalysisFailedCount.value = Math.max(
            remainMissingCount,
            unresolvedDetails.length,
            unresolved.length,
            Math.max(0, filePaths.length - resolvedCount)
          )
        } else {
          allResolved = true
        }
      } else if (filePaths.length > 0) {
        bpmAnalysisFailed.value = true
        bpmAnalysisFailedReason.value = unresolvedReason
        bpmAnalysisFailedCount.value = Math.max(unresolved.length, filePaths.length)
      }
    } catch (error) {
      bpmAnalysisFailed.value = true
      bpmAnalysisFailedReason.value = normalizeBpmFailureReason(
        error instanceof Error ? error.message : String(error || '')
      )
      bpmAnalysisFailedCount.value = Math.max(filePaths.length, 1)
      console.error('[mixtape] BPM analyze invoke failed', {
        fileCount: filePaths.length,
        error
      })
    } finally {
      if (token === bpmAnalysisToken) {
        if (allResolved) {
          lastBpmAnalysisKey = key
          dismissBpmAnalysisFailure()
        } else if (lastBpmAnalysisKey === key) {
          lastBpmAnalysisKey = ''
        }
        bpmAnalysisActive.value = false
        scheduleTimelineDraw()
      }
    }
  }

  const loadMixtapeItems = async (options?: { background?: boolean }) => {
    const requestToken = ++mixtapeItemsRequestToken
    const playlistId = String(payload.value.playlistId || '').trim()
    if (!playlistId) {
      mixtapeItemsLoading.value = false
      mixtapeRawItems.value = []
      mixtapeMixMode.value = 'stem'
      mixtapeStemMode.value = FIXED_MIXTAPE_STEM_MODE
      mixtapeStemProfile.value = DEFAULT_MIXTAPE_STEM_PROFILE
      stemSummary.value = createEmptyStemSummary()
      stemRuntimeProgressByTrackId.value = {}
      tracks.value = []
      selectedTrackId.value = ''
      resetAutoGainState()
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
      lastBpmAnalysisKey = ''
      resetMixtapeGlobalTempoState()
      return
    }
    const hasVisibleItems = tracks.value.length > 0 || mixtapeRawItems.value.length > 0
    const showLoading = !options?.background || !hasVisibleItems
    if (showLoading) {
      mixtapeItemsLoading.value = true
    }
    try {
      resetMixtapeGlobalTempoState(playlistId)
      const result = (await window.electron.ipcRenderer.invoke('mixtape:list', {
        playlistId
      })) as MixtapeListPayload
      if (requestToken !== mixtapeItemsRequestToken) return
      mixtapeMixMode.value = normalizeMixtapeMixMode(result?.mixMode)
      mixtapeStemMode.value = FIXED_MIXTAPE_STEM_MODE
      mixtapeStemProfile.value = normalizeStemProfile(
        result?.stemProfile,
        DEFAULT_MIXTAPE_STEM_PROFILE
      )
      stemSummary.value = normalizeStemSummary(result?.stemSummary)
      const rawItems: MixtapeRawItem[] = Array.isArray(result?.items) ? result.items : []
      mixtapeRawItems.value = rawItems
      const removedPaths = Array.isArray(result?.recovery?.removedPaths)
        ? normalizeUniquePaths(result.recovery.removedPaths)
        : []
      const parsedTracks = rawItems.map((item: MixtapeRawItem, index: number) =>
        parseSnapshot(item, index, t('tracks.unknownTrack'))
      ) as MixtapeTrack[]
      const persistedGlobalSnapshot = await readNormalizedProjectGlobalTempoSnapshot(
        playlistId,
        parsedTracks
      )
      const generatedGlobalSnapshot = buildDefaultMixtapeGlobalBpmEnvelopeSnapshot({
        tracks: parsedTracks,
        resolveTrackDurationSeconds,
        resolveTrackSourceDurationSeconds,
        resolveTrackFirstBeatSeconds
      })
      const defaultLayoutSnapshot = persistedGlobalSnapshot || generatedGlobalSnapshot
      const { tracks: hydratedTracks, persistedEntries } = materializeGridAlignedTrackStartSecs(
        parsedTracks,
        defaultLayoutSnapshot
      )
      tracks.value = hydratedTracks
      if (persistedEntries.length > 0 && window?.electron?.ipcRenderer?.invoke) {
        void window.electron.ipcRenderer
          .invoke('mixtape:update-track-start-sec', {
            entries: persistedEntries
          })
          .catch((error: unknown) => {
            console.error('[mixtape] persist generated track start sec failed', {
              playlistId,
              count: persistedEntries.length,
              error
            })
          })
      }
      if (persistedGlobalSnapshot) {
        applyMixtapeGlobalTempoSnapshot({
          playlistId,
          snapshot: persistedGlobalSnapshot,
          source: 'persisted'
        })
        refreshTimelineForGlobalTempoChange()
      } else {
        ensureDefaultGlobalTempoEnvelope(playlistId)
      }
      pruneStemRuntimeProgressByTracks(tracks.value)
      const stemMode = FIXED_MIXTAPE_STEM_MODE
      const currentPlaylistId = playlistId

      if (mixtapeMixMode.value === 'stem') {
        const missingStemAssetReadyTracks = tracks.value.filter(
          (track: MixtapeTrack) =>
            normalizeMixtapeStemStatus(track.stemStatus) === 'ready' &&
            !hasTrackStemPathsReady(track, stemMode)
        )
        if (missingStemAssetReadyTracks.length > 0 && window?.electron?.ipcRenderer?.invoke) {
          const repairFilePaths = Array.from(
            new Set(
              missingStemAssetReadyTracks
                .map((track: MixtapeTrack) => normalizeMixtapeFilePath(track.filePath))
                .filter(Boolean)
            )
          )
          if (repairFilePaths.length > 0) {
            void window.electron.ipcRenderer
              .invoke('mixtape:stem:enqueue', {
                playlistId,
                filePaths: repairFilePaths,
                stemMode,
                profile: mixtapeStemProfile.value,
                force: false
              })
              .catch((error: unknown) => {
                console.error('[mixtape] stem path backfill enqueue failed', {
                  playlistId,
                  count: repairFilePaths.length,
                  error
                })
              })
          }
        }
        if (currentPlaylistId) {
          const includeRunning = !stemResumeBootstrappedPlaylistIdSet.has(currentPlaylistId)
          await autoResumePendingStemJobs({
            playlistId: currentPlaylistId,
            stemMode,
            trackList: tracks.value,
            includeRunning
          })
          if (requestToken !== mixtapeItemsRequestToken) return
          stemResumeBootstrappedPlaylistIdSet.add(currentPlaylistId)
        }
      } else if (currentPlaylistId) {
        stemResumeBootstrappedPlaylistIdSet.delete(currentPlaylistId)
        stemResumeSignatureByPlaylistId.delete(currentPlaylistId)
      }
      if (!tracks.value.some((track: MixtapeTrack) => track.id === selectedTrackId.value)) {
        selectedTrackId.value = tracks.value[0]?.id || ''
      }
      syncAutoGainReferenceTrack()
      if (!tracks.value.some((track: MixtapeTrack) => track.id === beatAlignTrackId.value)) {
        beatAlignDialogVisible.value = false
        beatAlignTrackId.value = ''
      }
      closeTrackContextMenu()
      if (removedPaths.length > 0) {
        void notifyMissingTracksRemoved(playlistId, removedPaths)
      }
      void requestMixtapeBpmAnalysis()
    } catch (error) {
      if (requestToken !== mixtapeItemsRequestToken) return
      console.error('[mixtape] load mixtape items failed', {
        playlistId,
        error
      })
    } finally {
      if (showLoading && requestToken === mixtapeItemsRequestToken) {
        mixtapeItemsLoading.value = false
      }
    }
  }

  const closeTrackContextMenu = () => {
    trackContextMenuVisible.value = false
    trackContextTrackId.value = ''
  }

  const openBeatAlignDialog = (trackId: string) => {
    const found = tracks.value.find((track: MixtapeTrack) => track.id === trackId)
    if (!found) return
    beatAlignTrackId.value = trackId
    beatAlignDialogVisible.value = true
  }

  const handleTrackContextMenu = (
    item: TrackMenuContextItem | null | undefined,
    event: MouseEvent
  ) => {
    const trackId = item?.track?.id || ''
    if (!trackId) return
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 190
    const menuHeight = 108
    const { x, y } = resolveContextMenuPoint(
      {
        clickX: event.clientX,
        clickY: event.clientY,
        menuWidth,
        menuHeight
      },
      { padding: 8 }
    )
    trackContextMenuX.value = x
    trackContextMenuY.value = y
    trackContextTrackId.value = trackId
    trackContextMenuVisible.value = true
  }

  const handleTrackMenuAdjustGrid = () => {
    const trackId = trackContextTrackId.value
    closeTrackContextMenu()
    if (!trackId) return
    openBeatAlignDialog(trackId)
  }

  const handleTrackMenuToggleMasterTempo = () => {
    const trackId = trackContextTrackId.value
    if (!trackId) return
    const targetIndex = tracks.value.findIndex((track: MixtapeTrack) => track.id === trackId)
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const nextMasterTempo = currentTrack.masterTempo === false
    const nextTracks = [...tracks.value]
    nextTracks.splice(targetIndex, 1, {
      ...currentTrack,
      masterTempo: nextMasterTempo
    })
    tracks.value = nextTracks
    if (window?.electron?.ipcRenderer?.invoke) {
      void window.electron.ipcRenderer
        .invoke('mixtape:update-track-start-sec', {
          entries: [
            {
              itemId: currentTrack.id,
              masterTempo: nextMasterTempo
            }
          ]
        })
        .catch((error: unknown) => {
          console.error('[mixtape] update master tempo failed', {
            itemId: currentTrack.id,
            masterTempo: nextMasterTempo,
            error
          })
        })
    }
    closeTrackContextMenu()
    scheduleTimelineDraw()
  }

  const handleTrackMenuRemoveFromMixtape = async () => {
    const playlistId = String(payload.value.playlistId || '').trim()
    const trackId = String(trackContextTrackId.value || '').trim()
    closeTrackContextMenu()
    if (!playlistId || !trackId || !window?.electron?.ipcRenderer?.invoke) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:remove', {
        playlistId,
        itemIds: [trackId]
      })
    } catch (error) {
      console.error('[mixtape] remove track failed', {
        playlistId,
        itemId: trackId,
        error
      })
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.removeFromPlaylistFailed')],
        confirmShow: false
      })
    }
  }

  const handleBeatAlignDialogCancel = () => {
    beatAlignDialogVisible.value = false
    beatAlignTrackId.value = ''
  }

  const handleBeatAlignGridDefinitionSave = createMixtapeBeatAlignGridDefinitionSaver({
    payload,
    tracks,
    beatAlignTrackId,
    mixtapeMixMode,
    refreshTimelineForGlobalTempoChange,
    ensureDefaultGlobalTempoEnvelope,
    resolveTrackDurationSeconds,
    normalizeMixtapeFilePath,
    normalizeBpm,
    MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL,
    MIXTAPE_ENVELOPE_PARAMS_STEM,
    MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
    buildFlatMixEnvelope,
    normalizeMixEnvelopePoints,
    confirmDialog,
    t
  })

  const { handleGlobalPointerDown, handleWindowKeydown } = createMixtapeWindowInputHandlers({
    trackContextMenuVisible,
    beatAlignDialogVisible,
    transportPreloading,
    transportPlaying,
    transportDecoding,
    outputDialogVisible,
    outputRunning,
    autoGainDialogVisible,
    closeTrackContextMenu,
    handleTransportStop,
    handleTransportPlayFromStart
  })

  const {
    openOutputDialog,
    applyOutputProgressPayload,
    handleOutputDialogConfirm,
    handleOutputDialogCancel,
    handleOutputCancelRunning
  } = createMixtapeOutputUi({
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
  })

  const resetBpmAnalysisSession = () => {
    bpmAnalysisToken = 0
    lastBpmAnalysisKey = ''
  }

  return {
    handleBpmBatchReady,
    dismissBpmAnalysisFailure,
    retryBpmAnalysis,
    requestMixtapeBpmAnalysis,
    resetBpmAnalysisSession,
    loadMixtapeItems,
    closeTrackContextMenu,
    handleTrackContextMenu,
    handleTrackMenuAdjustGrid,
    handleTrackMenuToggleMasterTempo,
    handleTrackMenuRemoveFromMixtape,
    handleBeatAlignDialogCancel,
    handleBeatAlignGridDefinitionSave,
    handleGlobalPointerDown,
    handleWindowKeydown,
    openOutputDialog,
    applyOutputProgressPayload,
    handleOutputDialogConfirm,
    handleOutputDialogCancel,
    handleOutputCancelRunning
  }
}
