import type {
  CollectionHealthActionFailure,
  CollectionHealthActionResponse,
  CollectionHealthCheck,
  CollectionHealthCheckResult,
  CollectionHealthCheckStatus,
  CollectionHealthSnapshot,
  CollectionHealthTrackHit,
  CollectionHealthTrackRef
} from '../../../shared/collectionHealth'
import type { CoreLibraryName } from '../../coreLibraries'
import { getBackgroundIdleSnapshot } from '../backgroundIdleGate'
import { requestBackgroundTaskExecution } from '../backgroundOrchestrator'
import { log } from '../../log'
import { resolveAbsoluteFilePath } from '../../libraryCacheDb/pathResolvers'
import { moveFileToRecycleBin } from '../../recycleBinService'
import { enumerateLibraryTracks, type LibraryTrack } from './libraryTracks'
import {
  DEFAULT_LOW_BITRATE_KBPS,
  buildAlbumTagsResult,
  buildLowBitrateResult,
  trackRefKey,
  trackRuntimeKey,
  toTrackHit
} from './fastChecks'
import { buildDuplicatesResult, type DuplicateScan } from './duplicates'
import {
  addIgnore,
  addDuplicateMutes,
  ignoreKey,
  isProbeFresh,
  loadDuplicateMutes,
  loadIgnoreKeys,
  loadIgnoreRows,
  loadProbes,
  pruneIgnores,
  removeIgnore,
  writeProbe
} from './store'
import { probeAudioOffMainThread, cancelCollectionHealthProbes } from './probeWorker'
import { sortFingerprintPair } from './fingerprint'

export type ProbeState = {
  hasCover: boolean | null
  fingerprint: string | null
}

type Session = {
  requestId: number
  libraryName: CoreLibraryName
  thresholdKbps: number
  tracks: LibraryTrack[]
  trackByRefKey: Map<string, LibraryTrack>
  probeByRuntimeKey: Map<string, ProbeState>
  ignoredKeys: Set<string>
  mutedPairs: Set<string>
  pendingRuntimeKeys: string[]
  pendingCursor: number
  listRootKeys: string[]
  running: boolean
  closed: boolean
  emittedAt: number
  emitTimer: NodeJS.Timeout | null
  retryTimer: NodeJS.Timeout | null
  duplicateScan: DuplicateScan | null
  duplicateGroupFingerprints: Map<string, string[]>
  fastChecks: {
    lowBitrate: CollectionHealthCheckResult
    albumTags: CollectionHealthCheckResult
  } | null
  noCoverResult: CollectionHealthCheckResult | null
  noCoverDirty: boolean
  lastIdleCheckAt: number
  lastIdleAllowed: boolean
}

let session: Session | null = null
let requestSequence = 0
let latestSnapshot: CollectionHealthSnapshot | null = null
let snapshotSender: ((snapshot: CollectionHealthSnapshot) => void) | null = null

const IDLE_CHECK_INTERVAL_MS = 500
const EMIT_INTERVAL_MS = 250
const RETRY_DELAY_MS = 5000

export const setCollectionHealthSnapshotSender = (
  sender: ((snapshot: CollectionHealthSnapshot) => void) | null
) => {
  snapshotSender = sender
}

export const getCollectionHealthSnapshot = (
  requestId?: number
): CollectionHealthSnapshot | null => {
  if (!latestSnapshot) return null
  if (typeof requestId === 'number' && latestSnapshot.requestId !== requestId) return null
  return latestSnapshot
}

const pendingCount = (current: Session): number =>
  current.tracks.length - current.probeByRuntimeKey.size

const probeStatus = (current: Session): CollectionHealthCheckStatus => {
  if (pendingCount(current) <= 0) return 'ready'
  return current.running ? 'working' : 'waiting-idle'
}

