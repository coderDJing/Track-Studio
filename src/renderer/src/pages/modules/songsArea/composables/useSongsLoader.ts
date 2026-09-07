import { ref, nextTick, markRaw, onUnmounted, watch } from 'vue'
import type { ShallowRef } from 'vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import { mapMixtapeSnapshotToSongInfo } from '@renderer/composables/mixtape/mixtapeSnapshotSongMapper'
import type { ISongInfo } from '../../../../../../types/globals'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import { t } from '@renderer/utils/translate'
import { createSongListItemComparator } from '@shared/songListItemCompare'
import { planSongListMerge } from '@shared/playlistViewMerge'
import {
  createSongListLoadGenerationGuard,
  type SongListLoadTicket
} from './songListLoadGeneration'

interface UseSongsLoaderParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  applyFiltersAndSorting: () => void | Promise<void>
}

interface LoadSongListFromDiskOptions {
  forceNotifySongSearchDirty?: boolean
  diagnosticSource?: string
}

export interface OpenSongListOptions {
  waitForFreshAnalysisFields?: boolean
}

interface SongListDiffSummary {
  hasIgnoredOnlyDiffs: boolean
  hasMeaningfulDiffs: boolean
}

type SongListScanResult = {
  scanData?: ISongInfo[]
  songListUUID?: string
  missingWaveformFilePaths?: unknown
  playlistTrackNumbering?: {
    initialized?: boolean
    repaired?: boolean
  } | null
}

type PlaylistFastOpenPayload = {
  hit?: boolean
  source?: string
  songListUUID?: string
  revision?: number
  items?: unknown
  missingWaveformFilePaths?: unknown
}

type PlaylistViewRefreshPayload = {
  songListUUID?: string
  revision?: number
  items?: unknown
  missingWaveformFilePaths?: unknown
  reason?: string
}

let songListScanDiagnosticSequence = 0

const createSongListScanTraceId = () => {
  songListScanDiagnosticSequence += 1
  return `renderer-${Date.now().toString(36)}-${songListScanDiagnosticSequence.toString(36)}`
}

const writeSongListScanError = (message: string, details: Record<string, unknown>) => {
  try {
    window.electron.ipcRenderer.send('outputLog', {
      level: 'error',
      source: 'renderer',
      scope: 'playlist-scan-diagnostic',
      message: `${message} ${JSON.stringify(details)}`
    })
  } catch {}
}

/**
 * 打开歌单的端到端耗时（IPC + 落地 + 首屏）观测。
 *
 * 触发条件：单次打开 ≥ SLOW_SONG_LIST_OPEN_LOG_THRESHOLD_MS 才写一行 warn；
 * 走快照命中时通常是几十毫秒，正常使用一行都不会写。
 * 字段：source = 哪一档服务了这次打开（snapshot / cache-verify / full-scan）；
 * tookMs = 从 openSongList 进入到列表落地；itemCount = 行数。
 * 清理条件：确认线上不再出现这条记录后，可以连同 openStartedAtMs 一起删掉。
 */
const SLOW_SONG_LIST_OPEN_LOG_THRESHOLD_MS = 1200

const writeSongListOpenPerf = (details: {
  source: string
  tookMs: number
  itemCount: number
  songListUUID: string
}) => {
  if (details.tookMs < SLOW_SONG_LIST_OPEN_LOG_THRESHOLD_MS) return
  try {
    window.electron.ipcRenderer.send('outputLog', {
      level: 'warn',
      source: 'renderer',
      scope: 'playlist-open-perf',
      message: `slow open ${JSON.stringify({
        ...details,
        thresholdMs: SLOW_SONG_LIST_OPEN_LOG_THRESHOLD_MS
      })}`
    })
  } catch {}
}

