import path = require('path')
import fs = require('fs-extra')
import store from '../store'
import mainWindow from '../window/mainWindow'
import { log } from '../log'
import type { ISongInfo } from '../../types/globals'
import { runWithConcurrency } from '../nodeTaskUtils'
import {
  findPlaylistViewSnapshotUuidsByRoot,
  listPlaylistViewSnapshotVerificationCandidates,
  loadPlaylistViewSnapshot,
  loadPlaylistViewSnapshotMeta,
  savePlaylistViewSnapshot,
  touchPlaylistViewSnapshotIdentity,
  touchPlaylistViewSnapshotVerified
} from '../libraryCacheDb/playlistViewSnapshot'
import { loadSongCacheFileStats } from '../libraryCacheDb/songCacheFileStats'
import { normalizePath, resolveCacheListRootAbs } from '../libraryCacheDb/pathResolvers'
import { createSongListItemComparator } from '../../shared/songListItemCompare'
import { planSongListMerge } from '../../shared/playlistViewMerge'
import { computePlaylistIdentityDigest } from './playlistIdentitySignature'
import { listPlaylistAudioFilesWithStat, PLAYLIST_STAT_CONCURRENCY } from './playlistScanPrepare'
import { scanSongListOffMainThread } from './songListScanWorker'
import type { scanSongList } from './scanSongs'

type ScanSongListResult = Awaited<ReturnType<typeof scanSongList>>

/**
 * 歌单视图快照服务：把"打开歌单"从"扫盘 + 核对"变成"读一行 + JSON.parse"。
 *
 * 分工（红线，改动前先读）：
 *  1. 前台 openPlaylistViewFast 绝不碰文件系统。命中就返回，不命中就明确说不命中，
 *     让 renderer 走原来的 scanSongList（**只起一个 worker**，别在这里再扫一遍）。
 *  2. 正确性由后台核对补齐：先算文件身份摘要（枚举 + stat），对得上就只更新核对时间，
 *     **一个 UI 动作都不做**；对不上才起 worker 重扫。
 *  3. 重扫完还要再比一次内容：真变了才推 'playlist:view-refreshed'。
 *     内容等价（只是 mtime 变了）时连 items_json 都不重写，更不推事件。
 *  4. 快照只服务"读 / 展示"。移动、删除、改标签、导出、云同步对账一律不许读它。
 */
export const PLAYLIST_VIEW_REFRESH_CHANNEL = 'playlist:view-refreshed'

/** 打开后延迟这么久再核对，先把首帧让给渲染。 */
const VERIFY_AFTER_OPEN_DELAY_MS = 400
/** 文件系统事件抖动窗口，与 libraryTreeWatcher 的 400ms 对齐。 */
const VERIFY_AFTER_WATCH_DELAY_MS = 600
/** 空闲轮转的间隔与每轮条数：宁可慢，别和用户抢磁盘。 */
const IDLE_VERIFY_INTERVAL_MS = 60_000
const IDLE_VERIFY_BATCH = 2
/** 核对通过的快照，超过这个时长才值得再核对一次。 */
const IDLE_VERIFY_MIN_AGE_MS = 6 * 60 * 60 * 1000
/** 从改动文件往上找歌单根的最大层数，防御性上限。 */
const ANCESTOR_WALK_MAX_DEPTH = 16
/** 分散核对一次最多 stat 这么多首，别让"滚动一屏"变成一次小重扫。 */
const MAX_DISTRIBUTED_VERIFY_FILES = 64

export type PlaylistFastOpenSource = 'snapshot' | 'miss'

export type PlaylistFastOpenResult = {
  hit: boolean
  source: PlaylistFastOpenSource
  songListUUID: string
  revision: number
  items: ISongInfo[]
  missingWaveformFilePaths: string[]
  tookMs: number
}

export type PlaylistViewRefreshPayload = {
  songListUUID: string
  revision: number
  items: ISongInfo[]
  missingWaveformFilePaths: string[]
  reason: 'verify-mismatch' | 'content-stale'
}

type VerificationRequest = {
  songListUUID: string
  listRootAbs: string
  reason: PlaylistViewRefreshPayload['reason']
}

const comparator = createSongListItemComparator({
  caseInsensitiveFileName: process.platform === 'win32'
})

const pendingTimers = new Map<string, NodeJS.Timeout>()
const pendingRequests = new Map<string, VerificationRequest>()
const runningUuids = new Set<string>()
const rerunUuids = new Set<string>()
let idleTimer: NodeJS.Timeout | null = null

const normalizeUuid = (value: unknown): string => String(value || '').trim()