const buildNoCoverResult = (current: Session): CollectionHealthCheckResult => {
  const hits: LibraryTrack[] = []
  const ignoredTracks: CollectionHealthTrackHit[] = []
  for (const track of current.tracks) {
    const state = current.probeByRuntimeKey.get(trackRuntimeKey(track))
    if (!state || state.hasCover !== false) continue
    if (current.ignoredKeys.has(ignoreKey(track.listRoot, track.filePath, 'noCover'))) {
      ignoredTracks.push(toTrackHit(track))
    } else {
      hits.push(track)
    }
  }
  hits.sort((left, right) => left.fileName.localeCompare(right.fileName))
  return {
    status: probeStatus(current),
    hitCount: hits.length,
    ignoredCount: ignoredTracks.length,
    trackHits: hits.map(toTrackHit),
    ignoredTracks,
    albumGroups: [],
    duplicateGroups: [],
    done: current.probeByRuntimeKey.size,
    total: current.tracks.length
  }
}

const recomputeFastChecks = (current: Session) => {
  current.fastChecks = {
    lowBitrate: buildLowBitrateResult(current.tracks, current.thresholdKbps, current.ignoredKeys),
    albumTags: buildAlbumTagsResult(current.tracks, current.ignoredKeys)
  }
}

const recomputeDuplicates = (current: Session) => {
  const fingerprintByRuntimeKey = new Map<string, string>()
  for (const [runtimeKey, state] of current.probeByRuntimeKey) {
    if (state.fingerprint) fingerprintByRuntimeKey.set(runtimeKey, state.fingerprint)
  }
  const scan = buildDuplicatesResult({
    tracks: current.tracks,
    fingerprintByRuntimeKey,
    ignoredKeys: current.ignoredKeys,
    mutedPairs: current.mutedPairs,
    status: probeStatus(current),
    done: current.probeByRuntimeKey.size
  })
  current.duplicateScan = scan
  current.duplicateGroupFingerprints = scan.groupFingerprints
}

const buildEmptyCheck = (status: CollectionHealthCheckStatus): CollectionHealthCheckResult => ({
  status,
  hitCount: 0,
  ignoredCount: 0,
  trackHits: [],
  ignoredTracks: [],
  albumGroups: [],
  duplicateGroups: [],
  done: 0,
  total: 0
})

const buildSnapshot = (current: Session): CollectionHealthSnapshot => {
  if (!current.fastChecks) recomputeFastChecks(current)
  if (current.noCoverDirty || !current.noCoverResult) {
    current.noCoverResult = buildNoCoverResult(current)
    current.noCoverDirty = false
  }
  const status = probeStatus(current)
  const duplicates = current.duplicateScan?.result ?? buildEmptyCheck(status)
  const fast = current.fastChecks as NonNullable<Session['fastChecks']>
  return {
    requestId: current.requestId,
    libraryName: current.libraryName,
    lowBitrateThresholdKbps: current.thresholdKbps,
    scannedAtMs: Date.now(),
    checks: {
      lowBitrate: fast.lowBitrate,
      noCover: { ...current.noCoverResult, status },
      albumTags: fast.albumTags,
      duplicates: { ...duplicates, status }
    }
  }
}

const emitNow = (current: Session) => {
  if (current.closed) return
  current.emittedAt = Date.now()
  const snapshot = buildSnapshot(current)
  latestSnapshot = snapshot
  try {
    snapshotSender?.(snapshot)
  } catch (error) {
    log.error('[collection-health] snapshot send failed', error)
  }
}

const scheduleEmit = (current: Session, force = false) => {
  if (current.closed) return
  if (force) {
    if (current.emitTimer) {
      clearTimeout(current.emitTimer)
      current.emitTimer = null
    }
    emitNow(current)
    return
  }
  const elapsed = Date.now() - current.emittedAt
  if (elapsed >= EMIT_INTERVAL_MS) {
    emitNow(current)
    return
  }
  if (current.emitTimer) return
  current.emitTimer = setTimeout(() => {
    current.emitTimer = null
    emitNow(current)
  }, EMIT_INTERVAL_MS - elapsed)
}

const clearTimers = (current: Session) => {
  if (current.emitTimer) clearTimeout(current.emitTimer)
  if (current.retryTimer) clearTimeout(current.retryTimer)
  current.emitTimer = null
  current.retryTimer = null
}

