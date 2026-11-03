import fs from 'node:fs/promises'
import type {
  MixtapeArrangementRequest,
  MixtapeArrangementResult
} from '../../shared/mixtapeArrangement'
import { getLibraryDb } from '../libraryDb'
import { listMixtapeItems } from '../mixtapeDb'
import { getMixtapeProjectBpmEnvelope } from '../mixtapeProjectTempoDb'
import { assertLibraryMergeMutationAllowed } from './libraryMerge/runtime'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const parseRequest = (value: unknown): MixtapeArrangementRequest => {
  if (
    !isRecord(value) ||
    typeof value.playlistId !== 'string' ||
    !value.playlistId.trim() ||
    !Array.isArray(value.entries) ||
    value.entries.length < 2 ||
    !Array.isArray(value.bpmEnvelope) ||
    value.bpmEnvelope.length < 2
  ) {
    throw new Error('MIXTAPE_ARRANGEMENT_INVALID')
  }
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.itemId !== 'string' ||
      !entry.itemId ||
      typeof entry.startSec !== 'number' ||
      !Number.isFinite(entry.startSec) ||
      entry.startSec < 0
    ) {
      throw new Error('MIXTAPE_ARRANGEMENT_INVALID')
    }
    return { itemId: entry.itemId, startSec: Number(entry.startSec.toFixed(4)) }
  })
  if (new Set(entries.map((entry) => entry.itemId)).size !== entries.length)
    throw new Error('MIXTAPE_ARRANGEMENT_INVALID')
  const bpmEnvelope = value.bpmEnvelope.map((point) => {
    if (
      !isRecord(point) ||
      typeof point.sec !== 'number' ||
      !Number.isFinite(point.sec) ||
      point.sec < 0 ||
      typeof point.bpm !== 'number' ||
      !Number.isFinite(point.bpm) ||
      point.bpm <= 1 ||
      point.bpm > 999
    ) {
      throw new Error('MIXTAPE_ARRANGEMENT_INVALID')
    }
    return { sec: Number(point.sec.toFixed(4)), bpm: Number(point.bpm.toFixed(4)) }
  })
  if (
    bpmEnvelope[0].sec !== 0 ||
    bpmEnvelope.some((point, i) => i > 0 && point.sec <= bpmEnvelope[i - 1].sec) ||
    typeof value.bpmEnvelopeDurationSec !== 'number' ||
    !Number.isFinite(value.bpmEnvelopeDurationSec) ||
    value.bpmEnvelopeDurationSec <= 0 ||
    typeof value.gridPhaseOffsetSec !== 'number' ||
    !Number.isFinite(value.gridPhaseOffsetSec) ||
    value.gridPhaseOffsetSec < 0
  ) {
    throw new Error('MIXTAPE_ARRANGEMENT_INVALID')
  }
  return {
    playlistId: value.playlistId.trim(),
    entries,
    bpmEnvelope,
    bpmEnvelopeDurationSec: Number(value.bpmEnvelopeDurationSec.toFixed(4)),
    gridPhaseOffsetSec: Number(value.gridPhaseOffsetSec.toFixed(4))
  }
}

export const applyMixtapeArrangement = async (
  payload: unknown
): Promise<MixtapeArrangementResult> => {
  assertLibraryMergeMutationAllowed()
  const request = parseRequest(payload)
  const items = listMixtapeItems(request.playlistId)
  const ids = new Set(items.map((item) => item.id))
  if (
    items.length !== request.entries.length ||
    request.entries.some((entry) => !ids.has(entry.itemId))
  ) {
    throw new Error('MIXTAPE_ARRANGEMENT_CHANGED')
  }
  // 写操作核对真实音频；不能用列表视图快照代替磁盘检查。
  await Promise.all(
    items.map(async (item) => {
      try {
        if (!(await fs.stat(item.filePath)).isFile()) throw new Error('not a file')
      } catch {
        throw new Error('MIXTAPE_ARRANGEMENT_MISSING_FILE')
      }
    })
  )
  assertLibraryMergeMutationAllowed()
  const db = getLibraryDb()
  if (!db) throw new Error('MIXTAPE_ARRANGEMENT_DATABASE')
  return db.transaction(() => {
    const current = listMixtapeItems(request.playlistId)
    if (
      JSON.stringify(
        current.map((item) => [item.id, item.filePath, item.mixOrder, item.infoJson])
      ) !==
      JSON.stringify(items.map((item) => [item.id, item.filePath, item.mixOrder, item.infoJson]))
    ) {
      throw new Error('MIXTAPE_ARRANGEMENT_CHANGED')
    }
    getMixtapeProjectBpmEnvelope(request.playlistId) // 确保工程行存在，仍在同一事务中。
    const project = db
      .prepare('SELECT info_json FROM mixtape_projects WHERE playlist_uuid = ?')
      .get(request.playlistId) as { info_json: string | null } | undefined
    if (!project) throw new Error('MIXTAPE_ARRANGEMENT_DATABASE')
    const projectInfo: unknown = project.info_json ? JSON.parse(project.info_json) : {}
    if (!isRecord(projectInfo)) throw new Error('MIXTAPE_ARRANGEMENT_DATABASE')
    Object.assign(projectInfo, {
      mixBpmEnvelope: request.bpmEnvelope,
      mixBpmEnvelopeDurationSec: request.bpmEnvelopeDurationSec,
      mixBpmEnvelopePhaseOffsetSec: request.gridPhaseOffsetSec,
      mixBpmEnvelopeUpdatedAt: Date.now()
    })
    const update = db.prepare(
      'UPDATE mixtape_items SET info_json = ? WHERE id = ? AND playlist_uuid = ?'
    )
    const byId = new Map(current.map((item) => [item.id, item]))
    for (const entry of request.entries) {
      const item = byId.get(entry.itemId)
      const info: unknown = item?.infoJson ? JSON.parse(item.infoJson) : {}
      if (!isRecord(info)) throw new Error('MIXTAPE_ARRANGEMENT_DATABASE')
      info.startSec = entry.startSec
      info.startSecUpdatedAt = Date.now()
      if (update.run(JSON.stringify(info), entry.itemId, request.playlistId).changes !== 1) {
        throw new Error('MIXTAPE_ARRANGEMENT_DATABASE')
      }
    }
    if (
      db
        .prepare(
          'UPDATE mixtape_projects SET info_json = ?, updated_at_ms = ? WHERE playlist_uuid = ?'
        )
        .run(JSON.stringify(projectInfo), Date.now(), request.playlistId).changes !== 1
    ) {
      throw new Error('MIXTAPE_ARRANGEMENT_DATABASE')
    }
    const { playlistId: _playlistId, ...snapshot } = request
    return { updated: current.length, snapshot }
  })()
}