const sameStringList = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * 前台打开：一次主键查询 + 一次 JSON.parse，零文件系统访问。
 * 命中后顺手排一次后台核对（延迟到首帧之后）。
 */
export function openPlaylistViewFast(input: {
  songListUUID: string
  songListPath?: string
}): PlaylistFastOpenResult {
  const startedAt = Date.now()
  const uuid = normalizeUuid(input?.songListUUID)
  const miss = (): PlaylistFastOpenResult => ({
    hit: false,
    source: 'miss',
    songListUUID: uuid,
    revision: 0,
    items: [],
    missingWaveformFilePaths: [],
    tookMs: Date.now() - startedAt
  })
  if (!uuid) return miss()

  const snapshot = loadPlaylistViewSnapshot(uuid)
  if (!snapshot) return miss()
  // itemCount 与 items 长度不一致说明这行写坏了，宁可当没命中重扫一次。
  if (snapshot.itemCount !== snapshot.items.length) return miss()

  const listRootAbs = resolveVerificationRoot(uuid, input?.songListPath, snapshot.listRoot)
  if (listRootAbs) {
    schedulePlaylistViewVerification({
      songListUUID: uuid,
      listRootAbs,
      reason: snapshot.verifiedAtMs > 0 ? 'verify-mismatch' : 'content-stale',
      delayMs: VERIFY_AFTER_OPEN_DELAY_MS
    })
  }

  return {
    hit: true,
    source: 'snapshot',
    songListUUID: uuid,
    revision: snapshot.revision,
    items: snapshot.items,
    missingWaveformFilePaths: snapshot.missingWaveformFilePaths,
    tookMs: Date.now() - startedAt
  }
}

/** renderer 给的路径优先（它一定是当前树里的真路径），否则从 list_root 反解。 */
function resolveVerificationRoot(
  songListUUID: string,
  songListPath: unknown,
  snapshotListRoot: string
): string {
  const fromRenderer = String(songListPath || '').trim()
  if (fromRenderer && path.isAbsolute(fromRenderer)) return fromRenderer
  if (fromRenderer) {
    const joined = path.join(store.databaseDir || '', fromRenderer)
    if (joined) return joined
  }
  const resolved = resolveCacheListRootAbs(snapshotListRoot)
  if (resolved) return resolved
  log.error('[playlist-snapshot] cannot resolve verification root', { songListUUID })
  return ''
}

/**
 * 扫描完成后落快照。只接受单目录扫描：多路径合并扫描没有唯一 list_root，
 * 存下去会让"按目录失效"整套机制失准。
 */
export function savePlaylistViewSnapshotFromScan(
  songListUUID: string,
  scanPath: string | string[],
  result: ScanSongListResult
): void {
  const uuid = normalizeUuid(songListUUID)
  if (!uuid || typeof scanPath !== 'string' || !scanPath) return
  if (!result || !Array.isArray(result.scanData)) return
  // 缓存身份没核对过（verify 模式失败）时别存，否则会把半份列表当成权威快照。
  if (result.cacheIdentityVerified === false) return
  savePlaylistViewSnapshot({
    songListUUID: uuid,
    listRoot: scanPath,
    identityDigest: String(result.identityDigest || ''),
    items: result.scanData,
    missingWaveformFilePaths: result.missingWaveformFilePaths || []
  })
}

/** 按 uuid 去抖 + 单飞。同一张歌单连着来十个事件，也只核对一次。 */
export function schedulePlaylistViewVerification(input: {
  songListUUID: string
  listRootAbs: string
  reason?: PlaylistViewRefreshPayload['reason']
  delayMs?: number
}): void {
  const uuid = normalizeUuid(input?.songListUUID)
  const listRootAbs = String(input?.listRootAbs || '').trim()
  if (!uuid || !listRootAbs) return

  pendingRequests.set(uuid, {
    songListUUID: uuid,
    listRootAbs,
    reason: input?.reason || 'verify-mismatch'
  })
  const existing = pendingTimers.get(uuid)
  if (existing) clearTimeout(existing)
  const delayMs = Math.max(0, Math.floor(input?.delayMs ?? VERIFY_AFTER_OPEN_DELAY_MS))
  const timer = setTimeout(() => {
    pendingTimers.delete(uuid)
    const request = pendingRequests.get(uuid)
    pendingRequests.delete(uuid)
    if (!request) return
    void runVerification(request)
  }, delayMs)
  if (typeof timer.unref === 'function') timer.unref()
  pendingTimers.set(uuid, timer)
}

