import type { ISettingConfig } from '../types/globals'
import store from './store'
import { getLibraryDb, initLibraryDb, getMetaValue, setMetaValue } from './libraryDb'
import { log } from './log'
import { persistSettingConfig } from './settingsPersistence'
import type { SqliteDatabase } from './libraryDb'
import {
  DEFAULT_CLOUD_SYNC_AUTO_ENABLED,
  DEFAULT_CLOUD_SYNC_AUTO_INTERVAL_MS,
  normalizeCloudSyncAutoEnabled,
  normalizeCloudSyncAutoIntervalMs
} from '../shared/cloudSyncAuto'
import { resolveDevCloudSyncUserKey } from '../shared/cloudSyncDevUserKey'
import { is } from '@electron-toolkit/utils'

type LibrarySettingValues = Pick<
  ISettingConfig,
  | 'fingerprintMode'
  | 'audioExt'
  | 'persistSongFilters'
  | 'cloudSyncUserKey'
  | 'cloudSyncAutoEnabled'
  | 'cloudSyncAutoIntervalMs'
  | 'curatedLibrarySyncEnabled'
>

export const LIBRARY_SETTING_META_KEYS = {
  fingerprintMode: 'library_setting_fingerprint_mode',
  audioExt: 'library_setting_audio_ext',
  persistSongFilters: 'library_setting_persist_song_filters',
  cloudSyncUserKey: 'library_setting_cloud_sync_user_key',
  cloudSyncAutoEnabled: 'library_setting_cloud_sync_auto_enabled',
  cloudSyncAutoIntervalMs: 'library_setting_cloud_sync_auto_interval_ms',
  curatedLibrarySyncEnabled: 'library_setting_curated_library_sync_enabled',
  lastAppliedRevision: 'curated_library_sync_last_applied_revision',
  deferredOps: 'curated_library_sync_deferred_ops_v1',
  lastCloudIds: 'curated_library_sync_last_cloud_ids_v1',
  lastSnapshot: 'curated_library_sync_last_snapshot_v1',
  lastConflicts: 'curated_library_sync_last_conflicts_v1',
  lastFailures: 'curated_library_sync_last_failures_v1',
  lastQuota: 'curated_library_sync_last_quota_v1',
  pendingDeletedNodes: 'curated_library_sync_pending_deleted_nodes_v1'
} as const

function parseStoredValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function normalizeFingerprintMode(value: unknown): 'pcm' | 'file' | null {
  if (value === 'pcm' || value === 'file') return value
  return null
}

function normalizeAudioExt(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.map((item) => String(item || '').trim()).filter((item) => item.length > 0)
}

function normalizePersistSongFilters(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === '1') return true
  if (value === '0') return false
  return null
}

function normalizeUserKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : ''
}

function normalizeBooleanFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return null
}

function isArrayEqual(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function readLibrarySettings(db: SqliteDatabase): Partial<LibrarySettingValues> {
  const result: Partial<LibrarySettingValues> = {}
  try {
    const modeRaw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.fingerprintMode)
    if (modeRaw) {
      const parsed = parseStoredValue(modeRaw)
      const mode = normalizeFingerprintMode(parsed)
      if (mode) result.fingerprintMode = mode
    }
  } catch {}

  try {
    const audioRaw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.audioExt)
    if (audioRaw) {
      const parsed = parseStoredValue(audioRaw)
      const list = normalizeAudioExt(parsed)
      if (list !== null) result.audioExt = list
    }
  } catch {}

  try {
    const persistRaw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.persistSongFilters)
    if (persistRaw) {
      const parsed = parseStoredValue(persistRaw)
      const flag = normalizePersistSongFilters(parsed)
      if (flag !== null) result.persistSongFilters = flag
    }
  } catch {}

  try {
    const userKeyRaw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.cloudSyncUserKey)
    if (userKeyRaw !== null) {
      const parsed = parseStoredValue(userKeyRaw)
      const userKey = normalizeUserKey(parsed)
      if (userKey !== null) result.cloudSyncUserKey = userKey
    }
  } catch {}

  try {
    const autoRaw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.cloudSyncAutoEnabled)
    if (autoRaw !== null) {
      const parsed = parseStoredValue(autoRaw)
      const flag = normalizeBooleanFlag(parsed)
      if (flag !== null) result.cloudSyncAutoEnabled = flag
    }
  } catch {}

  try {
    const intervalRaw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.cloudSyncAutoIntervalMs)
    if (intervalRaw !== null) {
      const parsed = parseStoredValue(intervalRaw)
      result.cloudSyncAutoIntervalMs = normalizeCloudSyncAutoIntervalMs(parsed)
    }
  } catch {}

  try {
    const curatedRaw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.curatedLibrarySyncEnabled)
    if (curatedRaw !== null) {
      const parsed = parseStoredValue(curatedRaw)
      const flag = normalizeBooleanFlag(parsed)
      if (flag !== null) result.curatedLibrarySyncEnabled = flag
    }
  } catch {}

  return result
}