const canContinueProbing = (current: Session): boolean => {
  if (current.closed) return false
  const now = Date.now()
  if (now - current.lastIdleCheckAt >= IDLE_CHECK_INTERVAL_MS) {
    current.lastIdleCheckAt = now
    current.lastIdleAllowed = getBackgroundIdleSnapshot().allowed
  }
  return current.lastIdleAllowed
}

const nextPendingTrack = (current: Session): LibraryTrack | null => {
  while (current.pendingCursor < current.pendingRuntimeKeys.length) {
    const runtimeKey = current.pendingRuntimeKeys[current.pendingCursor]
    current.pendingCursor += 1
    if (!current.trackByRefKey.has(runtimeKey)) continue
    if (current.probeByRuntimeKey.has(runtimeKey)) continue
    const track = current.trackByRefKey.get(runtimeKey)
    if (track) return track
  }
  return null
}

const scheduleRetry = (current: Session) => {
  if (current.closed || current.retryTimer) return
  current.retryTimer = setTimeout(() => {
    current.retryTimer = null
    if (!session || session !== current || current.closed) return
    requestBackgroundTaskExecution({
      category: 'collection-health',
      trigger: 'collection-health-retry',
      run: () => runScanBatch(current)
    })
  }, RETRY_DELAY_MS)
  current.retryTimer.unref?.()
}

