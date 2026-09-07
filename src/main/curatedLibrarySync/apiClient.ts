import store from '../store'
import { fetchWithSystemProxy } from '../fetchWithSystemProxy'
import { resolveBaseUrl } from '../serverDiscovery'
import { is } from '@electron-toolkit/utils'
import { resolveDevCloudSyncUserKey } from '../../shared/cloudSyncDevUserKey'
import {
  CURATED_LIBRARY_SYNC_BLOB_CHUNK_SIZE,
  CURATED_LIBRARY_SYNC_PROTOCOL_VERSION
} from '../../shared/curatedLibrarySync'
import type {
  CuratedLibrarySyncCloudFile,
  CuratedLibrarySyncCloudNode,
  CuratedLibrarySyncOp,
  CuratedLibrarySyncSnapshot
} from '../../shared/curatedLibrarySync'
import { parseCuratedLibrarySnapshot } from './snapshotMerge'
import {
  downloadResumableFile,
  type ResumableDownloadFetch
} from '../services/resumableHttpDownload'

const PREFIX = '/frkbapi/v1/curated-library-sync'
const API_SECRET_KEY = process.env.CLOUD_SYNC_API_SECRET_KEY || ''

type RecordLike = Record<string, unknown>

const isRecord = (value: unknown): value is RecordLike =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${API_SECRET_KEY}`,
  'Content-Type': 'application/json'
})

const getUserKey = (): string =>
  resolveDevCloudSyncUserKey(String(store.settingConfig?.cloudSyncUserKey || '').trim(), is.dev)

const asSnapshot = (raw: unknown): CuratedLibrarySyncSnapshot | null =>
  parseCuratedLibrarySnapshot(raw)

const combineSignals = (signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(60_000)
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return signal
}

async function postJson(
  pathName: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<RecordLike> {
  const baseUrl = await resolveBaseUrl()
  const res = await fetchWithSystemProxy(`${baseUrl}${PREFIX}${pathName}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: combineSignals(signal)
  })
  const json = await res.json().catch(() => null)
  if (!isRecord(json)) {
    throw new Error(`CURATED_SYNC_BAD_RESPONSE:${res.status}`)
  }
  json._httpStatus = res.status
  return json
}

export type CuratedLibrarySyncStatus = {
  revision: number
  snapshotReady: boolean
  fileCount: number
  blobBytes: number
  quotaBytes: number
  protocolVersion: number
  firstSnapshotLocked: boolean
}

export const resetCloudCuratedLibrary = async (signal?: AbortSignal): Promise<void> => {
  const json = await postJson('/reset', { userKey: getUserKey() }, signal)
  if (json.success !== true) {
    throw Object.assign(new Error(String(json.error || 'CURATED_SYNC_RESET_FAILED')), {
      payload: json
    })
  }
}

export const fetchCuratedLibraryStatus = async (
  signal?: AbortSignal
): Promise<CuratedLibrarySyncStatus> => {
  const json = await postJson('/status', { userKey: getUserKey() }, signal)
  if (json.success !== true || !isRecord(json.data)) {
    throw Object.assign(new Error(String(json.error || 'CURATED_SYNC_STATUS_FAILED')), {
      payload: json
    })
  }
  const data = json.data
  const protocolVersion = Number(data.protocolVersion)
  if (protocolVersion !== CURATED_LIBRARY_SYNC_PROTOCOL_VERSION) {
    throw new Error('CURATED_SYNC_PROTOCOL_UNSUPPORTED')
  }
  return {
    revision: Number(data.revision) || 0,
    snapshotReady: data.snapshotReady === true,
    fileCount: Number(data.fileCount) || 0,
    blobBytes: Number(data.blobBytes) || 0,
    quotaBytes: Number(data.quotaBytes) || 0,
    protocolVersion,
    firstSnapshotLocked: data.firstSnapshotLocked === true
  }
}

export const beginFirstCuratedSnapshot = async (
  signal?: AbortSignal
): Promise<{ sessionId: string }> => {
  const json = await postJson('/begin-first-snapshot', { userKey: getUserKey() }, signal)
  if (json.success !== true || !isRecord(json.data) || typeof json.data.sessionId !== 'string') {
    throw Object.assign(new Error(String(json.error || 'CURATED_SYNC_BEGIN_FAILED')), {
      payload: json
    })
  }
  return { sessionId: json.data.sessionId }
}

