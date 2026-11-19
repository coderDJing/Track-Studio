import { getLibraryDb } from './libraryDb'
import { log } from './log'

const PROJECT_TABLE = 'mixtape_projects'
const DEFAULT_PROJECT_MIX_MODE = 'stem'
const DEFAULT_PROJECT_STEM_MODE = '4stems'
const DEFAULT_PROJECT_STEM_PROFILE = 'quality'
const SAME_SEC_EPSILON = 0.0001

export const DEFAULT_MIXTAPE_PROJECT_LANE_COUNT = 2
export const MAX_MIXTAPE_PROJECT_LANE_COUNT = 4

// 时间线泳道数只允许 2 或 4；其余取值一律回落到默认的双轨。
export const normalizeMixtapeProjectLaneCount = (value: unknown): number => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_MIXTAPE_PROJECT_LANE_COUNT
  return Math.floor(numeric) >= MAX_MIXTAPE_PROJECT_LANE_COUNT
    ? MAX_MIXTAPE_PROJECT_LANE_COUNT
    : DEFAULT_MIXTAPE_PROJECT_LANE_COUNT
}

type MixtapeProjectBpmPoint = {
  sec: number
  bpm: number
}

export type MixtapeProjectBpmEnvelopeSnapshot = {
  bpmEnvelope: MixtapeProjectBpmPoint[]
  bpmEnvelopeDurationSec: number
  gridPhaseOffsetSec?: number
}

type ProjectInfoJson = Record<string, unknown>

const isProjectInfoJson = (value: unknown): value is ProjectInfoJson =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const parseProjectInfoJson = (raw: unknown): ProjectInfoJson => {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return isProjectInfoJson(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const normalizeProjectBpmEnvelope = (raw: unknown): MixtapeProjectBpmPoint[] => {
  const points = Array.isArray(raw)
    ? raw
        .map((item) => {
          const entry = isProjectInfoJson(item) ? item : null
          const sec = Number(entry?.sec)
          const bpm = Number(entry?.bpm)
          if (!Number.isFinite(sec) || sec < 0) return null
          if (!Number.isFinite(bpm) || bpm <= 0) return null
          return {
            sec: Number(sec.toFixed(4)),
            bpm: Number(bpm.toFixed(4))
          } satisfies MixtapeProjectBpmPoint
        })
        .filter((item): item is MixtapeProjectBpmPoint => !!item)
    : []
  if (!points.length) return []
  const sorted = points.sort((left, right) => {
    if (Math.abs(left.sec - right.sec) > SAME_SEC_EPSILON) return left.sec - right.sec
    return left.bpm - right.bpm
  })
  const deduped: MixtapeProjectBpmPoint[] = []
  for (const point of sorted) {
    const last = deduped[deduped.length - 1]
    if (!last || Math.abs(last.sec - point.sec) > SAME_SEC_EPSILON) {
      deduped.push(point)
      continue
    }
    deduped[deduped.length - 1] = point
  }
  return deduped
}

const normalizeDurationSec = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Number(numeric.toFixed(4))
}

const normalizePhaseOffsetSec = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return 0
  return Number(numeric.toFixed(4))
}

