import { getLibraryDb } from './libraryDb'
import { isSqliteRow } from './libraryDb'
import { log } from './log'

const TABLE = 'mixtape_items'
const MIXTAPE_LANE_COUNT = 2

export type MixtapeMixEnvelopeParam =
  'gain' | 'high' | 'mid' | 'low' | 'vocal' | 'inst' | 'bass' | 'drums' | 'volume'

const MIXTAPE_ENVELOPE_FIELD_BY_PARAM: Record<MixtapeMixEnvelopeParam, string> = {
  gain: 'gainEnvelope',
  high: 'highEnvelope',
  mid: 'midEnvelope',
  low: 'lowEnvelope',
  vocal: 'vocalEnvelope',
  inst: 'instEnvelope',
  bass: 'bassEnvelope',
  drums: 'drumsEnvelope',
  volume: 'volumeEnvelope'
}

const MIXTAPE_ENVELOPE_MAX_GAIN_BY_PARAM: Record<MixtapeMixEnvelopeParam, number> = {
  gain: 16,
  high: 16,
  mid: 16,
  low: 16,
  vocal: 16,
  inst: 16,
  bass: 16,
  drums: 16,
  volume: 1
}

type MixtapeItemInfoJson = Record<string, unknown>

const parseItemInfoJson = (raw: unknown): MixtapeItemInfoJson => {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return isSqliteRow(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function upsertMixtapeItemMixEnvelopeById(
  param: MixtapeMixEnvelopeParam,
  entries: Array<{ itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> }>,
  options?: { requireAll?: boolean }
): { updated: number } {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) {
    if (options?.requireAll) throw new Error('MIXTAPE_GAIN_DATABASE_UNAVAILABLE')
    return { updated: 0 }
  }
  const envelopeField = MIXTAPE_ENVELOPE_FIELD_BY_PARAM[param]
  const maxGain = MIXTAPE_ENVELOPE_MAX_GAIN_BY_PARAM[param]

  const normalizeEnvelope = (raw: unknown) => {
    const sameSecEpsilon = 0.0001
    const maxPointsPerSec = 2
    const points = Array.isArray(raw)
      ? raw
          .map((item) => {
            const point = isSqliteRow(item) ? item : null
            const sec = Number(point?.sec)
            const gain = Number(point?.gain)
            if (!Number.isFinite(sec) || sec < 0) return null
            if (!Number.isFinite(gain) || gain <= 0) return null
            return {
              sec: Number(sec.toFixed(4)),
              gain: Math.max(0.0001, Math.min(maxGain, Number(gain.toFixed(6))))
            }
          })
          .filter((item): item is { sec: number; gain: number } => !!item)
      : []
    if (!points.length) return []
    const sorted = points.sort((a, b) => a.sec - b.sec)
    const limited: Array<{ sec: number; gain: number }> = []
    let bucketStartIndex = -1
    let bucketSec = NaN
    let bucketCount = 0
    for (const point of sorted) {
      if (!bucketCount || Math.abs(point.sec - bucketSec) > sameSecEpsilon) {
        limited.push(point)
        bucketStartIndex = limited.length - 1
        bucketSec = point.sec
        bucketCount = 1
        continue
      }
      bucketCount += 1
      if (bucketCount <= maxPointsPerSec) {
        limited.push(point)
        continue
      }
      const replaceIndex = bucketStartIndex + maxPointsPerSec - 1
      limited[replaceIndex] = point
    }
    return limited
  }

  const envelopeById = new Map<string, Array<{ sec: number; gain: number }>>()
  for (const item of entries) {
    const itemId = typeof item?.itemId === 'string' ? item.itemId.trim() : ''
    if (!itemId) continue
    const normalizedEnvelope = normalizeEnvelope(item?.gainEnvelope)
    if (normalizedEnvelope.length < 2) continue
    envelopeById.set(itemId, normalizedEnvelope)
  }
  const itemIds = Array.from(envelopeById.keys())
  if (options?.requireAll && itemIds.length !== entries.length) {
    throw new Error('MIXTAPE_GAIN_INVALID_ENTRIES')
  }
  if (!itemIds.length) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      let matched = 0
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < itemIds.length; offset += CHUNK_SIZE) {
        const chunk = itemIds.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(`SELECT id, info_json FROM ${TABLE} WHERE id IN (${placeholders})`)
          .all(...chunk) as Array<{ id: string; info_json?: string | null }>
        matched += rows.length
        for (const row of rows) {
          const itemId = typeof row?.id === 'string' ? row.id.trim() : ''
          if (!itemId) continue
          const nextEnvelope = envelopeById.get(itemId)
          if (!nextEnvelope || nextEnvelope.length < 2) continue
          const info = parseItemInfoJson(row?.info_json)
          const currentEnvelope = normalizeEnvelope(info[envelopeField])
          const currentSignature = JSON.stringify(currentEnvelope)
          const nextSignature = JSON.stringify(nextEnvelope)
          if (currentSignature === nextSignature) continue
          info[envelopeField] = nextEnvelope
          info[`${envelopeField}UpdatedAt`] = Date.now()
          updateStmt.run(JSON.stringify(info), itemId)
          updated += 1
        }
      }
      if (options?.requireAll && matched !== itemIds.length) {
        throw new Error('MIXTAPE_GAIN_ITEMS_CHANGED')
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape mix envelope upsert failed', { param, error })
    if (options?.requireAll) throw error
    return { updated: 0 }
  }
}