export const commitFirstCuratedSnapshot = async (params: {
  sessionId: string
  nodes: CuratedLibrarySyncCloudNode[]
  files: CuratedLibrarySyncCloudFile[]
  signal?: AbortSignal
}): Promise<CuratedLibrarySyncSnapshot> => {
  const json = await postJson(
    '/commit-snapshot',
    {
      userKey: getUserKey(),
      sessionId: params.sessionId,
      protocolVersion: CURATED_LIBRARY_SYNC_PROTOCOL_VERSION,
      nodes: params.nodes,
      files: params.files
    },
    params.signal
  )
  const snapshot = asSnapshot(json.data)
  if (json.success !== true || !snapshot) {
    throw Object.assign(new Error(String(json.error || 'CURATED_SYNC_COMMIT_FAILED')), {
      payload: json
    })
  }
  return snapshot
}

export const replaceCuratedSnapshot = async (params: {
  nodes: CuratedLibrarySyncCloudNode[]
  files: CuratedLibrarySyncCloudFile[]
  signal?: AbortSignal
}): Promise<CuratedLibrarySyncSnapshot> => {
  const json = await postJson(
    '/commit-snapshot',
    {
      userKey: getUserKey(),
      replaceExisting: true,
      protocolVersion: CURATED_LIBRARY_SYNC_PROTOCOL_VERSION,
      nodes: params.nodes,
      files: params.files
    },
    params.signal
  )
  const snapshot = asSnapshot(json.data)
  if (json.success !== true || !snapshot) {
    throw Object.assign(new Error(String(json.error || 'CURATED_SYNC_REPLACE_FAILED')), {
      payload: json
    })
  }
  return snapshot
}

export const pullCuratedSnapshot = async (
  sinceRevision?: number | null,
  signal?: AbortSignal
): Promise<CuratedLibrarySyncSnapshot> => {
  const body: Record<string, unknown> = { userKey: getUserKey() }
  if (Number.isFinite(Number(sinceRevision)) && Number(sinceRevision) > 0) {
    body.sinceRevision = Math.floor(Number(sinceRevision))
  }
  const json = await postJson('/pull', body, signal)
  const snapshot = asSnapshot(json.data)
  if (json.success !== true || !snapshot) {
    throw Object.assign(new Error(String(json.error || 'CURATED_SYNC_PULL_FAILED')), {
      payload: json
    })
  }
  return snapshot
}

export const pushCuratedOps = async (params: {
  baseRevision: number
  ops: CuratedLibrarySyncOp[]
  signal?: AbortSignal
}): Promise<
  | { ok: true; snapshot: CuratedLibrarySyncSnapshot }
  | { ok: false; conflict: true; snapshot: CuratedLibrarySyncSnapshot }
> => {
  const json = await postJson(
    '/push',
    {
      userKey: getUserKey(),
      baseRevision: params.baseRevision,
      protocolVersion: CURATED_LIBRARY_SYNC_PROTOCOL_VERSION,
      ops: params.ops
    },
    params.signal
  )
  const snapshot = asSnapshot(json.data)
  if (Number(json._httpStatus) === 409 && snapshot) {
    return { ok: false, conflict: true, snapshot }
  }
  if (json.success !== true || !snapshot) {
    throw Object.assign(new Error(String(json.error || 'CURATED_SYNC_PUSH_FAILED')), {
      payload: json
    })
  }
  return { ok: true, snapshot }
}

export type CuratedBlobBeginResult = {
  needed: boolean
  uploadedBytes: number
  chunkSize: number
}

export const beginBlobUpload = async (params: {
  sha256: string
  size: number
  signal?: AbortSignal
}): Promise<CuratedBlobBeginResult> => {
  const json = await postJson(
    '/blob/begin',
    {
      userKey: getUserKey(),
      sha256: params.sha256,
      size: params.size
    },
    params.signal
  )
  if (json.success !== true || !isRecord(json.data)) {
    throw Object.assign(new Error(String(json.error || 'CURATED_SYNC_BLOB_BEGIN_FAILED')), {
      payload: json
    })
  }
  return {
    needed: json.data.needed !== false,
    uploadedBytes: Math.max(0, Number(json.data.uploadedBytes) || 0),
    chunkSize: Math.max(1, Number(json.data.chunkSize) || CURATED_LIBRARY_SYNC_BLOB_CHUNK_SIZE)
  }
}

