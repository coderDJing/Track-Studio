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

const PROBE_CACHE_TTL_MS = 15_000

let probeCache: {
  value: RekordboxDesktopLibraryProbe
  expiresAt: number
} | null = null
let probeInflight: Promise<RekordboxDesktopLibraryProbe> | null = null

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
  sourceName: 'Rekordbox 本机库',
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
    errorMessage: message || '未检测到可读的 Rekordbox 本机库。'
  })
}

const normalizeProbe = (
  payload: RekordboxDesktopHelperProbePayload | null | undefined
): RekordboxDesktopLibraryProbe => {
  const sourceRootPath = toTrimmedString(payload?.sourceRootPath || payload?.shareDir)
  const dbPath = toTrimmedString(payload?.dbPath)
  return {
    available: Boolean(payload?.available),
    supported: payload?.supported !== false,
    sourceKey:
      toTrimmedString(payload?.sourceKey) ||
      (dbPath ? `rekordbox-desktop:${dbPath}` : 'rekordbox-desktop'),
    sourceName: toTrimmedString(payload?.sourceName) || 'Rekordbox 本机库',
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

export async function probeRekordboxDesktopLibrary(
  forceRefresh = false
): Promise<RekordboxDesktopLibraryProbe> {
  if (!forceRefresh && probeCache && probeCache.expiresAt > Date.now()) {
    return probeCache.value
  }
  if (probeInflight) return await probeInflight

  const request = (async () => {
    let probe: RekordboxDesktopLibraryProbe
    try {
      probe = normalizeProbe(
        await runRekordboxDesktopHelper<RekordboxDesktopHelperProbePayload, Record<string, never>>(
          'probe',
          {}
        )
      )
    } catch (error) {
      probe = normalizeProbeError(error)
    }

    probeCache = {
      value: probe,
      expiresAt: Date.now() + PROBE_CACHE_TTL_MS
    }
    return probe
  })()
  probeInflight = request
  try {
    return await request
  } finally {
    if (probeInflight === request) probeInflight = null
  }
}

export async function requireRekordboxDesktopLibraryProbe() {
  const probe = await probeRekordboxDesktopLibrary(false)
  if (!probe.available) {
    throw new Error(probe.errorMessage || '未检测到可读的 Rekordbox 本机库。')
  }
  return probe
}

export async function probeRekordboxDesktopLibraryWriteAvailability(
  forceRefresh = true
): Promise<RekordboxDesktopWriteAvailability> {
  const probe = await probeRekordboxDesktopLibrary(forceRefresh)
  if (!probe.available) {
    return normalizeWriteAvailability(probe.writeStatus, {
      writable: false,
      status: 'unavailable',
      errorCode: probe.errorCode,
      errorMessage: probe.errorMessage
    })
  }

  try {
    const payload = await runRekordboxDesktopHelper<
      RekordboxDesktopHelperWriteAvailabilityPayload,
      {
        dbPath: string
        dbDir: string
        shareDir: string
      }
    >('probe-write', {
      dbPath: probe.dbPath,
      dbDir: probe.dbDir,
      shareDir: probe.shareDir
    })
    return normalizeWriteAvailability(payload, probe.writeStatus)
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