const ensureProjectRow = (playlistUuid: string) => {
  const db = getLibraryDb()
  if (!db) return null
  const normalizedPlaylistUuid = typeof playlistUuid === 'string' ? playlistUuid.trim() : ''
  if (!normalizedPlaylistUuid) return null
  try {
    const row = db
      .prepare(
        `SELECT playlist_uuid, mix_mode, stem_mode, stem_profile, info_json
         FROM ${PROJECT_TABLE}
         WHERE playlist_uuid = ?`
      )
      .get(normalizedPlaylistUuid) as
      | {
          playlist_uuid: string
          mix_mode?: string | null
          stem_mode?: string | null
          stem_profile?: string | null
          info_json?: string | null
        }
      | undefined
    if (row) return row
    const now = Date.now()
    db.prepare(
      `INSERT INTO ${PROJECT_TABLE} (
         playlist_uuid,
         mix_mode,
         stem_mode,
         stem_profile,
         created_at_ms,
         updated_at_ms,
         info_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      normalizedPlaylistUuid,
      DEFAULT_PROJECT_MIX_MODE,
      DEFAULT_PROJECT_STEM_MODE,
      DEFAULT_PROJECT_STEM_PROFILE,
      now,
      now,
      null
    )
    return {
      playlist_uuid: normalizedPlaylistUuid,
      mix_mode: DEFAULT_PROJECT_MIX_MODE,
      stem_mode: DEFAULT_PROJECT_STEM_MODE,
      stem_profile: DEFAULT_PROJECT_STEM_PROFILE,
      info_json: null
    }
  } catch (error) {
    log.error('[sqlite] ensure mixtape project row failed', {
      playlistUuid: normalizedPlaylistUuid,
      error
    })
    return null
  }
}

export function getMixtapeProjectBpmEnvelope(
  playlistUuid: string
): MixtapeProjectBpmEnvelopeSnapshot {
  const row = ensureProjectRow(playlistUuid)
  if (!row) {
    return {
      bpmEnvelope: [],
      bpmEnvelopeDurationSec: 0
    }
  }
  const info = parseProjectInfoJson(row.info_json)
  const bpmEnvelope = normalizeProjectBpmEnvelope(info.mixBpmEnvelope)
  const explicitDurationSec = normalizeDurationSec(info.mixBpmEnvelopeDurationSec)
  const inferredDurationSec = bpmEnvelope.reduce(
    (result, point) => (point.sec > result ? point.sec : result),
    0
  )
  return {
    bpmEnvelope,
    bpmEnvelopeDurationSec: explicitDurationSec || inferredDurationSec,
    gridPhaseOffsetSec: normalizePhaseOffsetSec(info.mixBpmEnvelopePhaseOffsetSec)
  }
}

export function upsertMixtapeProjectBpmEnvelope(
  playlistUuid: string,
  nextSnapshot: MixtapeProjectBpmEnvelopeSnapshot
): { updated: number } {
  const db = getLibraryDb()
  if (!db) return { updated: 0 }
  const row = ensureProjectRow(playlistUuid)
  if (!row) return { updated: 0 }
  const nextEnvelope = normalizeProjectBpmEnvelope(nextSnapshot?.bpmEnvelope)
  const nextDurationSec = normalizeDurationSec(nextSnapshot?.bpmEnvelopeDurationSec)
  const nextPhaseOffsetSec = normalizePhaseOffsetSec(nextSnapshot?.gridPhaseOffsetSec)
  try {
    const info = parseProjectInfoJson(row.info_json)
    const currentEnvelope = normalizeProjectBpmEnvelope(info.mixBpmEnvelope)
    const currentDurationSec = normalizeDurationSec(info.mixBpmEnvelopeDurationSec)
    const currentPhaseOffsetSec = normalizePhaseOffsetSec(info.mixBpmEnvelopePhaseOffsetSec)
    const sameEnvelope = JSON.stringify(currentEnvelope) === JSON.stringify(nextEnvelope)
    const sameDuration = Math.abs(currentDurationSec - nextDurationSec) <= SAME_SEC_EPSILON
    const samePhaseOffset = Math.abs(currentPhaseOffsetSec - nextPhaseOffsetSec) <= SAME_SEC_EPSILON
    if (sameEnvelope && sameDuration && samePhaseOffset) return { updated: 0 }
    if (nextEnvelope.length >= 2 && nextDurationSec > 0) {
      info.mixBpmEnvelope = nextEnvelope
      info.mixBpmEnvelopeDurationSec = nextDurationSec
      info.mixBpmEnvelopePhaseOffsetSec = nextPhaseOffsetSec
    } else {
      delete info.mixBpmEnvelope
      delete info.mixBpmEnvelopeDurationSec
      delete info.mixBpmEnvelopePhaseOffsetSec
    }
    info.mixBpmEnvelopeUpdatedAt = Date.now()
    const updatedAtMs = Date.now()
    const update = db
      .prepare(
        `UPDATE ${PROJECT_TABLE} SET info_json = ?, updated_at_ms = ? WHERE playlist_uuid = ?`
      )
      .run(JSON.stringify(info), updatedAtMs, row.playlist_uuid)
    return {
      updated: Number(update?.changes || 0)
    }
  } catch (error) {
    log.error('[sqlite] mixtape project bpm envelope upsert failed', {
      playlistUuid,
      error
    })
    return { updated: 0 }
  }
}

export function getMixtapeProjectLaneCount(playlistUuid: string): number {
  const row = ensureProjectRow(playlistUuid)
  if (!row) return DEFAULT_MIXTAPE_PROJECT_LANE_COUNT
  const info = parseProjectInfoJson(row.info_json)
  return normalizeMixtapeProjectLaneCount(info.laneCount)
}

export function upsertMixtapeProjectLaneCount(
  playlistUuid: string,
  laneCount: unknown
): { updated: number; laneCount: number } {
  const resolvedLaneCount = normalizeMixtapeProjectLaneCount(laneCount)
  const db = getLibraryDb()
  if (!db) return { updated: 0, laneCount: resolvedLaneCount }
  const row = ensureProjectRow(playlistUuid)
  if (!row) return { updated: 0, laneCount: resolvedLaneCount }
  try {
    const info = parseProjectInfoJson(row.info_json)
    if (normalizeMixtapeProjectLaneCount(info.laneCount) === resolvedLaneCount) {
      return { updated: 0, laneCount: resolvedLaneCount }
    }
    if (resolvedLaneCount === DEFAULT_MIXTAPE_PROJECT_LANE_COUNT) {
      delete info.laneCount
    } else {
      info.laneCount = resolvedLaneCount
    }
    info.laneCountUpdatedAt = Date.now()
    const update = db
      .prepare(
        `UPDATE ${PROJECT_TABLE} SET info_json = ?, updated_at_ms = ? WHERE playlist_uuid = ?`
      )
      .run(JSON.stringify(info), Date.now(), row.playlist_uuid)
    return {
      updated: Number(update?.changes || 0),
      laneCount: resolvedLaneCount
    }
  } catch (error) {
    log.error('[sqlite] mixtape project lane count upsert failed', {
      playlistUuid,
      error
    })
    return { updated: 0, laneCount: resolvedLaneCount }
  }
}
