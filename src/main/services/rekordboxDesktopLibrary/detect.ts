import type {
  RekordboxDesktopHelperProbePayload,
  RekordboxDesktopHelperWriteAvailabilityPayload,
  RekordboxDesktopLibraryProbe
} from './types'
import { runRekordboxDesktopHelper } from './helper'
import type {
  RekordboxDesktopWriteAvailability,
  RekordboxDesktopWriteAvailabilityStatus
} from '../../../shared/rekordboxDesktopPlaylist'

const PROBE_CACHE_TTL_MS = 60_000

type ProbeMode = 'database' | 'source-path'
const probeCache = new Map<
  ProbeMode,
  {
    value: RekordboxDesktopLibraryProbe
    expiresAt: number
  }
>()
const probeInflight = new Map<ProbeMode, Promise<RekordboxDesktopLibraryProbe>>()

const toTrimmedString = (value: unknown) => String(value || '').trim()

const toErrorCode = (value: unknown): RekordboxDesktopLibraryProbe['errorCode'] => {
  const normalized = toTrimmedString(value)
  return normalized ? (normalized as RekordboxDesktopLibraryProbe['errorCode']) : undefined
}

const toWriteStatus = (value: unknown): RekordboxDesktopWriteAvailabilityStatus => {
  const normalized = toTrimmedString(value)
  if (
    normalized === 'available' ||
    normalized === 'busy' ||
    normalized === 'unavailable' ||
    normalized === 'unknown'
  ) {
    return normalized
  }
  return 'unknown'
}

const normalizeWriteAvailability = (
  payload: RekordboxDesktopHelperWriteAvailabilityPayload | null | undefined,
  fallback?: Partial<RekordboxDesktopWriteAvailability>
): RekordboxDesktopWriteAvailability => {
  const status = toWriteStatus(payload?.status || fallback?.status)
  const writable =
    typeof payload?.writable === 'boolean'
      ? payload.writable
      : typeof fallback?.writable === 'boolean'
        ? fallback.writable
        : status === 'available'
  return {
    writable,
    status,
    errorCode: toTrimmedString(payload?.errorCode || fallback?.errorCode) || undefined,
    errorMessage: toTrimmedString(payload?.errorMessage || fallback?.errorMessage) || undefined,
    rekordboxPid: Math.max(0, Number(payload?.rekordboxPid || fallback?.rekordboxPid) || 0),
    checkedAt: Number(payload?.checkedAt || fallback?.checkedAt) || Date.now()
  }
}

const createUnavailableProbe = (params?: {
  supported?: boolean
  errorCode?: RekordboxDesktopLibraryProbe['errorCode']
  errorMessage?: string
}): RekordboxDesktopLibraryProbe => ({
  available: false,
  supported: params?.supported !== false,
  sourceKey: 'rekordbox-desktop',
  sourceName: 'Rekordbox 库',
  sourceRootPath: '',
  dbPath: '',
  dbDir: '',
  shareDir: '',
  playlistTotal: 0,
  folderTotal: 0,
  trackTotal: 0,
  errorCode: params?.errorCode,
  errorMessage: toTrimmedString(params?.errorMessage) || undefined,
  writeStatus: normalizeWriteAvailability(null, {
    writable: false,
    status: 'unavailable',
    errorCode: params?.errorCode,
    errorMessage: params?.errorMessage
  })
})

const normalizeProbeError = (error: unknown) => {
  const code = toErrorCode((error as { code?: unknown } | null)?.code)
  const message =
    error instanceof Error
      ? error.message
      : toTrimmedString((error as { message?: unknown } | null)?.message || error)
  return createUnavailableProbe({
    supported: code !== 'UNSUPPORTED_PLATFORM',
    errorCode: code,
    errorMessage: message || '未检测到可读的 Rekordbox 库。'
  })
}