export function upsertMixtapeItemGainEnvelopeById(
  entries: Array<{ itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> }>,
  options?: { requireAll?: boolean }
): { updated: number } {
  return upsertMixtapeItemMixEnvelopeById('gain', entries, options)
}

export function upsertMixtapeItemVolumeMuteSegmentsById(
  entries: Array<{ itemId: string; segments: Array<{ startSec: number; endSec: number }> }>
): { updated: number } {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }

  const normalizeSegments = (raw: unknown) => {
    const sameSecEpsilon = 0.0001
    const points = Array.isArray(raw)
      ? raw
          .map((item) => {
            const segment = isSqliteRow(item) ? item : null
            const startSec = Number(segment?.startSec)
            const endSec = Number(segment?.endSec)
            if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null
            const safeStart = Math.max(0, Number(startSec.toFixed(4)))
            const safeEnd = Math.max(0, Number(endSec.toFixed(4)))
            if (safeEnd - safeStart <= sameSecEpsilon) return null
            return {
              startSec: safeStart,
              endSec: safeEnd
            }
          })
          .filter((item): item is { startSec: number; endSec: number } => !!item)
      : []
    if (!points.length) return []
    const sorted = points.sort((a, b) => {
      if (Math.abs(a.startSec - b.startSec) > sameSecEpsilon) return a.startSec - b.startSec
      return a.endSec - b.endSec
    })
    const deduped: Array<{ startSec: number; endSec: number }> = []
    for (const segment of sorted) {
      const last = deduped[deduped.length - 1]
      if (
        last &&
        Math.abs(last.startSec - segment.startSec) <= sameSecEpsilon &&
        Math.abs(last.endSec - segment.endSec) <= sameSecEpsilon
      ) {
        continue
      }
      deduped.push(segment)
    }
    return deduped
  }

  const segmentById = new Map<string, Array<{ startSec: number; endSec: number }>>()
  for (const item of entries) {
    const itemId = typeof item?.itemId === 'string' ? item.itemId.trim() : ''
    if (!itemId) continue
    const normalizedSegments = normalizeSegments(item?.segments)
    segmentById.set(itemId, normalizedSegments)
  }
  const itemIds = Array.from(segmentById.keys())
  if (!itemIds.length) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < itemIds.length; offset += CHUNK_SIZE) {
        const chunk = itemIds.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(`SELECT id, info_json FROM ${TABLE} WHERE id IN (${placeholders})`)
          .all(...chunk) as Array<{ id: string; info_json?: string | null }>
        for (const row of rows) {
          const itemId = typeof row?.id === 'string' ? row.id.trim() : ''
          if (!itemId) continue
          const nextSegments = segmentById.get(itemId)
          if (!nextSegments) continue
          const info = parseItemInfoJson(row?.info_json)
          const currentSegments = normalizeSegments(info.volumeMuteSegments)
          const currentSignature = JSON.stringify(currentSegments)
          const nextSignature = JSON.stringify(nextSegments)
          if (currentSignature === nextSignature) continue
          info.volumeMuteSegments = nextSegments
          info.volumeMuteSegmentsUpdatedAt = Date.now()
          updateStmt.run(JSON.stringify(info), itemId)
          updated += 1
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape volume mute segments upsert failed', error)
    return { updated: 0 }
  }
}

