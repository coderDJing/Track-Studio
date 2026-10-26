import { RendererFilePathSet } from '@renderer/utils/filePathComparison'
import {
  normalizeGainEnvelopePoints,
  normalizeMixEnvelopePoints
} from '@renderer/composables/mixtape/gainEnvelope'
import { LANE_COUNT, normalizeMixtapeLaneIndex } from '@renderer/composables/mixtape/constants'
import { normalizeMixtapeTrackLoopSegments } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import { normalizeTrackBpmValue } from '@renderer/composables/mixtape/trackTempoModel'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import type {
  MixtapeRawItem,
  MixtapeStemStatus,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'
import {
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid
} from '@shared/songBeatGridMapV2'

const parseSnapshotInfo = (raw: MixtapeRawItem): Record<string, unknown> | null => {
  if (!raw?.infoJson) return null
  try {
    return JSON.parse(String(raw.infoJson))
  } catch {
    return null
  }
}

export const normalizeMixtapeFilePath = (value: unknown) => {
  if (typeof value !== 'string') return ''
  return value.trim()
}

export const normalizeDownbeatBeatOffset = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 0 || numeric >= 4) return 0
  return numeric
}

export const normalizeFirstBeatMs = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return numeric
}

export const normalizeBpm = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Number(numeric.toFixed(6))
}

const normalizeStemStatus = (
  value: unknown,
  fallback: MixtapeStemStatus = 'ready'
): MixtapeStemStatus => {
  if (
    value === 'idle' ||
    value === 'pending' ||
    value === 'running' ||
    value === 'ready' ||
    value === 'failed'
  ) {
    return value
  }
  return fallback
}

const normalizeTimestampMs = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.floor(numeric)
}