export type CuratedBlobChunkResult = {
  uploadedBytes: number
  ready: boolean
}

export class CuratedBlobOffsetMismatchError extends Error {
  uploadedBytes: number

  constructor(uploadedBytes: number) {
    super('CURATED_LIBRARY_BLOB_OFFSET_MISMATCH')
    this.name = 'CuratedBlobOffsetMismatchError'
    this.uploadedBytes = uploadedBytes
  }
}

export const uploadBlobChunk = async (params: {
  sha256: string
  size: number
  offset: number
  chunk: Buffer
  signal?: AbortSignal
}): Promise<CuratedBlobChunkResult> => {
  const baseUrl = await resolveBaseUrl()
  const userKey = encodeURIComponent(getUserKey())
  const start = Math.max(0, params.offset)
  const end = start + params.chunk.byteLength - 1
  const res = await fetchWithSystemProxy(
    `${baseUrl}${PREFIX}/blob/${params.sha256}?userKey=${userKey}&size=${params.size}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${API_SECRET_KEY}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(params.chunk.byteLength),
        'Content-Range': `bytes ${start}-${end}/${params.size}`
      },
      body: params.chunk as unknown as BodyInit,
      signal: params.signal
    }
  )
  const json = await res.json().catch(() => null)
  if (res.status === 409 && isRecord(json)) {
    const uploadedBytes = isRecord(json.data) ? Number(json.data.uploadedBytes) || 0 : 0
    throw new CuratedBlobOffsetMismatchError(uploadedBytes)
  }
  if (!res.ok || !isRecord(json) || json.success !== true) {
    const code = isRecord(json) ? String(json.error || '') : ''
    throw Object.assign(new Error(code || `CURATED_SYNC_BLOB_UPLOAD_FAILED:${res.status}`), {
      payload: json,
      httpStatus: res.status
    })
  }
  const data = isRecord(json.data) ? json.data : {}
  return {
    uploadedBytes: Math.max(start + params.chunk.byteLength, Number(data.uploadedBytes) || 0),
    ready: data.ready === true
  }
}

const proxyFetch: ResumableDownloadFetch = async (url, init) => {
  const response = await fetchWithSystemProxy(url, {
    headers: init?.headers,
    signal: init?.signal
  })
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: response.body
  }
}

export const downloadBlobFile = async (params: {
  sha256: string
  destPath: string
  expectedSize?: number
  signal?: AbortSignal
}): Promise<void> => {
  const baseUrl = await resolveBaseUrl()
  const userKey = encodeURIComponent(getUserKey())
  await downloadResumableFile(
    {
      url: `${baseUrl}${PREFIX}/blob/${params.sha256}?userKey=${userKey}`,
      destinationPath: params.destPath,
      expectedSize: params.expectedSize,
      sha256: params.sha256,
      headers: { Authorization: `Bearer ${API_SECRET_KEY}` },
      signal: params.signal
    },
    { fetch: proxyFetch }
  )
}

const parseSseBlock = (block: string): { event: string; data: string } | null => {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

export const openCuratedLibraryEventStream = async (params: {
  signal: AbortSignal
  onEvent: (event: string, data: Record<string, unknown>) => void
}): Promise<void> => {
  const baseUrl = await resolveBaseUrl()
  const userKey = encodeURIComponent(getUserKey())
  const res = await fetchWithSystemProxy(`${baseUrl}${PREFIX}/events?userKey=${userKey}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${API_SECRET_KEY}`,
      Accept: 'text/event-stream'
    },
    signal: params.signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`CURATED_SYNC_EVENTS_FAILED:${res.status}`)
  }
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = res.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n')
    while (buffer.includes('\n\n')) {
      const index = buffer.indexOf('\n\n')
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const parsed = parseSseBlock(block)
      if (!parsed) continue
      try {
        const data = JSON.parse(parsed.data) as Record<string, unknown>
        params.onEvent(parsed.event, data)
      } catch {}
    }
  }
}