export function upsertMixtapeItemLoopSegmentsById(
  entries: Array<{
    itemId: string
    loopSegments?: Array<{
      startSec?: number
      endSec?: number
      repeatCount?: number
    }> | null
    loopSegment?: {
      startSec?: number
      endSec?: number
      repeatCount?: number
    } | null
  }>
): { updated: number } {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }

  const normalizeLoopSegment = (raw: unknown) => {
    const segment = isSqliteRow(raw) ? raw : null
    const startSec = Number(segment?.startSec)
    const endSec = Number(segment?.endSec)
    const repeatCount = Number(segment?.repeatCount)
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !Number.isFinite(repeatCount)) {
      return null
    }
    const safeRepeatCount = Math.max(0, Math.floor(repeatCount))
    if (safeRepeatCount <= 0) return null
    const safeStartSec = Math.max(0, Number(startSec.toFixed(4)))
    const safeEndSec = Math.max(0, Number(endSec.toFixed(4)))
    if (safeEndSec - safeStartSec <= 0.0001) return null
    return {
      startSec: safeStartSec,
      endSec: safeEndSec,
      repeatCount: safeRepeatCount
    }
  }

  const normalizeLoopSegments = (raw: unknown) => {
    const rawItems = Array.isArray(raw) ? raw : raw ? [raw] : []
    const normalized = rawItems
      .map((item) => normalizeLoopSegment(item))
      .filter((item): item is { startSec: number; endSec: number; repeatCount: number } => !!item)
      .sort((left, right) => {
        if (Math.abs(left.startSec - right.startSec) > 0.0001) return left.startSec - right.startSec
        if (Math.abs(left.endSec - right.endSec) > 0.0001) return left.endSec - right.endSec
        return left.repeatCount - right.repeatCount
      })
    const deduped: typeof normalized = []
    let lastEndSec = -1
    for (const segment of normalized) {
      if (segment.startSec < lastEndSec - 0.0001) continue
      deduped.push(segment)
      lastEndSec = segment.endSec
    }
    return deduped
  }

  const loopById = new Map<
    string,
    Array<{ startSec: number; endSec: number; repeatCount: number }>
  >()
  for (const item of entries) {
    const itemId = typeof item?.itemId === 'string' ? item.itemId.trim() : ''
    if (!itemId) continue
    const normalizedSegments = normalizeLoopSegments(item?.loopSegments ?? item?.loopSegment)
    loopById.set(itemId, normalizedSegments)
  }
  const itemIds = Array.from(loopById.keys())
  if (!itemIds.length) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < itemIds.length; offset += CHUNK_SIZE) {
        const chunk = itemIds.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(`SELECT id, info_json FROM ${TABLE} WHERE id IN (${placeholders})`)
          .all(...chunk) as Array<{ id: string; info_json?: string | null }>
        for (const row of rows) {
          const itemId = typeof row?.id === 'string' ? row.id.trim() : ''
          if (!itemId) continue
          const nextLoopSegments = loopById.get(itemId)
          if (nextLoopSegments === undefined) continue
          const info = parseItemInfoJson(row?.info_json)
          const currentLoopSegments = normalizeLoopSegments(info.loopSegments ?? info.loopSegment)
          const currentSignature = JSON.stringify(currentLoopSegments)
          const nextSignature = JSON.stringify(nextLoopSegments)
          if (currentSignature === nextSignature) continue
          if (nextLoopSegments.length > 0) {
            info.loopSegments = nextLoopSegments
            info.loopSegment = nextLoopSegments[0]
          } else {
            delete info.loopSegments
            delete info.loopSegment
          }
          info.loopSegmentsUpdatedAt = Date.now()
          info.loopSegmentUpdatedAt = Date.now()
          updateStmt.run(JSON.stringify(info), itemId)
          updated += 1
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape loop segment upsert failed', error)
    return { updated: 0 }
  }
}