export function useSongsLoader(params: UseSongsLoaderParams) {
  const { runtime, songsAreaState, originalSongInfoArr, applyFiltersAndSorting } = params

  const loadingShow = ref(false)
  const isRequesting = ref<boolean>(false)
  const loadGenerationGuard = createSongListLoadGenerationGuard(() => songsAreaState.songListUUID)
  const hydrateFromPaneSnapshot = () => {
    if (originalSongInfoArr.value.length > 0) return false
    if (!songsAreaState.songListUUID || songsAreaState.songInfoArr.length === 0) return false
    originalSongInfoArr.value = markRaw([...songsAreaState.songInfoArr])
    return true
  }
  const lastAppliedSongListUUID = ref(hydrateFromPaneSnapshot() ? songsAreaState.songListUUID : '')
  const playlistTrackNumberTipStorageKey = 'playlistTrackNumberInitHintShown'
  const markSongListApplied = (songListUUID: string) => {
    lastAppliedSongListUUID.value = songListUUID
  }
  const settleSongListRequest = (ticket: SongListLoadTicket) => {
    if (!loadGenerationGuard.isCurrent(ticket)) return
    isRequesting.value = false
    loadingShow.value = false
    if (lastAppliedSongListUUID.value === ticket.songListUUID) return
    // 请求结束时如果可见列表已经清空，才把 UUID 标成落地（失败时结束转圈）。
    // 列表里还留着上一份歌单时绝不能标，否则会把旧内容当成新歌单画出来。
    if (songsAreaState.songInfoArr.length === 0 && originalSongInfoArr.value.length === 0) {
      markSongListApplied(ticket.songListUUID)
    }
  }

  // 超过这个时间还没落地才亮转圈。快照命中通常远小于它，避免外层 out-in 整页闪一下。
  const SONG_LIST_LOADING_DELAY_MS = 200
  const beginDelayedLoadingShow = (ticket: SongListLoadTicket) => {
    loadingShow.value = false
    const timer = window.setTimeout(() => {
      if (loadGenerationGuard.isCurrent(ticket)) loadingShow.value = true
    }, SONG_LIST_LOADING_DELAY_MS)
    // 返回的函数必须连已亮起的转圈一起收掉：只 clearTimeout 的话，定时器刚好在首屏
    // 渲染前一帧触发时，转圈会一直亮到请求收尾，把已经画好的列表又盖回去。
    return () => {
      window.clearTimeout(timer)
      if (loadGenerationGuard.isCurrent(ticket)) loadingShow.value = false
    }
  }

  // 渐进式渲染（当前行数）
  const renderCount = ref(0)

  const isMixtapeListUUID = (songListUUID: string) =>
    libraryUtils.getLibraryTreeByUUID(songListUUID)?.type === 'mixtapeList'
  const isSetListUUID = (songListUUID: string) =>
    libraryUtils.getLibraryTreeByUUID(songListUUID)?.type === 'setList'
  // 行等价判定必须和主进程用同一套规则（@shared/songListItemCompare），
  // 否则后台核对认为"变了"、renderer 认为"没变"，就会出现反复推空补丁或漏刷新。
  const comparator = createSongListItemComparator({
    caseInsensitiveFileName: (runtime.setting.platform || runtime.platform) === 'win32'
  })
  const {
    getSongIdentityKey,
    normalizeSongPath,
    normalizeComparableText,
    isEquivalentSongInfo,
    getSongInfoDiffFields,
    hasMeaningfulDiffField
  } = comparator

  const normalizeMissingWaveformFilePaths = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const pathsByKey = new Map<string, string>()
    for (const item of value) {
      const filePath = typeof item === 'string' ? item.trim() : ''
      const key = normalizeSongPath(filePath)
      if (!filePath || !key || pathsByKey.has(key)) continue
      pathsByKey.set(key, filePath)
    }
    return [...pathsByKey.values()]
  }
  const SONG_LIST_COMPARISON_YIELD_EVERY = 160

  const yieldToRenderer = () =>
    new Promise<void>((resolve) => {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve())
        return
      }
      setTimeout(resolve, 0)
    })

  const yieldAfterSongListItems = async (index: number, total: number) => {
    if (total < SONG_LIST_COMPARISON_YIELD_EVERY * 2) return
    if (index > 0 && index % SONG_LIST_COMPARISON_YIELD_EVERY === 0) {
      await yieldToRenderer()
    }
  }

  const notifySongSearchDirty = (reason: string, songListUUID?: string) => {
    void window.electron.ipcRenderer
      .invoke('song-search:mark-dirty', { reason, songListUUID })
      .catch(() => {})
  }

  const invalidatePendingSongListLoads = () => {
    loadGenerationGuard.invalidate()
    isRequesting.value = false
    loadingShow.value = false
    if (!songsAreaState.songListUUID) {
      lastAppliedSongListUUID.value = ''
    }
  }

  const maybeShowPlaylistTrackNumberInitHint = (
    songListUUID: string,
    payload?: { initialized?: boolean } | null
  ) => {
    if (!payload?.initialized || !songListUUID) return
    try {
      const raw = localStorage.getItem(playlistTrackNumberTipStorageKey)
      const parsed = raw ? JSON.parse(raw) : {}
      const shownMap =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, boolean>)
          : {}
      if (shownMap[songListUUID]) return
      shownMap[songListUUID] = true
      localStorage.setItem(playlistTrackNumberTipStorageKey, JSON.stringify(shownMap))
    } catch {}
    try {
      emitter.emit('songsArea/clipboardHint', {
        message: t('tracks.playlistTrackNumbersInitializedHint')
      })
    } catch {}
  }

  const hydrateRenderCount = async (ticket?: SongListLoadTicket) => {
    const isCurrent = () => !ticket || loadGenerationGuard.isCurrent(ticket)
    if (!isCurrent()) return
    const totalRows = songsAreaState.songInfoArr.length
    const INITIAL_ROWS = 40
    const CHUNK_ROWS = 80
    renderCount.value = Math.min(totalRows, INITIAL_ROWS)
    await nextTick()
    if (!isCurrent()) return
    ;(() => {
      const step = () => {
        if (!isCurrent()) return
        if (renderCount.value >= totalRows) return
        renderCount.value = Math.min(renderCount.value + CHUNK_ROWS, totalRows)
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })()
    await nextTick()
    if (!isCurrent()) return
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  }

  const syncSelectedKeysAfterReload = (scanData: ISongInfo[], songListUUID: string) => {
    const currentSelection = songsAreaState.selectedSongFilePath.filter(Boolean)
    if (!currentSelection.length) return

    if (isMixtapeListUUID(songListUUID)) {
      const validIds = new Set(
        scanData
          .map((song) => song.mixtapeItemId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
      songsAreaState.selectedSongFilePath = currentSelection.filter((key) => validIds.has(key))
      return
    }
    if (isSetListUUID(songListUUID)) {
      const validIds = new Set(
        scanData
          .map((song) => song.setItemId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
      songsAreaState.selectedSongFilePath = currentSelection.filter((key) => validIds.has(key))
      return
    }

    const filePathMap = new Map<string, string>()
    for (const song of scanData) {
      const filePath = song.filePath
      if (!filePath) continue
      filePathMap.set(normalizeSongPath(filePath), filePath)
    }

    const nextSelection: string[] = []
    const seen = new Set<string>()
    for (const key of currentSelection) {
      const nextKey = filePathMap.get(normalizeSongPath(key))
      if (!nextKey || seen.has(nextKey)) continue
      seen.add(nextKey)
      nextSelection.push(nextKey)
    }
    songsAreaState.selectedSongFilePath = nextSelection
  }

  const syncPlayingStateAfterReload = (scanData: ISongInfo[], songListUUID: string) => {
    if (runtime.playingData.playingSongListUUID !== songListUUID) return

    runtime.playingData.playingSongListData = songsAreaState.songInfoArr

    const currentPlayingSong = runtime.playingData.playingSong
    if (!currentPlayingSong) return

    const playingMixtapeItemId = normalizeComparableText(currentPlayingSong.mixtapeItemId)
    const playingSetItemId = normalizeComparableText(currentPlayingSong.setItemId)
    const normalizedPlayingPath = normalizeSongPath(currentPlayingSong.filePath)
    const songCandidates =
      songsAreaState.songInfoArr.length > 0 ? songsAreaState.songInfoArr : scanData

    const matchedSong = songCandidates.find((song) => {
      const songMixtapeItemId = normalizeComparableText(song.mixtapeItemId)
      if (playingMixtapeItemId && songMixtapeItemId) {
        return songMixtapeItemId === playingMixtapeItemId
      }
      const songSetItemId = normalizeComparableText(song.setItemId)
      if (playingSetItemId && songSetItemId) {
        return songSetItemId === playingSetItemId
      }
      return (
        normalizedPlayingPath !== '' && normalizeSongPath(song.filePath) === normalizedPlayingPath
      )
    })

    if (!matchedSong) return

    runtime.playingData.playingSong = {
      ...currentPlayingSong,
      ...matchedSong
    }
  }

  const isEquivalentSongListSnapshot = async (nextData: ISongInfo[], currentData: ISongInfo[]) => {
    if (nextData.length !== currentData.length) return false
    if (nextData.length === 0) return true

    const currentByKey = new Map<string, ISongInfo>()
    for (const [index, song] of currentData.entries()) {
      const key = getSongIdentityKey(song)
      if (!key || currentByKey.has(key)) return false
      currentByKey.set(key, song)
      await yieldAfterSongListItems(index + 1, currentData.length)
    }

    let matchedCount = 0
    for (const [index, song] of nextData.entries()) {
      const key = getSongIdentityKey(song)
      if (!key) return false
      const current = currentByKey.get(key)
      if (!current || !isEquivalentSongInfo(song, current)) return false
      matchedCount += 1
      await yieldAfterSongListItems(index + 1, nextData.length)
    }

    return matchedCount === currentByKey.size
  }

  const summarizeSongListDiff = async (
    nextData: ISongInfo[],
    currentData: ISongInfo[]
  ): Promise<SongListDiffSummary> => {
    let hasMeaningfulDiffs = false
    let hasIgnoredOnlyDiffs = false

    if (nextData.length !== currentData.length) {
      return {
        hasIgnoredOnlyDiffs: false,
        hasMeaningfulDiffs: true
      }
    }

    const currentByKey = new Map<string, ISongInfo>()
    for (const [index, song] of currentData.entries()) {
      const key = getSongIdentityKey(song)
      if (!key || currentByKey.has(key)) {
        return {
          hasIgnoredOnlyDiffs: false,
          hasMeaningfulDiffs: true
        }
      }
      currentByKey.set(key, song)
      await yieldAfterSongListItems(index + 1, currentData.length)
    }

    for (const [index, song] of nextData.entries()) {
      const key = getSongIdentityKey(song)
      const current = key ? currentByKey.get(key) : undefined
      const fields = !key || !current ? ['__missing__'] : getSongInfoDiffFields(song, current)
      if (!fields.length) continue

      const hasNonIgnoredField = hasMeaningfulDiffField(fields)
      if (hasNonIgnoredField) {
        hasMeaningfulDiffs = true
      } else {
        hasIgnoredOnlyDiffs = true
      }
      await yieldAfterSongListItems(index + 1, nextData.length)
    }

    return {
      hasIgnoredOnlyDiffs,
      hasMeaningfulDiffs
    }
  }

  const applySongListData = async (scanData: ISongInfo[], ticket: SongListLoadTicket) => {
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    originalSongInfoArr.value = markRaw(scanData)
    applyFiltersAndSorting()
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    syncSelectedKeysAfterReload(scanData, ticket.songListUUID)
    syncPlayingStateAfterReload(scanData, ticket.songListUUID)
    markSongListApplied(ticket.songListUUID)
    try {
      emitter.emit('playlistContentChanged', { uuids: [ticket.songListUUID] })
    } catch {}
    await hydrateRenderCount(ticket)
    return loadGenerationGuard.isCurrent(ticket)
  }

  // ── 后台刷新（快照核对推过来的补丁）────────────────────────────────────
  // 红线：后台核对/重扫绝不能让用户看见"列表退出重进"或闪动。因此这里：
  //  1. 不碰 loadingShow，也不重跑 hydrateRenderCount（渐进渲染只属于前台首次打开）；
  //  2. 等价的行复用旧对象引用（planSongListMerge 负责），Vue 的 keyed diff 不会重建行；
  //  3. 内容完全没变化时**一个动作都不做**，连赋值都不做；
  //  4. 连着来的多个事件只保留最后一份，且同一时刻只处理一份。
  const appliedViewRevision = { songListUUID: '', revision: 0 }
  let pendingViewRefresh: PlaylistViewRefreshPayload | null = null
  let viewRefreshRunning = false

  const normalizeViewRevision = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

  const rememberAppliedViewRevision = (songListUUID: string, revision: unknown) => {
    appliedViewRevision.songListUUID = songListUUID
    appliedViewRevision.revision = normalizeViewRevision(revision)
  }

  const sameStringList = (left: readonly string[], right: readonly string[]) => {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false
    }
    return true
  }

  const applyViewRefreshPayload = async (payload: PlaylistViewRefreshPayload) => {
    const songListUUID = String(payload.songListUUID || '')
    const nextItems = Array.isArray(payload.items) ? (payload.items as ISongInfo[]) : []
    const nextMissing = normalizeMissingWaveformFilePaths(payload.missingWaveformFilePaths)

    // 合并期间前台可能刚落地了另一份列表，那份基线才是对的：最多重算三次。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (songListUUID !== songsAreaState.songListUUID) return
      const baseline = originalSongInfoArr.value
      const merge = await planSongListMerge({
        current: baseline,
        next: nextItems,
        comparator,
        onYield: yieldAfterSongListItems
      })
      if (originalSongInfoArr.value !== baseline) continue
      if (songListUUID !== songsAreaState.songListUUID) return

      rememberAppliedViewRevision(songListUUID, payload.revision)
      if (!sameStringList(songsAreaState.missingWaveformFilePaths, nextMissing)) {
        songsAreaState.missingWaveformFilePaths = nextMissing
      }
      if (!merge.changed) return

      resetDistributedVerifyCursor(songListUUID)
      originalSongInfoArr.value = markRaw(merge.items)
      applyFiltersAndSorting()
      syncSelectedKeysAfterReload(merge.items, songListUUID)
      syncPlayingStateAfterReload(merge.items, songListUUID)
      // 只有增删才影响歌单曲目数与搜歌索引；纯字段刷新不必惊动别人。
      if (merge.addedCount > 0 || merge.removedCount > 0) {
        try {
          emitter.emit('playlistContentChanged', { uuids: [songListUUID] })
        } catch {}
        notifySongSearchDirty('playlist-view-refresh', songListUUID)
      }
      return
    }
  }

  const drainViewRefreshQueue = async () => {
    if (viewRefreshRunning) return
    viewRefreshRunning = true
    try {
      while (pendingViewRefresh) {
        const payload = pendingViewRefresh
        pendingViewRefresh = null
        await applyViewRefreshPayload(payload)
      }
    } finally {
      viewRefreshRunning = false
    }
  }

  const handlePlaylistViewRefreshed = (_event: unknown, rawPayload: unknown) => {
    const payload = (rawPayload || {}) as PlaylistViewRefreshPayload
    const songListUUID = String(payload.songListUUID || '')
    if (!songListUUID || songListUUID !== songsAreaState.songListUUID) return
    // 可见列表还不是这张歌单（前台正在打开）时不插队：前台那份结果本身就是最新快照。
    if (lastAppliedSongListUUID.value !== songListUUID) return
    const revision = normalizeViewRevision(payload.revision)
    if (
      revision > 0 &&
      appliedViewRevision.songListUUID === songListUUID &&
      revision <= appliedViewRevision.revision
    ) {
      return
    }
    pendingViewRefresh = payload
    void drainViewRefreshQueue()
  }

  const disposeViewRefreshListener = window.electron.ipcRenderer.on(
    'playlist:view-refreshed',
    handlePlaylistViewRefreshed
  )

  // ── 分散核对：用户正在看 / 选 / 放的那几行，顺手核对一下 ────────────────────
  // 只把文件路径交给主进程，它 stat 这几首并与 song_cache 里的 size/mtime 比；
  // 对不上才排一次整单核对。每个路径只查一次（换歌单或列表被刷新后重置），
  // 所以来回滚动不会变成反复 stat。
  const DISTRIBUTED_VERIFY_THROTTLE_MS = 1500
  const DISTRIBUTED_VERIFY_MAX_FILES = 64
  /** 估算可见窗口用的行高，与 useVirtualRows 的默认值一致；只用于取样，不需要精确。 */
  const DISTRIBUTED_VERIFY_ROW_HEIGHT = 30
  const verifiedTrackKeys = new Set<string>()
  const pendingVerifyFilePaths = new Set<string>()
  let verifiedTrackKeysUUID = ''
  let distributedVerifyTimer: ReturnType<typeof setTimeout> | null = null

  const resetDistributedVerifyCursor = (songListUUID: string) => {
    verifiedTrackKeysUUID = songListUUID
    verifiedTrackKeys.clear()
    pendingVerifyFilePaths.clear()
  }

  /** 只有"目录即歌单"的普通歌单才有视图快照；回收站/录音库/混音带/set 一律不参与。 */
  const supportsDistributedVerify = (songListUUID: string) => {
    if (!songListUUID) return false
    if (
      songListUUID === EXTERNAL_PLAYLIST_UUID ||
      songListUUID === RECYCLE_BIN_UUID ||
      songListUUID === RECORDING_LIBRARY_UUID
    ) {
      return false
    }
    return !isMixtapeListUUID(songListUUID) && !isSetListUUID(songListUUID)
  }

  const flushDistributedVerify = () => {
    distributedVerifyTimer = null
    const songListUUID = songsAreaState.songListUUID
    if (!supportsDistributedVerify(songListUUID) || verifiedTrackKeysUUID !== songListUUID) {
      pendingVerifyFilePaths.clear()
      return
    }
    const filePaths = [...pendingVerifyFilePaths]
    pendingVerifyFilePaths.clear()
    if (!filePaths.length) return
    void window.electron.ipcRenderer
      .invoke('playlist:verify-tracks', {
        songListUUID,
        songListPath: libraryUtils.findDirPathByUuid(songListUUID),
        filePaths
      })
      .catch(() => {})
  }

  const queueDistributedVerify = (filePaths: readonly (string | undefined)[]) => {
    const songListUUID = songsAreaState.songListUUID
    if (!supportsDistributedVerify(songListUUID)) return
    // 前台还在打开这张歌单时不掺和：那条路自己就会把最新内容取回来。
    if (isRequesting.value || lastAppliedSongListUUID.value !== songListUUID) return
    if (verifiedTrackKeysUUID !== songListUUID) resetDistributedVerifyCursor(songListUUID)
    for (const rawPath of filePaths) {
      if (pendingVerifyFilePaths.size >= DISTRIBUTED_VERIFY_MAX_FILES) break
      const filePath = String(rawPath || '').trim()
      const key = normalizeSongPath(filePath)
      if (!filePath || !key || verifiedTrackKeys.has(key)) continue
      verifiedTrackKeys.add(key)
      pendingVerifyFilePaths.add(filePath)
    }
    if (!pendingVerifyFilePaths.size || distributedVerifyTimer) return
    distributedVerifyTimer = setTimeout(flushDistributedVerify, DISTRIBUTED_VERIFY_THROTTLE_MS)
  }

  const queueVisibleRowVerify = () => {
    const rows = songsAreaState.songInfoArr
    if (!rows.length) return
    const scrollTop = Math.max(0, Number(songsAreaState.scrollTop || 0))
    const start = Math.min(
      rows.length - 1,
      Math.max(0, Math.floor(scrollTop / DISTRIBUTED_VERIFY_ROW_HEIGHT))
    )
    queueDistributedVerify(
      rows.slice(start, start + DISTRIBUTED_VERIFY_MAX_FILES).map((song) => song.filePath)
    )
  }

  watch(
    () => songsAreaState.songListUUID,
    (songListUUID) => resetDistributedVerifyCursor(songListUUID)
  )
  watch(
    () => songsAreaState.scrollTop,
    () => queueVisibleRowVerify()
  )
  watch(
    () => songsAreaState.selectedSongFilePath.join('|'),
    () => queueDistributedVerify(songsAreaState.selectedSongFilePath)
  )
  watch(
    () => runtime.playingData.playingSong?.filePath || '',
    (filePath) => {
      if (runtime.playingData.playingSongListUUID !== songsAreaState.songListUUID) return
      queueDistributedVerify([filePath])
    }
  )

  onUnmounted(() => {
    disposeViewRefreshListener?.()
    pendingViewRefresh = null
    if (distributedVerifyTimer) {
      clearTimeout(distributedVerifyTimer)
      distributedVerifyTimer = null
    }
  })

  const loadSongListFromDisk = async (
    songListPath: string,
    ticket: SongListLoadTicket,
    options?: LoadSongListFromDiskOptions
  ) => {
    const traceId = createSongListScanTraceId()
    const diagnosticSource = options?.diagnosticSource || 'disk-load'
    const rendererStartedAtMs = Date.now()
    let result: SongListScanResult
    try {
      result = (await window.electron.ipcRenderer.invoke(
        'scanSongList',
        songListPath,
        ticket.songListUUID,
        {
          traceId,
          source: diagnosticSource
        }
      )) as SongListScanResult
    } catch (error) {
      writeSongListScanError('request failed', {
        traceId,
        diagnosticSource,
        songListUUID: ticket.songListUUID,
        rendererDurationMs: Date.now() - rendererStartedAtMs,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    const scanData = Array.isArray(result?.scanData) ? result.scanData : []
    const loadedUUID = String(result?.songListUUID || '')
    if (loadedUUID !== ticket.songListUUID) return false
    songsAreaState.missingWaveformFilePaths = normalizeMissingWaveformFilePaths(
      result?.missingWaveformFilePaths
    )
    maybeShowPlaylistTrackNumberInitHint(loadedUUID, result?.playlistTrackNumbering || null)
    const unchanged = await isEquivalentSongListSnapshot(scanData, originalSongInfoArr.value)
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    if (unchanged) {
      markSongListApplied(loadedUUID)
      if (options?.forceNotifySongSearchDirty) {
        notifySongSearchDirty('scanSongList', loadedUUID)
      }
      return true
    }
    const diffSummary = await summarizeSongListDiff(scanData, originalSongInfoArr.value)
    if (!loadGenerationGuard.isCurrent(ticket)) return false
    if (!diffSummary.hasMeaningfulDiffs && diffSummary.hasIgnoredOnlyDiffs) {
      if (!(await applySongListData(scanData, ticket))) return false
      markSongListApplied(loadedUUID)
      notifySongSearchDirty('scanSongList-analysis-fields', loadedUUID)
      if (options?.forceNotifySongSearchDirty) {
        notifySongSearchDirty('scanSongList', loadedUUID)
      }
      return true
    }
    if (!(await applySongListData(scanData, ticket))) return false
    notifySongSearchDirty('scanSongList', loadedUUID)
    return true
  }

  const openSongList = async (options: OpenSongListOptions = {}) => {
    const requestUUID = songsAreaState.songListUUID
    const ticket = loadGenerationGuard.begin(requestUUID)
    const wasAlreadyApplied = lastAppliedSongListUUID.value === requestUUID
    const openStartedAtMs = Date.now()
    isRequesting.value = true
    loadingShow.value = false
    // 切到另一张歌单时不要丢掉已落地的列表。pending 期间由 leaveData 顶着旧内容。
    // loading 必须等超过延迟才亮：快照命中只需几十毫秒，立刻切到 loading
    // 会走外层 out-in 动画，整页闪一下。

    if (requestUUID === EXTERNAL_PLAYLIST_UUID) {
      const songs = runtime.externalPlaylist.songs || []
      songsAreaState.missingWaveformFilePaths = []
      originalSongInfoArr.value = markRaw([...songs])
      applyFiltersAndSorting()
      syncSelectedKeysAfterReload(songsAreaState.songInfoArr, requestUUID)
      syncPlayingStateAfterReload(songsAreaState.songInfoArr, requestUUID)
      markSongListApplied(requestUUID)
      settleSongListRequest(ticket)
      return
    }

    const cancelDelayedLoadingShow = beginDelayedLoadingShow(ticket)
    const maybeLoadFreshAnalysis = async (songListPath: string) => {
      if (options.waitForFreshAnalysisFields !== true || wasAlreadyApplied) return
      // 快照已先落地，结束“打开请求”本身，再做一次用户明确要求的新鲜分析字段核对。
      // 这样这次较慢的核对不会重新亮 loading，也不会阻塞首屏快照。
      settleSongListRequest(ticket)
      await loadSongListFromDisk(songListPath, ticket, {
        diagnosticSource: 'fresh-analysis'
      })
    }
    try {
      if (requestUUID === RECYCLE_BIN_UUID) {
        songsAreaState.missingWaveformFilePaths = []
        const { scanData, songListUUID } =
          await window.electron.ipcRenderer.invoke('recycleBin:list')
        if (!loadGenerationGuard.isCurrent(ticket) || songListUUID !== requestUUID) return
        originalSongInfoArr.value = markRaw(scanData)
        applyFiltersAndSorting()
        syncSelectedKeysAfterReload(scanData, songListUUID)
        syncPlayingStateAfterReload(scanData, songListUUID)
        markSongListApplied(songListUUID)
        return
      }
      if (requestUUID === RECORDING_LIBRARY_UUID) {
        songsAreaState.missingWaveformFilePaths = []
        const { scanData, songListUUID } =
          await window.electron.ipcRenderer.invoke('recordingLibrary:list')
        if (!loadGenerationGuard.isCurrent(ticket) || songListUUID !== requestUUID) return
        originalSongInfoArr.value = markRaw(scanData)
        applyFiltersAndSorting()
        syncSelectedKeysAfterReload(scanData, songListUUID)
        syncPlayingStateAfterReload(scanData, songListUUID)
        markSongListApplied(songListUUID)
        return
      }

      if (isMixtapeListUUID(requestUUID)) {
        songsAreaState.missingWaveformFilePaths = []
        const result = await window.electron.ipcRenderer.invoke('mixtape:list', {
          playlistId: requestUUID
        })
        if (!loadGenerationGuard.isCurrent(ticket)) return
        const rawItems = Array.isArray(result?.items)
          ? (result.items as Array<Record<string, unknown>>)
          : []
        const songs = rawItems.map((item, index: number) =>
          mapMixtapeSnapshotToSongInfo(item, index, {
            buildDisplayPathByUuid: (uuid) => libraryUtils.buildDisplayPathByUuid(uuid)
          })
        )
        originalSongInfoArr.value = markRaw(songs)
        applyFiltersAndSorting()
        syncSelectedKeysAfterReload(songs, requestUUID)
        syncPlayingStateAfterReload(songs, requestUUID)
        markSongListApplied(requestUUID)
        await hydrateRenderCount(ticket)
        // 首屏已经画出来了，立刻把待亮的转圈收掉，别等 finally：慢一步就会出现
        // "列表 → 转圈 → 列表" 两次整页切换。
        cancelDelayedLoadingShow()
        return
      }

      if (isSetListUUID(requestUUID)) {
        songsAreaState.missingWaveformFilePaths = []
        const { scanData, songListUUID } = await window.electron.ipcRenderer.invoke(
          'setList:load-items',
          requestUUID
        )
        if (!loadGenerationGuard.isCurrent(ticket) || songListUUID !== requestUUID) return
        const songs = Array.isArray(scanData) ? scanData : []
        originalSongInfoArr.value = markRaw(songs)
        applyFiltersAndSorting()
        syncSelectedKeysAfterReload(songs, songListUUID)
        syncPlayingStateAfterReload(songs, songListUUID)
        markSongListApplied(songListUUID)
        await hydrateRenderCount(ticket)
        cancelDelayedLoadingShow()
        return
      }

      const songListPath = libraryUtils.findDirPathByUuid(requestUUID)

      // 第一优先：视图快照。主进程只查一行 + JSON.parse，零文件系统访问。
      // 正确性由它自己排的后台核对补：对得上就什么都不做，真变了才推 view-refreshed。
      try {
        const snapshotPayload = (await window.electron.ipcRenderer.invoke('playlist:fast-open', {
          songListUUID: requestUUID,
          songListPath
        })) as PlaylistFastOpenPayload | null
        if (!loadGenerationGuard.isCurrent(ticket)) return
        if (snapshotPayload?.hit) {
          const snapshotItems = Array.isArray(snapshotPayload.items)
            ? (snapshotPayload.items as ISongInfo[])
            : []
          songsAreaState.missingWaveformFilePaths = normalizeMissingWaveformFilePaths(
            snapshotPayload.missingWaveformFilePaths
          )
          resetDistributedVerifyCursor(requestUUID)
          rememberAppliedViewRevision(requestUUID, snapshotPayload.revision)
          if (!(await applySongListData(snapshotItems, ticket))) return
          cancelDelayedLoadingShow()
          writeSongListOpenPerf({
            source: 'snapshot',
            tookMs: Date.now() - openStartedAtMs,
            itemCount: snapshotItems.length,
            songListUUID: requestUUID
          })
          await maybeLoadFreshAnalysis(songListPath)
          return
        }
      } catch {}

      // 快照还没建立（首次打开 / 刚清过缓存）：退回原来的"核对缓存身份"快路径，
      // 它命中后会顺手把快照落下来，下次打开就走上面那条。
      try {
        const fastPayload = await window.electron.ipcRenderer.invoke(
          'song-search:playlist-fast-load',
          {
            songListUUID: requestUUID
          }
        )
        if (!loadGenerationGuard.isCurrent(ticket)) return
        const hit = Boolean(fastPayload?.hit)
        if (hit) {
          const fastItems = Array.isArray(fastPayload?.items) ? fastPayload.items : []
          songsAreaState.missingWaveformFilePaths = normalizeMissingWaveformFilePaths(
            fastPayload?.missingWaveformFilePaths
          )
          resetDistributedVerifyCursor(requestUUID)
          // 这条路不知道快照 revision（handler 落快照时才生成），只能记成"未知"。
          // 记 0 是必须的：如果缓存被清过、revision 从 1 重新计数，留着旧的大号会把
          // 后台第一次真刷新当成过期事件丢掉。
          rememberAppliedViewRevision(requestUUID, 0)
          if (!(await applySongListData(fastItems, ticket))) return
          cancelDelayedLoadingShow()
          writeSongListOpenPerf({
            source: 'cache-verify',
            tookMs: Date.now() - openStartedAtMs,
            itemCount: fastItems.length,
            songListUUID: requestUUID
          })
          await maybeLoadFreshAnalysis(songListPath)
          return
        }
      } catch {}

      await loadSongListFromDisk(songListPath, ticket, {
        forceNotifySongSearchDirty: true,
        diagnosticSource: 'foreground-open'
      })
      // 同上：整单重扫这条路也不知道快照 revision，记成未知，别挡住后台第一次刷新。
      rememberAppliedViewRevision(requestUUID, 0)
      writeSongListOpenPerf({
        source: 'full-scan',
        tookMs: Date.now() - openStartedAtMs,
        itemCount: originalSongInfoArr.value.length,
        songListUUID: requestUUID
      })
    } finally {
      cancelDelayedLoadingShow()
      settleSongListRequest(ticket)
    }
  }

  return {
    loadingShow,
    lastAppliedSongListUUID,
    isRequesting,
    renderCount,
    openSongList,
    invalidatePendingSongListLoads
  }
}