function writeLibrarySettings(db: SqliteDatabase, values: Partial<LibrarySettingValues>): void {
  try {
    if (values.fingerprintMode) {
      setMetaValue(
        db,
        LIBRARY_SETTING_META_KEYS.fingerprintMode,
        JSON.stringify(values.fingerprintMode)
      )
    }
    if (Array.isArray(values.audioExt)) {
      setMetaValue(db, LIBRARY_SETTING_META_KEYS.audioExt, JSON.stringify(values.audioExt))
    }
    if (typeof values.persistSongFilters === 'boolean') {
      setMetaValue(
        db,
        LIBRARY_SETTING_META_KEYS.persistSongFilters,
        JSON.stringify(values.persistSongFilters)
      )
    }
    if (typeof values.cloudSyncUserKey === 'string') {
      setMetaValue(
        db,
        LIBRARY_SETTING_META_KEYS.cloudSyncUserKey,
        JSON.stringify(values.cloudSyncUserKey)
      )
    }
    if (typeof values.cloudSyncAutoEnabled === 'boolean') {
      setMetaValue(
        db,
        LIBRARY_SETTING_META_KEYS.cloudSyncAutoEnabled,
        JSON.stringify(values.cloudSyncAutoEnabled)
      )
    }
    if (typeof values.cloudSyncAutoIntervalMs === 'number') {
      setMetaValue(
        db,
        LIBRARY_SETTING_META_KEYS.cloudSyncAutoIntervalMs,
        JSON.stringify(normalizeCloudSyncAutoIntervalMs(values.cloudSyncAutoIntervalMs))
      )
    }
    if (typeof values.curatedLibrarySyncEnabled === 'boolean') {
      setMetaValue(
        db,
        LIBRARY_SETTING_META_KEYS.curatedLibrarySyncEnabled,
        JSON.stringify(values.curatedLibrarySyncEnabled)
      )
    }
  } catch {}
}

function getDbForCurrentLibrary(): SqliteDatabase | null {
  const root = store.databaseDir
  if (!root) return null
  if (store.settingConfig?.databaseUrl && store.settingConfig.databaseUrl !== root) return null
  return initLibraryDb(root)
}

export function isCuratedLibrarySyncEnabled(): boolean {
  return store.settingConfig?.curatedLibrarySyncEnabled === true
}

export function getCuratedLibrarySyncLastAppliedRevision(): number | null {
  const db = getLibraryDb()
  if (!db) return null
  const raw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.lastAppliedRevision)
  if (raw === null || raw === '') return null
  const value = parseStoredValue(raw)
  // JSON null 必须当「未对齐」；Number(null)===0，会和「已落地空云端 revision 0」撞车，
  // 清空云端后误走增量，把本机精选库整库推回去。
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.floor(parsed)
}

export function setCuratedLibrarySyncLastAppliedRevision(revision: number | null): void {
  const db = getLibraryDb()
  if (!db) return
  if (revision === null) {
    setMetaValue(db, LIBRARY_SETTING_META_KEYS.lastAppliedRevision, JSON.stringify(null))
    return
  }
  setMetaValue(
    db,
    LIBRARY_SETTING_META_KEYS.lastAppliedRevision,
    JSON.stringify(Math.max(0, Math.floor(revision)))
  )
}

export function readCuratedLibrarySyncDeferredOps(): unknown {
  const db = getLibraryDb()
  if (!db) return []
  const raw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.deferredOps)
  if (!raw) return []
  return parseStoredValue(raw)
}

export function writeCuratedLibrarySyncDeferredOps(value: unknown): void {
  const db = getLibraryDb()
  if (!db) return
  setMetaValue(db, LIBRARY_SETTING_META_KEYS.deferredOps, JSON.stringify(value ?? []))
}

export type CuratedLibrarySyncLastCloudIds = {
  files: string[]
  nodes: string[]
  materialized?: boolean
}

export function readCuratedLibrarySyncLastCloudIds(): CuratedLibrarySyncLastCloudIds | null {
  const db = getLibraryDb()
  if (!db) return null
  const raw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.lastCloudIds)
  if (!raw) return null
  const parsed = parseStoredValue(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const files = (parsed as { files?: unknown }).files
  const nodes = (parsed as { nodes?: unknown }).nodes
  if (!Array.isArray(files) || !Array.isArray(nodes)) return null
  return {
    files: files.map((item) => String(item || '').trim()).filter(Boolean),
    nodes: nodes.map((item) => String(item || '').trim()).filter(Boolean),
    materialized: (parsed as { materialized?: unknown }).materialized === true
  }
}