export function upsertMixtapeItemStartSecById(
  entries: Array<{
    itemId: string
    startSec?: number
    masterTempo?: boolean
    originalBpm?: number
    laneIndex?: number
  }>
): { updated: number } {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }

  const normalizeStartSec = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return null
    return Number(numeric.toFixed(4))
  }

  const normalizeBpm = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    return Number(numeric.toFixed(6))
  }

  const normalizeLaneIndex = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return null
    return Math.max(0, Math.min(MIXTAPE_LANE_COUNT - 1, Math.floor(numeric)))
  }

  const trackPatchById = new Map<
    string,
    {
      startSec?: number
      masterTempo?: boolean
      originalBpm?: number
      laneIndex?: number
    }
  >()
  for (const item of entries) {
    const itemId = typeof item?.itemId === 'string' ? item.itemId.trim() : ''
    const startSec = normalizeStartSec(item?.startSec)
    const originalBpm = normalizeBpm(item?.originalBpm)
    const laneIndex = normalizeLaneIndex(item?.laneIndex)
    const masterTempo = typeof item?.masterTempo === 'boolean' ? item.masterTempo : undefined
    if (!itemId) continue
    if (
      startSec === null &&
      originalBpm === null &&
      laneIndex === null &&
      masterTempo === undefined
    ) {
      continue
    }
    const prev = trackPatchById.get(itemId) || {}
    trackPatchById.set(itemId, {
      ...prev,
      ...(startSec === null ? {} : { startSec }),
      ...(originalBpm === null ? {} : { originalBpm }),
      ...(laneIndex === null ? {} : { laneIndex }),
      ...(masterTempo === undefined ? {} : { masterTempo })
    })
  }
  const itemIds = Array.from(trackPatchById.keys())
  if (!itemIds.length) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < itemIds.length; offset += CHUNK_SIZE) {
        const chunk = itemIds.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(`SELECT id, info_json FROM ${TABLE} WHERE id IN (${placeholders})`)
          .all(...chunk) as Array<{ id: string; info_json?: string | null }>
        for (const row of rows) {
          const itemId = typeof row?.id === 'string' ? row.id.trim() : ''
          if (!itemId) continue
          const nextPatch = trackPatchById.get(itemId)
          if (!nextPatch) continue
          const info = parseItemInfoJson(row?.info_json)
          let changed = false
          if (typeof nextPatch.startSec === 'number') {
            const currentStartSec = normalizeStartSec(info.startSec)
            if (
              currentStartSec === null ||
              Math.abs(currentStartSec - Number(nextPatch.startSec)) > 0.0001
            ) {
              info.startSec = Number(nextPatch.startSec)
              info.startSecUpdatedAt = Date.now()
              changed = true
            }
          }

          if (typeof nextPatch.originalBpm === 'number') {
            const currentOriginalBpm = normalizeBpm(info.originalBpm)
            if (
              currentOriginalBpm === null ||
              Math.abs(currentOriginalBpm - Number(nextPatch.originalBpm)) > 0.0001
            ) {
              info.originalBpm = Number(nextPatch.originalBpm)
              changed = true
            }
          }

          if (typeof nextPatch.masterTempo === 'boolean') {
            const currentMasterTempo = info.masterTempo !== false
            if (currentMasterTempo !== nextPatch.masterTempo) {
              info.masterTempo = nextPatch.masterTempo
              changed = true
            }
          }

          if (typeof nextPatch.laneIndex === 'number') {
            const currentLaneIndex = normalizeLaneIndex(info.laneIndex)
            if (currentLaneIndex === null || currentLaneIndex !== nextPatch.laneIndex) {
              info.laneIndex = nextPatch.laneIndex
              info.laneIndexUpdatedAt = Date.now()
              changed = true
            }
          }

          if (!changed) continue
          updateStmt.run(JSON.stringify(info), itemId)
          updated += 1
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape start sec upsert failed', error)
    return { updated: 0 }
  }
}
