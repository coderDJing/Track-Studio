import { log } from '../log'

/**
 * 打开歌单的耗时观测。
 *
 * 快照层把"打开歌单"从"扫盘 + 核对"压成了"读一行 + JSON.parse"。一旦哪天又慢回去
 * （快照总是不命中、退化成整单重扫），没有观测点就只能靠体感猜。所以这里只留两样东西：
 *
 *  1. **内存计数器**：各档命中/未命中次数、最慢一次耗时、未命中原因分布。
 *     不落盘，只在"响应性诊断"快照（主进程卡顿时才会打印）里顺带带出。
 *  2. **阈值日志**：单次打开链路耗时 ≥ SLOW_PLAYLIST_OPEN_LOG_THRESHOLD_MS 才写一行 warn。
 *     正常情况（快照命中，个位数毫秒）一行都不写。
 *
 * 字段含义：
 *  - `source`：谁服务了这次打开。`snapshot` = 视图快照（零 fs）；
 *    `cache-verify` = 缓存身份核对快路径；`full-scan` = 整单重扫。
 *  - `hit`：该档是否命中（`full-scan` 恒为 true，它是兜底档）。
 *  - `itemCount`：这次返回的行数，用来判断"慢"是否与歌单规模相关。
 *  - `tookMs`：该档自身耗时（不含 renderer 渲染）。
 *  - `reason`：未命中原因或补充说明，用于定位"为什么没走快路径"。
 *
 * 清理条件：快照命中率长期稳定（> 95%）且不再出现 slow open 记录后，
 * 本模块可整体删除——调用点只有三处 `recordPlaylistOpenPath` 加一处诊断快照引用。
 */
export type PlaylistOpenSource = 'snapshot' | 'cache-verify' | 'full-scan'

/** 超过这个耗时才写日志。快照命中通常个位数毫秒，整单重扫大歌单才可能触发。 */
const SLOW_PLAYLIST_OPEN_LOG_THRESHOLD_MS = 800
/** 原因分布只留最常见的几种，防止被"每张歌单一个原因"撑爆。 */
const MAX_TRACKED_REASONS = 12

type PlaylistOpenSourceCounter = {
  hit: number
  miss: number
  slow: number
  maxMs: number
}

export type PlaylistOpenPathRecord = {
  source: PlaylistOpenSource
  hit: boolean
  tookMs: number
  itemCount?: number
  reason?: string
  songListUUID?: string
  /** 扫描链路的细分耗时，直接透传 ScanSongListResult.perf 里挑出来的几项。 */
  details?: Record<string, unknown>
}

const counters = new Map<PlaylistOpenSource, PlaylistOpenSourceCounter>()
const missReasons = new Map<string, number>()

const getCounter = (source: PlaylistOpenSource): PlaylistOpenSourceCounter => {
  const existing = counters.get(source)
  if (existing) return existing
  const created: PlaylistOpenSourceCounter = { hit: 0, miss: 0, slow: 0, maxMs: 0 }
  counters.set(source, created)
  return created
}

const rememberMissReason = (reason: string) => {
  const key = reason.trim()
  if (!key) return
  if (!missReasons.has(key) && missReasons.size >= MAX_TRACKED_REASONS) return
  missReasons.set(key, (missReasons.get(key) || 0) + 1)
}

export function recordPlaylistOpenPath(record: PlaylistOpenPathRecord): void {
  const tookMs = Number.isFinite(record.tookMs) ? Math.max(0, Math.round(record.tookMs)) : 0
  const counter = getCounter(record.source)
  if (record.hit) counter.hit += 1
  else counter.miss += 1
  if (tookMs > counter.maxMs) counter.maxMs = tookMs
  if (!record.hit) rememberMissReason(record.reason || 'unknown')
  if (tookMs < SLOW_PLAYLIST_OPEN_LOG_THRESHOLD_MS) return
  counter.slow += 1
  log.warn('[playlist-open-perf] slow open', {
    source: record.source,
    hit: record.hit,
    tookMs,
    thresholdMs: SLOW_PLAYLIST_OPEN_LOG_THRESHOLD_MS,
    itemCount: Number.isFinite(record.itemCount) ? record.itemCount : undefined,
    reason: record.reason,
    songListUUID: record.songListUUID,
    ...(record.details || {})
  })
}

/** 供响应性诊断顺带打印；平时没人读，也不落盘。 */
export function getPlaylistOpenPerfSnapshot() {
  const bySource: Record<string, PlaylistOpenSourceCounter & { hitRate: number }> = {}
  for (const [source, counter] of counters) {
    const total = counter.hit + counter.miss
    bySource[source] = {
      ...counter,
      hitRate: total > 0 ? Math.round((counter.hit / total) * 100) / 100 : 0
    }
  }
  return {
    bySource,
    missReasons: Object.fromEntries(missReasons)
  }
}