export function writeCuratedLibrarySyncLastCloudIds(
  value: CuratedLibrarySyncLastCloudIds | null
): void {
  const db = getLibraryDb()
  if (!db) return
  if (!value) {
    setMetaValue(db, LIBRARY_SETTING_META_KEYS.lastCloudIds, JSON.stringify(null))
    return
  }
  setMetaValue(
    db,
    LIBRARY_SETTING_META_KEYS.lastCloudIds,
    JSON.stringify({
      files: value.files.map((item) => String(item || '').trim()).filter(Boolean),
      nodes: value.nodes.map((item) => String(item || '').trim()).filter(Boolean),
      materialized: value.materialized === true
    })
  )
}

export function readCuratedLibrarySyncLastSnapshot(): unknown {
  const db = getLibraryDb()
  if (!db) return null
  const raw = getMetaValue(db, LIBRARY_SETTING_META_KEYS.lastSnapshot)
  if (!raw) return null
  return parseStoredValue(raw)
}

export function writeCuratedLibrarySyncLastSnapshot(value: unknown): void {
  const db = getLibraryDb()
  if (!db) return
  if (value == null) {
    setMetaValue(db, LIBRARY_SETTING_META_KEYS.lastSnapshot, JSON.stringify(null))
    return
  }
  setMetaValue(db, LIBRARY_SETTING_META_KEYS.lastSnapshot, JSON.stringify(value))
}

const readJsonMeta = (key: string): unknown => {
  const db = getLibraryDb()
  if (!db) return null
  const raw = getMetaValue(db, key)
  if (!raw) return null
  return parseStoredValue(raw)
}

const writeJsonMeta = (key: string, value: unknown): void => {
  const db = getLibraryDb()
  if (!db) return
  setMetaValue(db, key, JSON.stringify(value ?? null))
}

export function readCuratedLibrarySyncConflicts(): unknown {
  return readJsonMeta(LIBRARY_SETTING_META_KEYS.lastConflicts)
}

export function writeCuratedLibrarySyncConflicts(value: unknown): void {
  writeJsonMeta(LIBRARY_SETTING_META_KEYS.lastConflicts, value)
}

export function readCuratedLibrarySyncFailures(): unknown {
  return readJsonMeta(LIBRARY_SETTING_META_KEYS.lastFailures)
}

export function writeCuratedLibrarySyncFailures(value: unknown): void {
  writeJsonMeta(LIBRARY_SETTING_META_KEYS.lastFailures, value)
}

export function readCuratedLibrarySyncQuotaCache(): unknown {
  return readJsonMeta(LIBRARY_SETTING_META_KEYS.lastQuota)
}

export function writeCuratedLibrarySyncQuotaCache(value: unknown): void {
  writeJsonMeta(LIBRARY_SETTING_META_KEYS.lastQuota, value)
}

export function readCuratedLibrarySyncPendingDeletedNodeIds(): string[] {
  const raw = readJsonMeta(LIBRARY_SETTING_META_KEYS.pendingDeletedNodes)
  if (!Array.isArray(raw)) return []
  return raw.map((item) => String(item || '').trim()).filter(Boolean)
}

export function writeCuratedLibrarySyncPendingDeletedNodeIds(ids: string[]): void {
  const unique = [...new Set(ids.map((item) => String(item || '').trim()).filter(Boolean))]
  writeJsonMeta(LIBRARY_SETTING_META_KEYS.pendingDeletedNodes, unique)
}

/** 忘掉本机已接上云精选库的锚点，下次同步会重新走首次对齐。 */
export function forgetCuratedLibrarySyncJoinState(): void {
  setCuratedLibrarySyncLastAppliedRevision(null)
  writeCuratedLibrarySyncLastCloudIds(null)
  writeCuratedLibrarySyncLastSnapshot(null)
  writeCuratedLibrarySyncDeferredOps([])
  writeCuratedLibrarySyncConflicts([])
  writeCuratedLibrarySyncFailures([])
  writeCuratedLibrarySyncQuotaCache({
    quotaUsedBytes: 0,
    quotaBytes: 0,
    fileCount: 0,
    revision: 0,
    snapshotReady: false
  })
  writeCuratedLibrarySyncPendingDeletedNodeIds([])
}

