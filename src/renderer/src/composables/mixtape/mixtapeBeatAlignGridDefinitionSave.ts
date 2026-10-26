import type ConfirmDialog from '@renderer/components/confirmDialog'
import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import {
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid
} from '@shared/songBeatGridMapV2'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMixMode,
  MixtapeOpenPayload,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

type ValueRef<T> = {
  value: T
}

export type MixtapeEnvelopeField =
  | 'gainEnvelope'
  | 'highEnvelope'
  | 'midEnvelope'
  | 'lowEnvelope'
  | 'vocalEnvelope'
  | 'instEnvelope'
  | 'bassEnvelope'
  | 'drumsEnvelope'
  | 'volumeEnvelope'

export type MixtapeBeatAlignGridDefinitionPayload = {
  beatGridMap?: MixtapeTrack['beatGridMap'] | null
}

type CreateMixtapeBeatAlignGridDefinitionSaverContext = {
  payload: ValueRef<MixtapeOpenPayload>
  tracks: ValueRef<MixtapeTrack[]>
  beatAlignTrackId: ValueRef<string>
  mixtapeMixMode: ValueRef<MixtapeMixMode>
  refreshTimelineForGlobalTempoChange: () => void
  ensureDefaultGlobalTempoEnvelope: (
    playlistId: string,
    options?: { refreshWaveform?: boolean }
  ) => void
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  normalizeMixtapeFilePath: (value: unknown) => string
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
  confirmDialog: typeof ConfirmDialog
  t: (key: string, payload?: Record<string, unknown>) => string
}

const getTrackEnvelopeField = (value: unknown): MixtapeEnvelopeField =>
  value as MixtapeEnvelopeField