export const normalizeUniquePaths = (values: unknown[]) => {
  if (!Array.isArray(values)) return [] as string[]
  return Array.from(
    new RendererFilePathSet(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  )
}

export const parseSnapshot = (
  raw: MixtapeRawItem,
  index: number,
  unknownTrackLabel: string
): MixtapeTrack => {
  const info = parseSnapshotInfo(raw)
  const parsedBeatGridMapV2 = normalizeSongBeatGridMapV2(raw.canonicalGrid?.beatGridMap, {
    allowSingleClip: true
  })
  const beatGridProjectionV2 = projectSongBeatGridMapV2ToFixedGrid(parsedBeatGridMapV2)
  const filePath =
    normalizeMixtapeFilePath(raw?.filePath) || normalizeMixtapeFilePath(info?.filePath)
  const fileName = filePath.split(/[/\\]/).pop() || filePath || unknownTrackLabel
  const parsedBpm = beatGridProjectionV2?.bpm
  const parsedOriginalBpmCandidate = Number(info?.originalBpm)
  const parsedOriginalBpm =
    Number.isFinite(parsedOriginalBpmCandidate) && parsedOriginalBpmCandidate > 0
      ? parsedOriginalBpmCandidate
      : parsedBpm
  const parsedMasterTempo = info?.masterTempo !== false
  const hasLaneIndexField = !!info && Object.prototype.hasOwnProperty.call(info, 'laneIndex')
  const parsedFirstBeatMs = beatGridProjectionV2?.firstBeatMs
  const parsedTimeBasisOffsetMs =
    typeof raw.canonicalGrid?.timeBasisOffsetMs === 'number' &&
    Number.isFinite(raw.canonicalGrid.timeBasisOffsetMs) &&
    raw.canonicalGrid.timeBasisOffsetMs >= 0
      ? raw.canonicalGrid.timeBasisOffsetMs
      : undefined
  const parsedKey = typeof info?.key === 'string' ? info.key.trim() : ''
  const parsedOriginalKeyRaw = typeof info?.originalKey === 'string' ? info.originalKey.trim() : ''
  const parsedOriginalKey = parsedOriginalKeyRaw || parsedKey || undefined
  const parsedDownbeatBeatOffset = beatGridProjectionV2?.downbeatBeatOffset
  const parsedGainEnvelope = normalizeGainEnvelopePoints(info?.gainEnvelope)
  const parsedHighEnvelope = normalizeMixEnvelopePoints('high', info?.highEnvelope)
  const parsedMidEnvelope = normalizeMixEnvelopePoints('mid', info?.midEnvelope)
  const parsedLowEnvelope = normalizeMixEnvelopePoints('low', info?.lowEnvelope)
  const parsedVocalEnvelope = normalizeMixEnvelopePoints('vocal', info?.vocalEnvelope)
  const parsedInstEnvelope = normalizeMixEnvelopePoints('inst', info?.instEnvelope)
  const parsedBassEnvelope = normalizeMixEnvelopePoints('bass', info?.bassEnvelope)
  const parsedDrumsEnvelope = normalizeMixEnvelopePoints('drums', info?.drumsEnvelope)
  const parsedVolumeEnvelope = normalizeMixEnvelopePoints('volume', info?.volumeEnvelope)
  const parsedVolumeMuteSegments = normalizeVolumeMuteSegments(
    info?.volumeMuteSegments,
    Number(info?.durationSec)
  )
  const parsedLoopSegments = normalizeMixtapeTrackLoopSegments(
    info?.loopSegments ?? info?.loopSegment
  )
  const parsedLoopSegment = parsedLoopSegments[0]
  const parsedStartSecRaw = Number(info?.startSec)
  const parsedStartSec = Number.isFinite(parsedStartSecRaw)
    ? Number(parsedStartSecRaw.toFixed(4))
    : undefined
  const parsedLaneIndex = hasLaneIndexField
    ? normalizeMixtapeLaneIndex(info?.laneIndex, index % LANE_COUNT)
    : undefined
  const parsedStemStatus = normalizeStemStatus(info?.stemStatus, 'ready')
  const parsedStemError =
    typeof info?.stemError === 'string' && info.stemError.trim() ? info.stemError.trim() : undefined
  const parsedStemReadyAt = normalizeTimestampMs(info?.stemReadyAt)
  const parsedStemModel =
    typeof info?.stemModel === 'string' && info.stemModel.trim() ? info.stemModel.trim() : undefined
  const parsedStemVersion =
    typeof info?.stemVersion === 'string' && info.stemVersion.trim()
      ? info.stemVersion.trim()
      : undefined
  const parsedStemVocalPath = normalizeMixtapeFilePath(info?.stemVocalPath) || undefined
  const parsedStemInstPath = normalizeMixtapeFilePath(info?.stemInstPath) || undefined
  const parsedStemBassPath = normalizeMixtapeFilePath(info?.stemBassPath) || undefined
  const parsedStemDrumsPath = normalizeMixtapeFilePath(info?.stemDrumsPath) || undefined
  return {
    id: String(raw?.id || `${filePath}-${index}`),
    mixOrder: Number(raw?.mixOrder) || index + 1,
    title: String(info?.title || fileName || unknownTrackLabel),
    artist: String(info?.artist || ''),
    duration: String(info?.duration || ''),
    filePath,
    originPath: String(raw?.originPathSnapshot || ''),
    originPlaylistUuid: raw?.originPlaylistUuid ? String(raw.originPlaylistUuid) : null,
    key: parsedKey || undefined,
    originalKey: parsedOriginalKey,
    bpm: parsedBpm,
    gridBaseBpm: normalizeTrackBpmValue(info?.gridBaseBpm) ?? parsedBpm,
    originalBpm: parsedOriginalBpm,
    masterTempo: parsedMasterTempo,
    startSec: parsedStartSec,
    laneIndex: parsedLaneIndex,
    loopSegments: parsedLoopSegments.length ? parsedLoopSegments : undefined,
    loopSegment: parsedLoopSegment,
    gainEnvelope: parsedGainEnvelope.length ? parsedGainEnvelope : undefined,
    highEnvelope: parsedHighEnvelope.length ? parsedHighEnvelope : undefined,
    midEnvelope: parsedMidEnvelope.length ? parsedMidEnvelope : undefined,
    lowEnvelope: parsedLowEnvelope.length ? parsedLowEnvelope : undefined,
    vocalEnvelope: parsedVocalEnvelope.length ? parsedVocalEnvelope : undefined,
    instEnvelope: parsedInstEnvelope.length ? parsedInstEnvelope : undefined,
    bassEnvelope: parsedBassEnvelope.length ? parsedBassEnvelope : undefined,
    drumsEnvelope: parsedDrumsEnvelope.length ? parsedDrumsEnvelope : undefined,
    volumeEnvelope: parsedVolumeEnvelope.length ? parsedVolumeEnvelope : undefined,
    volumeMuteSegments: parsedVolumeMuteSegments.length ? parsedVolumeMuteSegments : undefined,
    firstBeatMs: parsedFirstBeatMs,
    downbeatBeatOffset: parsedDownbeatBeatOffset,
    timeBasisOffsetMs: parsedTimeBasisOffsetMs,
    beatGridMap: parsedBeatGridMapV2 ?? undefined,
    stemStatus: parsedStemStatus,
    stemError: parsedStemError,
    stemReadyAt: parsedStemReadyAt,
    stemModel: parsedStemModel,
    stemVersion: parsedStemVersion,
    stemVocalPath: parsedStemVocalPath,
    stemInstPath: parsedStemInstPath,
    stemBassPath: parsedStemBassPath,
    stemDrumsPath: parsedStemDrumsPath
  }
}