async function runVerification(request: VerificationRequest): Promise<void> {
  const uuid = request.songListUUID
  if (runningUuids.has(uuid)) {
    // 正在核对时又来了事件：记一笔，本轮结束后补一次，不并发起两个 worker。
    rerunUuids.add(uuid)
    pendingRequests.set(uuid, request)
    return
  }
  runningUuids.add(uuid)
  try {
    await verifyOnce(request)
  } catch (error) {
    log.error('[playlist-snapshot] verify failed', {
      songListUUID: uuid,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    runningUuids.delete(uuid)
    if (rerunUuids.delete(uuid)) {
      const next = pendingRequests.get(uuid) || request
      pendingRequests.delete(uuid)
      schedulePlaylistViewVerification({ ...next, delayMs: VERIFY_AFTER_WATCH_DELAY_MS })
    }
  }
}

async function verifyOnce(request: VerificationRequest): Promise<void> {
  const { songListUUID, listRootAbs } = request
  const meta = loadPlaylistViewSnapshotMeta(songListUUID)
  if (!meta) return

  // verified_at_ms > 0：只做便宜的身份核对。对得上就纯粹更新时间戳，UI 一无所知。
  if (meta.verifiedAtMs > 0 && meta.identityDigest) {
    const digest = await computeCurrentIdentityDigest(listRootAbs)
    if (digest === null) return
    if (digest === meta.identityDigest) {
      touchPlaylistViewSnapshotVerified(songListUUID)
      return
    }
  }

  const previous = loadPlaylistViewSnapshot(songListUUID)
  const result = await scanSongListOffMainThread({
    scanPath: listRootAbs,
    audioExt: store.settingConfig.audioExt,
    songListUUID,
    databaseDir: store.databaseDir
  })
  if (!Array.isArray(result?.scanData)) return

  const nextMissing = result.missingWaveformFilePaths || []
  const merge = await planSongListMerge({
    current: previous?.items || [],
    next: result.scanData,
    comparator
  })
  const missingChanged = !sameStringList(previous?.missingWaveformFilePaths || [], nextMissing)

  if (!merge.changed && !missingChanged && previous) {
    // 文件被 touch 过但内容等价：只换身份摘要，别重写几 MB 的 items_json，也别推事件。
    touchPlaylistViewSnapshotIdentity(songListUUID, String(result.identityDigest || ''))
    return
  }

  const revision = savePlaylistViewSnapshot({
    songListUUID,
    listRoot: listRootAbs,
    identityDigest: String(result.identityDigest || ''),
    items: result.scanData,
    missingWaveformFilePaths: nextMissing
  })
  if (revision === null) return

  pushRefresh({
    songListUUID,
    revision,
    items: result.scanData,
    missingWaveformFilePaths: nextMissing,
    reason: request.reason
  })
}

async function computeCurrentIdentityDigest(listRootAbs: string): Promise<string | null> {
  try {
    // 复用扫描用的同一套枚举 + stat，摘要才和 scanSongs 算出来的可比。
    const scan = await listPlaylistAudioFilesWithStat(listRootAbs, store.settingConfig.audioExt)
    // 有条目枚举到了却拿不到 stat：这份列表不完整，宁可当"核对不了"去重扫，不能拿它下结论。
    if (scan.skipped > 0) return null
    return computePlaylistIdentityDigest(scan.files)
  } catch {
    return null
  }
}

function pushRefresh(payload: PlaylistViewRefreshPayload): void {
  const target = mainWindow.instance
  if (!target || target.isDestroyed()) return
  try {
    target.webContents.send(PLAYLIST_VIEW_REFRESH_CHANNEL, payload)
  } catch (error) {
    log.error('[playlist-snapshot] push refresh failed', error)
  }
}

/**
 * 文件系统事件入口：只知道改了哪些路径，得往上找到歌单根。
 * 这里**不**主动标脏，交给便宜的身份核对去判断——多余的事件只花一次枚举 + stat。
 */
export function invalidatePlaylistViewSnapshotsByPaths(changedAbsPaths: Iterable<string>): void {
  const databaseDir = String(store.databaseDir || '')
  if (!databaseDir) return
  const visitedDirs = new Set<string>()
  const scheduled = new Set<string>()

  for (const rawPath of changedAbsPaths) {
    const abs = String(rawPath || '').trim()
    if (!abs) continue
    let current = path.dirname(path.resolve(abs))
    for (let depth = 0; depth < ANCESTOR_WALK_MAX_DEPTH; depth += 1) {
      if (!current || visitedDirs.has(current)) break
      visitedDirs.add(current)
      for (const uuid of findPlaylistViewSnapshotUuidsByRoot(current)) {
        if (scheduled.has(uuid)) continue
        scheduled.add(uuid)
        schedulePlaylistViewVerification({
          songListUUID: uuid,
          listRootAbs: current,
          reason: 'content-stale',
          delayMs: VERIFY_AFTER_WATCH_DELAY_MS
        })
      }
      const parent = path.dirname(current)
      if (parent === current) break
      // 走到库根就停：再往上不可能是歌单。
      if (current.length <= databaseDir.length) break
      current = parent
    }
  }
}

/**
 * 分散核对（P3）：用户滚动到某几行、或选中/播放某一首时调它。
 *
 * 只针对传进来的那几首做 stat，和 song_cache 里记的 size / mtime 比。
 * 任一首对不上（或已经不在磁盘上）就排一次整单核对；全对得上就什么都不做。
 * 查不到缓存记录的行直接跳过——那说明 key 归一化对不上，不能当成"变了"。
 */
export async function verifyPlaylistViewTracks(input: {
  songListUUID: string
  songListPath?: string
  filePaths: readonly string[]
}): Promise<boolean> {
  const uuid = normalizeUuid(input?.songListUUID)
  const filePaths = (input?.filePaths || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, MAX_DISTRIBUTED_VERIFY_FILES)
  if (!uuid || filePaths.length === 0) return false
  if (runningUuids.has(uuid) || pendingTimers.has(uuid)) return false

  const meta = loadPlaylistViewSnapshotMeta(uuid)
  if (!meta) return false
  const listRootAbs = resolveVerificationRoot(uuid, input?.songListPath, meta.listRoot)
  if (!listRootAbs) return false

  const cachedStats = loadSongCacheFileStats(listRootAbs, filePaths)
  if (cachedStats.size === 0) return false

  let mismatched = false
  const tasks = filePaths.map((filePath) => async () => {
    // 键必须和 loadSongCacheFileStats 用同一个 normalizePath：win32 上缓存 key 是小写，
    // 直接拿 path.resolve 的原始大小写查会全部查不到，分散核对就永远不会升级。
    const cached = cachedStats.get(normalizePath(filePath))
    if (!cached) return
    try {
      const st = await fs.stat(filePath)
      // 容差和 scanSongs / waveformSurfaceCache 一致（≥1ms 才算变了）：song_cache 里的
      // mtime 可能是原生 find-data 写的，和这里 fs.stat 拿到的值允许有亚毫秒差。
      if (st.size !== cached.size || Math.abs(st.mtimeMs - cached.mtimeMs) >= 1) mismatched = true
    } catch {
      mismatched = true
    }
  })
  await runWithConcurrency(tasks, { concurrency: PLAYLIST_STAT_CONCURRENCY })
  if (!mismatched) return false

  schedulePlaylistViewVerification({
    songListUUID: uuid,
    listRootAbs,
    reason: 'content-stale',
    delayMs: VERIFY_AFTER_WATCH_DELAY_MS
  })
  return true
}

/**
 * 空闲轮转核对：优先补 verified_at_ms = 0 的哨兵行，然后按最久没核对的顺序慢慢过。
 * 每轮只取两条，且已核对过的要超过 6 小时才再看一次。
 */
export function startPlaylistViewSnapshotIdleVerification(): void {
  if (idleTimer) return
  const tick = () => {
    try {
      const candidates = listPlaylistViewSnapshotVerificationCandidates(IDLE_VERIFY_BATCH)
      const now = Date.now()
      for (const meta of candidates) {
        if (meta.verifiedAtMs > 0 && now - meta.verifiedAtMs < IDLE_VERIFY_MIN_AGE_MS) continue
        if (runningUuids.has(meta.songListUUID) || pendingTimers.has(meta.songListUUID)) continue
        const listRootAbs = resolveCacheListRootAbs(meta.listRoot)
        if (!listRootAbs) continue
        schedulePlaylistViewVerification({
          songListUUID: meta.songListUUID,
          listRootAbs,
          reason: meta.verifiedAtMs > 0 ? 'verify-mismatch' : 'content-stale',
          delayMs: 0
        })
      }
    } catch (error) {
      log.error('[playlist-snapshot] idle verification tick failed', error)
    }
  }
  idleTimer = setInterval(tick, IDLE_VERIFY_INTERVAL_MS)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

export function stopPlaylistViewSnapshotIdleVerification(): void {
  if (idleTimer) {
    clearInterval(idleTimer)
    idleTimer = null
  }
  for (const timer of pendingTimers.values()) clearTimeout(timer)
  pendingTimers.clear()
  pendingRequests.clear()
  rerunUuids.clear()
}