export const createMixtapeBeatAlignGridDefinitionSaver = (
  ctx: CreateMixtapeBeatAlignGridDefinitionSaverContext
) => {
  const {
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
  } = ctx

  return async (nextGrid: MixtapeBeatAlignGridDefinitionPayload) => {
    const playlistId = String(payload.value.playlistId || '').trim()
    const trackId = beatAlignTrackId.value
    if (!trackId) return
    const targetIndex = tracks.value.findIndex((track: MixtapeTrack) => track.id === trackId)
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const nextBeatGridMap = normalizeSongBeatGridMapV2(nextGrid?.beatGridMap, {
      allowSingleClip: true
    })
    if (!nextBeatGridMap) return
    const beatGridMapChanged = currentTrack.beatGridMap?.signature !== nextBeatGridMap.signature
    const targetFilePath = normalizeMixtapeFilePath(currentTrack.filePath)
    const originalBpm = normalizeBpm(currentTrack.originalBpm)
    const nextBpm = projectSongBeatGridMapV2ToFixedGrid(nextBeatGridMap)?.bpm ?? null
    const shouldPersistBpm =
      nextBpm !== null && (originalBpm === null || Math.abs(nextBpm - originalBpm) > 0.0001)
    const isSameTrack = (track: MixtapeTrack) =>
      targetFilePath.length > 0
        ? sameRendererFilePath(track.filePath, targetFilePath)
        : track.id === trackId
    const bpmChanged =
      shouldPersistBpm &&
      tracks.value.some((track: MixtapeTrack) => {
        if (!isSameTrack(track)) return false
        const trackBpmBase = normalizeBpm(track.originalBpm)
        if (trackBpmBase === null) return true
        return Math.abs(trackBpmBase - Number(nextBpm)) > 0.0001
      })
    if (!bpmChanged && !beatGridMapChanged) return
    const gridPositionChanged = bpmChanged || beatGridMapChanged
    const activeEnvelopeParams =
      mixtapeMixMode.value === 'eq'
        ? MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL
        : MIXTAPE_ENVELOPE_PARAMS_STEM
    const shouldResetEnvelope = gridPositionChanged
      ? (await confirmDialog({
          title: t('mixtape.gridAdjustSaveResetEnvelopeTitle'),
          content: [t('mixtape.gridAdjustSaveResetEnvelopeHint')],
          confirmText: t('mixtape.gridAdjustSaveResetEnvelopeConfirm'),
          cancelText: t('mixtape.gridAdjustSaveResetEnvelopeCancel')
        })) === 'confirm'
      : false
    if (gridPositionChanged && !shouldResetEnvelope) return
    const nextTracks = tracks.value.map((track: MixtapeTrack) => {
      if (!isSameTrack(track)) return track
      const nextTrack: MixtapeTrack = {
        ...track,
        originalBpm: shouldPersistBpm && nextBpm !== null ? Number(nextBpm) : track.originalBpm
      }
      nextTrack.beatGridMap = nextBeatGridMap
      if (!shouldResetEnvelope) return nextTrack
      for (const param of activeEnvelopeParams as MixtapeEnvelopeParamId[]) {
        const envelopeField = getTrackEnvelopeField(MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param])
        nextTrack[envelopeField] = buildFlatMixEnvelope(
          param,
          resolveTrackDurationSeconds(track),
          1
        )
      }
      nextTrack.volumeMuteSegments = []
      return nextTrack
    })
    tracks.value = nextTracks
    refreshTimelineForGlobalTempoChange()
    if (!window?.electron?.ipcRenderer?.invoke) return

    if (targetFilePath) {
      void window.electron.ipcRenderer
        .invoke('mixtape:update-grid-definition', {
          filePath: targetFilePath,
          beatGridMap: nextBeatGridMap
        })
        .catch((error: unknown) => {
          console.error('[mixtape] update grid definition failed', {
            filePath: targetFilePath,
            beatGridMap: nextBeatGridMap,
            error
          })
        })
    }

    if (!shouldResetEnvelope) return
    const affectedTracks = nextTracks.filter((track: MixtapeTrack) => isSameTrack(track))
    if (!affectedTracks.length) return
    const envelopeUpdateTasks = (activeEnvelopeParams as MixtapeEnvelopeParamId[]).map((param) => {
      const envelopeField = getTrackEnvelopeField(MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param])
      const entries = affectedTracks
        .map((track: MixtapeTrack) => {
          const points = normalizeMixEnvelopePoints(
            param,
            track[envelopeField],
            resolveTrackDurationSeconds(track)
          ) as MixtapeGainPoint[]
          if (points.length < 2) return null
          return {
            itemId: track.id,
            gainEnvelope: points.map((point: MixtapeGainPoint) => ({
              sec: Number(point.sec),
              gain: Number(point.gain)
            }))
          }
        })
        .filter(
          (
            item: { itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> } | null
          ): item is { itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> } =>
            item !== null
        )
      if (!entries.length) return Promise.resolve(null)
      return window.electron.ipcRenderer.invoke('mixtape:update-mix-envelope', {
        param,
        entries
      })
    })
    const muteSegmentUpdateEntries = affectedTracks.map((track: MixtapeTrack) => ({
      itemId: track.id,
      segments: []
    }))
    const muteSegmentUpdateTask =
      muteSegmentUpdateEntries.length > 0
        ? window.electron.ipcRenderer.invoke('mixtape:update-volume-mute-segments', {
            entries: muteSegmentUpdateEntries
          })
        : Promise.resolve(null)
    const originalBpmUpdateTask =
      bpmChanged && nextBpm !== null
        ? window.electron.ipcRenderer.invoke('mixtape:update-track-start-sec', {
            entries: affectedTracks.map((track: MixtapeTrack) => ({
              itemId: track.id,
              originalBpm: Number(nextBpm)
            }))
          })
        : Promise.resolve(null)
    void Promise.all([...envelopeUpdateTasks, muteSegmentUpdateTask, originalBpmUpdateTask]).catch(
      (error: unknown) => {
        console.error('[mixtape] reset mix envelope after grid update failed', {
          trackCount: affectedTracks.length,
          error
        })
      }
    )
    ensureDefaultGlobalTempoEnvelope(playlistId, {
      refreshWaveform: false
    })
  }
}