export async function syncLibrarySettingsFromDb(dirPath?: string): Promise<void> {
  const db = dirPath ? initLibraryDb(dirPath) : getLibraryDb()
  if (!db) return
  const current = store.settingConfig || ({} as ISettingConfig)
  const dbValues = readLibrarySettings(db)
  const toWrite: Partial<LibrarySettingValues> = {}
  let changed = false

  const currentMode = normalizeFingerprintMode(current.fingerprintMode)
  if (dbValues.fingerprintMode) {
    if (currentMode !== dbValues.fingerprintMode) {
      current.fingerprintMode = dbValues.fingerprintMode
      changed = true
    }
  } else if (currentMode) {
    toWrite.fingerprintMode = currentMode
  }

  const currentAudio = normalizeAudioExt(current.audioExt)
  if (dbValues.audioExt !== undefined) {
    if (!isArrayEqual(currentAudio, dbValues.audioExt || [])) {
      current.audioExt = dbValues.audioExt || []
      changed = true
    }
  } else if (currentAudio !== null) {
    toWrite.audioExt = currentAudio
  }

  const currentPersist = normalizePersistSongFilters(current.persistSongFilters)
  if (dbValues.persistSongFilters !== undefined) {
    if (currentPersist !== dbValues.persistSongFilters) {
      current.persistSongFilters = !!dbValues.persistSongFilters
      changed = true
    }
  } else if (currentPersist !== null) {
    toWrite.persistSongFilters = currentPersist
  }

  const currentUserKey = String(current.cloudSyncUserKey || '').trim()
  if (dbValues.cloudSyncUserKey !== undefined) {
    if (currentUserKey !== dbValues.cloudSyncUserKey) {
      current.cloudSyncUserKey = dbValues.cloudSyncUserKey
      changed = true
    }
  } else {
    toWrite.cloudSyncUserKey = currentUserKey
  }
  if (is.dev) {
    const nextUserKey = resolveDevCloudSyncUserKey(
      String(current.cloudSyncUserKey || '').trim(),
      true
    )
    if (nextUserKey !== String(current.cloudSyncUserKey || '').trim()) {
      current.cloudSyncUserKey = nextUserKey
      toWrite.cloudSyncUserKey = nextUserKey
      changed = true
    }
  }

  const currentAutoEnabled = normalizeCloudSyncAutoEnabled(current.cloudSyncAutoEnabled)
  if (dbValues.cloudSyncAutoEnabled !== undefined) {
    if (currentAutoEnabled !== dbValues.cloudSyncAutoEnabled) {
      current.cloudSyncAutoEnabled = dbValues.cloudSyncAutoEnabled
      changed = true
    }
  } else {
    toWrite.cloudSyncAutoEnabled =
      typeof current.cloudSyncAutoEnabled === 'boolean'
        ? currentAutoEnabled
        : DEFAULT_CLOUD_SYNC_AUTO_ENABLED
  }

  const currentInterval = normalizeCloudSyncAutoIntervalMs(current.cloudSyncAutoIntervalMs)
  if (dbValues.cloudSyncAutoIntervalMs !== undefined) {
    if (currentInterval !== dbValues.cloudSyncAutoIntervalMs) {
      current.cloudSyncAutoIntervalMs = dbValues.cloudSyncAutoIntervalMs
      changed = true
    }
  } else {
    toWrite.cloudSyncAutoIntervalMs = current.cloudSyncAutoIntervalMs
      ? currentInterval
      : DEFAULT_CLOUD_SYNC_AUTO_INTERVAL_MS
  }

  if (dbValues.curatedLibrarySyncEnabled !== undefined) {
    if (current.curatedLibrarySyncEnabled !== dbValues.curatedLibrarySyncEnabled) {
      current.curatedLibrarySyncEnabled = dbValues.curatedLibrarySyncEnabled
      changed = true
    }
  } else {
    toWrite.curatedLibrarySyncEnabled = current.curatedLibrarySyncEnabled === true
    if (current.curatedLibrarySyncEnabled !== false) {
      current.curatedLibrarySyncEnabled = false
      changed = true
    }
  }

  if (Object.keys(toWrite).length > 0) {
    writeLibrarySettings(db, toWrite)
  }

  if (changed) {
    try {
      store.settingConfig = current
      await persistSettingConfig(current)
    } catch (error) {
      log.error('[library-settings] persist config failed', error)
    }
  }
}

export async function saveLibrarySettingsFromConfig(): Promise<void> {
  const db = getDbForCurrentLibrary()
  if (!db) return
  const current = store.settingConfig || ({} as ISettingConfig)
  const mode = normalizeFingerprintMode(current.fingerprintMode)
  const audio = normalizeAudioExt(current.audioExt)
  const persist = normalizePersistSongFilters(current.persistSongFilters)
  writeLibrarySettings(db, {
    fingerprintMode: mode || undefined,
    audioExt: audio !== null ? audio : undefined,
    persistSongFilters: persist !== null ? persist : undefined,
    cloudSyncUserKey: String(current.cloudSyncUserKey || '').trim(),
    cloudSyncAutoEnabled: normalizeCloudSyncAutoEnabled(current.cloudSyncAutoEnabled),
    cloudSyncAutoIntervalMs: normalizeCloudSyncAutoIntervalMs(current.cloudSyncAutoIntervalMs),
    curatedLibrarySyncEnabled: current.curatedLibrarySyncEnabled === true
  })
}