const runScanBatch = async (current: Session) => {
  if (current.closed || current.running) return
  if (!canContinueProbing(current)) {
    scheduleRetry(current)
    scheduleEmit(current, true)
    return
  }
  current.running = true
  current.noCoverDirty = true
  scheduleEmit(current, true)
  try {
    while (true) {
      const track = nextPendingTrack(current)
      if (!track) break
      if (!canContinueProbing(current)) break
      const runtimeKey = trackRuntimeKey(track)
      let state: ProbeState
      try {
        const probed = await probeAudioOffMainThread(track.absFilePath)
        state = { hasCover: probed.hasCover, fingerprint: probed.fingerprint }
      } catch (error) {
        if (current.closed) return
        state = { hasCover: null, fingerprint: null }
        log.error('[collection-health] probe failed', {
          filePath: track.absFilePath,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      if (current.closed) return
      current.probeByRuntimeKey.set(runtimeKey, state)
      current.noCoverDirty = true
      try {
        writeProbe({
          listRoot: track.listRoot,
          filePath: track.filePath,
          size: track.size,
          mtimeMs: track.mtimeMs,
          hasCover: state.hasCover,
          fingerprint: state.fingerprint
        })
      } catch (error) {
        log.error('[collection-health] probe write failed', error)
      }
      scheduleEmit(current)
    }
  } finally {
    current.running = false
  }
  if (current.closed) return
  recomputeDuplicates(current)
  scheduleEmit(current, true)
  if (pendingCount(current) > 0) {
    scheduleRetry(current)
  } else {
    finalizeScan(current)
  }
}

let finalizedRequestId = 0
const finalizeScan = (current: Session) => {
  if (finalizedRequestId === current.requestId) return
  finalizedRequestId = current.requestId
  try {
    const aliveKeys = new Set<string>()
    for (const track of current.tracks) {
      for (const check of ['lowBitrate', 'noCover', 'albumTags', 'duplicates'] as const) {
        aliveKeys.add(ignoreKey(track.listRoot, track.filePath, check))
      }
    }
    pruneIgnores(aliveKeys, current.listRootKeys)
  } catch (error) {
    log.error('[collection-health] ignore prune failed', error)
  }
}

const buildRuntimeTrackMap = (tracks: LibraryTrack[]) => {
  const map = new Map<string, LibraryTrack>()
  for (const track of tracks) map.set(trackRuntimeKey(track), track)
  return map
}

const resolveRef = (current: Session, ref: CollectionHealthTrackRef): LibraryTrack | null => {
  if (!ref || typeof ref.listRoot !== 'string' || typeof ref.filePath !== 'string') return null
  return current.trackByRefKey.get(trackRefKey(ref.listRoot, ref.filePath)) || null
}

export async function startCollectionHealthScan(params: {
  libraryName: CoreLibraryName
  lowBitrateThresholdKbps?: number
}): Promise<CollectionHealthSnapshot | null> {
  stopCollectionHealthScan()
  const requestId = ++requestSequence
  const threshold =
    Number.isFinite(params.lowBitrateThresholdKbps) && Number(params.lowBitrateThresholdKbps) > 0
      ? Math.round(Number(params.lowBitrateThresholdKbps))
      : DEFAULT_LOW_BITRATE_KBPS
  const created: Session = {
    requestId,
    libraryName: params.libraryName,
    thresholdKbps: threshold,
    tracks: [],
    trackByRefKey: new Map(),
    probeByRuntimeKey: new Map(),
    ignoredKeys: new Set(),
    mutedPairs: new Set(),
    pendingRuntimeKeys: [],
    pendingCursor: 0,
    listRootKeys: [],
    running: false,
    closed: false,
    emittedAt: 0,
    emitTimer: null,
    retryTimer: null,
    duplicateScan: null,
    duplicateGroupFingerprints: new Map(),
    fastChecks: null,
    noCoverResult: null,
    noCoverDirty: true,
    lastIdleCheckAt: 0,
    lastIdleAllowed: true
  }
  session = created
  const tracks = await enumerateLibraryTracks(params.libraryName, () => created.closed)
  if (!tracks || created.closed) {
    if (session === created) session = null
    return null
  }
  created.tracks = tracks
  created.trackByRefKey = buildRuntimeTrackMap(tracks)
  created.listRootKeys = [...new Set(tracks.map((track) => track.listRoot))]
  try {
    created.ignoredKeys = loadIgnoreKeys(loadIgnoreRows(created.listRootKeys))
    created.mutedPairs = loadDuplicateMutes()
  } catch (error) {
    log.error('[collection-health] load ignore state failed', error)
  }
  try {
    const probes = loadProbes(created.listRootKeys)
    for (const probe of probes) {
      const abs = resolveAbsoluteFilePath(probe.listRoot, probe.filePath)
      if (!abs) continue
      const track = created.trackByRefKey.get(trackRefKey(probe.listRoot, abs))
      if (!track) continue
      if (!isProbeFresh(probe, track.size, track.mtimeMs)) continue
      created.probeByRuntimeKey.set(trackRuntimeKey(track), {
        hasCover: probe.hasCover,
        fingerprint: probe.fingerprint
      })
    }
  } catch (error) {
    log.error('[collection-health] load probes failed', error)
  }
  created.pendingRuntimeKeys = tracks
    .map(trackRuntimeKey)
    .filter((runtimeKey) => !created.probeByRuntimeKey.has(runtimeKey))
  recomputeFastChecks(created)
  recomputeDuplicates(created)
  scheduleEmit(created, true)
  if (created.pendingRuntimeKeys.length > 0) {
    requestBackgroundTaskExecution({
      category: 'collection-health',
      trigger: 'collection-health-start',
      run: () => runScanBatch(created)
    })
  } else {
    finalizeScan(created)
  }
  return latestSnapshot
}

export function stopCollectionHealthScan(requestId?: number): void {
  const current = session
  if (!current) return
  if (typeof requestId === 'number' && current.requestId !== requestId) return
  current.closed = true
  clearTimers(current)
  session = null
  if (latestSnapshot?.requestId === current.requestId) latestSnapshot = null
  cancelCollectionHealthProbes()
}

const touchSession = (): Session | null => (session && !session.closed ? session : null)

export function setCollectionHealthIgnore(params: {
  requestId: number
  listRoot: string
  filePath: string
  check: CollectionHealthCheck
  ignored: boolean
}): CollectionHealthSnapshot | null {
  const current = touchSession()
  if (!current || current.requestId !== params.requestId) return null
  const track = resolveRef(current, { listRoot: params.listRoot, filePath: params.filePath })
  if (!track) return null
  try {
    if (params.ignored) addIgnore(track.listRoot, track.filePath, params.check)
    else removeIgnore(track.listRoot, track.filePath, params.check)
  } catch (error) {
    log.error('[collection-health] ignore write failed', error)
    return latestSnapshot
  }
  const key = ignoreKey(track.listRoot, track.filePath, params.check)
  if (params.ignored) current.ignoredKeys.add(key)
  else current.ignoredKeys.delete(key)
  recomputeFastChecks(current)
  current.noCoverDirty = true
  if (params.check === 'duplicates') recomputeDuplicates(current)
  scheduleEmit(current, true)
  return latestSnapshot
}

export function markDuplicateGroupNotDuplicate(params: {
  requestId: number
  groupId: string
}): CollectionHealthSnapshot | null {
  const current = touchSession()
  if (!current || current.requestId !== params.requestId) return null
  const fingerprints = current.duplicateGroupFingerprints.get(params.groupId)
  if (!fingerprints || fingerprints.length < 2) return latestSnapshot
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < fingerprints.length; i += 1) {
    for (let j = i + 1; j < fingerprints.length; j += 1) {
      const [a, b] =
        fingerprints[i] <= fingerprints[j]
          ? [fingerprints[i], fingerprints[j]]
          : [fingerprints[j], fingerprints[i]]
      pairs.push([a, b])
    }
  }
  try {
    addDuplicateMutes(pairs)
  } catch (error) {
    log.error('[collection-health] duplicate mute write failed', error)
    return latestSnapshot
  }
  for (const [a, b] of pairs) current.mutedPairs.add(sortFingerprintPair(a, b))
  recomputeDuplicates(current)
  scheduleEmit(current, true)
  return latestSnapshot
}

const removeTrackFromSession = (current: Session, runtimeKey: string) => {
  const track = current.trackByRefKey.get(runtimeKey)
  current.trackByRefKey.delete(runtimeKey)
  current.probeByRuntimeKey.delete(runtimeKey)
  if (!track) return
  current.tracks = current.tracks.filter((item) => item !== track)
}

export async function removeDuplicateTracks(params: {
  requestId: number
  keep: CollectionHealthTrackRef
  remove: CollectionHealthTrackRef[]
}): Promise<CollectionHealthActionResponse | null> {
  const current = touchSession()
  if (!current || current.requestId !== params.requestId) return null
  const keepTrack = resolveRef(current, params.keep)
  if (!keepTrack) return null
  const failed: CollectionHealthActionFailure[] = []
  const listRootByDirCache = new Map<string, string | null>()
  for (const ref of params.remove) {
    const track = resolveRef(current, ref)
    if (!track) continue
    if (track === keepTrack) continue
    try {
      const result = await moveFileToRecycleBin(track.absFilePath, {
        sourceType: 'unknown',
        listRootByDirCache
      })
      if (result.status === 'failed') {
        failed.push({ filePath: track.absFilePath, error: result.error || 'recycle-bin-failed' })
        continue
      }
      removeTrackFromSession(current, trackRuntimeKey(track))
    } catch (error) {
      failed.push({
        filePath: track.absFilePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  recomputeFastChecks(current)
  current.noCoverDirty = true
  recomputeDuplicates(current)
  scheduleEmit(current, true)
  if (!latestSnapshot) return null
  return { snapshot: latestSnapshot, failed }
}

/** 动作模块改完磁盘/标签后调用：曲目对象已就地更新，这里只负责重算与广播。 */
export function notifyCollectionHealthTracksChanged(
  requestId: number
): CollectionHealthSnapshot | null {
  const current = touchSession()
  if (!current || current.requestId !== requestId) return null
  recomputeFastChecks(current)
  current.noCoverDirty = true
  recomputeDuplicates(current)
  scheduleEmit(current, true)
  return latestSnapshot
}

/** 供动作模块复用：按“歌单根 + 绝对路径”从当前会话定位曲目。 */
export function resolveCollectionHealthTrack(
  requestId: number,
  ref: CollectionHealthTrackRef
): LibraryTrack | null {
  const current = touchSession()
  if (!current || current.requestId !== requestId) return null
  return resolveRef(current, ref)
}

export const __collectionHealthTest = {
  buildSnapshot
}