const normalizeProbe = (
  payload: RekordboxDesktopHelperProbePayload | null | undefined
): RekordboxDesktopLibraryProbe => {
  const sourceRootPath = toTrimmedString(payload?.sourceRootPath || payload?.shareDir)
  const dbPath = toTrimmedString(payload?.dbPath)
  return {
    available: Boolean(payload?.available && dbPath),
    supported: payload?.supported !== false,
    sourceKey:
      toTrimmedString(payload?.sourceKey) ||
      (dbPath ? `rekordbox-desktop:${dbPath}` : 'rekordbox-desktop'),
    sourceName: toTrimmedString(payload?.sourceName) || 'Rekordbox 库',
    sourceRootPath,
    dbPath,
    dbDir: toTrimmedString(payload?.dbDir),
    shareDir: toTrimmedString(payload?.shareDir || sourceRootPath),
    playlistTotal: Math.max(0, Number(payload?.playlistTotal) || 0),
    folderTotal: Math.max(0, Number(payload?.folderTotal) || 0),
    trackTotal: Math.max(0, Number(payload?.trackTotal) || 0),
    appVersion: toTrimmedString(payload?.appVersion) || undefined,
    libraryVersion: toTrimmedString(payload?.libraryVersion) || undefined,
    errorCode: toErrorCode(payload?.errorCode),
    errorMessage: toTrimmedString(payload?.errorMessage) || undefined,
    writeStatus: normalizeWriteAvailability(payload?.writeStatus, {
      writable: Boolean(payload?.available),
      status: payload?.available ? 'available' : 'unavailable',
      errorCode: toErrorCode(payload?.errorCode),
      errorMessage: toTrimmedString(payload?.errorMessage) || undefined
    })
  }
}

async function readLibraryProbe(
  mode: ProbeMode,
  forceRefresh: boolean
): Promise<RekordboxDesktopLibraryProbe> {
  const cached = probeCache.get(mode)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.value
  }
  const inflight = probeInflight.get(mode)
  if (inflight) return await inflight

  const request = (async () => {
    let probe: RekordboxDesktopLibraryProbe
    try {
      probe = normalizeProbe(
        await runRekordboxDesktopHelper<
          RekordboxDesktopHelperProbePayload,
          { openDatabase: boolean }
        >('probe', { openDatabase: mode === 'database' })
      )
    } catch (error) {
      probe = normalizeProbeError(error)
    }

    if (probe.available) {
      probeCache.set(mode, {
        value: probe,
        expiresAt: Date.now() + PROBE_CACHE_TTL_MS
      })
    } else {
      // A transient helper/database error must not suppress the next real check.
      probeCache.delete(mode)
    }
    return probe
  })()
  probeInflight.set(mode, request)
  try {
    return await request
  } finally {
    if (probeInflight.get(mode) === request) probeInflight.delete(mode)
  }
}

export async function probeRekordboxDesktopLibrary(forceRefresh = false) {
  return await readLibraryProbe('database', forceRefresh)
}

const assertLibraryAvailable = (probe: RekordboxDesktopLibraryProbe) => {
  if (!probe.available) {
    const code = probe.errorCode
    const detail = probe.errorMessage || '未检测到 Rekordbox master.db。'
    throw Object.assign(new Error(code ? `[${code}] ${detail}` : detail), { code })
  }
}

export async function requireRekordboxDesktopSourceDbPath() {
  // Revision checks only need the configured path; opening/counting the DB can fail
  // independently and should be reserved for actual library reads.
  const probe = await readLibraryProbe('source-path', false)
  assertLibraryAvailable(probe)
  return probe.dbPath
}

export async function requireRekordboxDesktopLibraryProbe() {
  const probe = await probeRekordboxDesktopLibrary(false)
  assertLibraryAvailable(probe)
  return probe
}

export async function probeRekordboxDesktopLibraryWriteAvailability(): Promise<RekordboxDesktopWriteAvailability> {
  try {
    // The helper resolves the current config and process on every request. A write check
    // does not need to decrypt master.db and count the entire collection first.
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperWriteAvailabilityPayload,
      Record<string, never>
    >('probe-write', {})
    return normalizeWriteAvailability(payload)
  } catch (error) {
    const code = toErrorCode((error as { code?: unknown } | null)?.code)
    const message =
      error instanceof Error
        ? error.message
        : toTrimmedString((error as { message?: unknown } | null)?.message || error)
    return normalizeWriteAvailability(null, {
      writable: false,
      status: code === 'REKORDBOX_DB_BUSY' ? 'busy' : 'unknown',
      errorCode: code,
      errorMessage: message || '检测 Rekordbox 写入状态失败。'
    })
  }
}
