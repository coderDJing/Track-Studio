import { nextTick, onUnmounted, ref, watch, type Ref, type ShallowRef } from 'vue'
import emitter from '@renderer/utils/mitt'
import type {
  ISongsAreaPaneRuntimeState,
  SongsAreaPaneKey,
  useRuntimeStore
} from '@renderer/stores/runtime'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import { isWindowsPathPlatform, normalizeFilePathForComparison } from '@shared/filePathComparison'

type FocusSongPayload = {
  pane?: SongsAreaPaneKey | 'pioneer'
  songListUUID?: string
  filePath?: string
  autoPlay?: boolean
  flash?: boolean
  waitForListStabilize?: boolean
}

interface UseGlobalSearchFocusParams {
  runtime: ReturnType<typeof useRuntimeStore>
  pane: SongsAreaPaneKey
  songsAreaState: ISongsAreaPaneRuntimeState
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  columnData: Ref<ISongsAreaColumn[]>
  applyFiltersAndSorting: () => void
  getRowKey: (song: ISongInfo) => string
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void
  songDblClick: (song: ISongInfo) => Promise<void> | void
  onFocusHit?: (rowKey: string) => void
}

const FOCUS_RETRY_INTERVAL_MS = 120
const FOCUS_RETRY_TIMEOUT_MS = 12000
const FOCUS_STABILIZE_MS = 1500

export function useGlobalSearchFocus(params: UseGlobalSearchFocusParams) {
  const {
    runtime,
    pane,
    songsAreaState,
    originalSongInfoArr,
    columnData,
    applyFiltersAndSorting,
    getRowKey,
    scrollToIndex,
    songDblClick,
    onFocusHit
  } = params
  const normalizeSongPath = (value: string | undefined | null) =>
    normalizeFilePathForComparison(
      value,
      isWindowsPathPlatform(runtime.setting.platform || runtime.platform)
    )

  const pendingFocusPayload = ref<FocusSongPayload | null>(null)
  let focusRetryTimer: ReturnType<typeof setInterval> | null = null
  let focusRetryDeadline = 0
  let focusApplying = false
  let focusAttemptSeq = 0
  let focusHasHit = false
  let focusAutoPlayed = false
  let focusStabilizeUntil = 0

  const findVisibleSongIndexByPath = (targetPath: string) =>
    songsAreaState.songInfoArr.findIndex((song) => normalizeSongPath(song.filePath) === targetPath)

  const hasSongInOriginalByPath = (targetPath: string) =>
    originalSongInfoArr.value.some((song) => normalizeSongPath(song.filePath) === targetPath)

  const clearColumnFiltersForGlobalLocate = () => {
    const hasActiveFilter = columnData.value.some(
      (col) =>
        Boolean(col.filterActive) ||
        Boolean(String(col.filterValue || '').trim()) ||
        Boolean(String(col.filterExcludeValue || '').trim()) ||
        Boolean(col.filterOp) ||
        Boolean(String(col.filterDuration || '').trim()) ||
        Boolean(String(col.filterDurationTo || '').trim()) ||
        Boolean(String(col.filterNumber || '').trim()) ||
        Boolean(String(col.filterNumberTo || '').trim()) ||
        Boolean(String(col.filterDate || '').trim()) ||
        Boolean(String(col.filterDateTo || '').trim())
    )
    if (!hasActiveFilter) return false

    columnData.value = columnData.value.map((col) => ({
      ...col,
      filterActive: false,
      filterValue: undefined,
      filterExcludeValue: undefined,
      filterOp: undefined,
      filterDuration: undefined,
      filterDurationTo: undefined,
      filterNumber: undefined,
      filterNumberTo: undefined,
      filterDate: undefined,
      filterDateTo: undefined
    }))
    applyFiltersAndSorting()
    return true
  }

  const applyFocusSongPayload = async (payload: FocusSongPayload, _attemptNo: number) => {
    if (payload.pane && payload.pane !== pane) return false
    const targetPath = normalizeSongPath(payload?.filePath)
    const targetListUUID = String(payload?.songListUUID || '')
    if (!targetPath) return false
    if (targetListUUID && targetListUUID !== songsAreaState.songListUUID) {
      return false
    }
    let targetIndex = findVisibleSongIndexByPath(targetPath)
    if (targetIndex < 0 && hasSongInOriginalByPath(targetPath)) {
      const didClearFilters = clearColumnFiltersForGlobalLocate()
      if (didClearFilters) {
        await nextTick()
        targetIndex = findVisibleSongIndexByPath(targetPath)
      }
    }
    if (targetIndex < 0) {
      return false
    }
    const targetSong = songsAreaState.songInfoArr[targetIndex]
    const rowKey = getRowKey(targetSong)
    songsAreaState.selectedSongFilePath = [rowKey]
    await nextTick()
    scrollToIndex(targetIndex)
    if (payload.autoPlay && !focusAutoPlayed) {
      focusAutoPlayed = true
      await songDblClick(targetSong)
    }
    if (!focusHasHit) {
      focusHasHit = true
      focusStabilizeUntil =
        payload.waitForListStabilize === false ? 0 : Date.now() + FOCUS_STABILIZE_MS
    }
    if (Date.now() < focusStabilizeUntil) {
      return false
    }
    if (payload.flash) {
      onFocusHit?.(rowKey)
    }
    return true
  }

  const stopFocusRetryLoop = () => {
    if (focusRetryTimer) {
      clearInterval(focusRetryTimer)
      focusRetryTimer = null
    }
  }

  const runPendingFocusAttempt = () => {
    const payload = pendingFocusPayload.value
    if (!payload) {
      stopFocusRetryLoop()
      return
    }
    if (Date.now() > focusRetryDeadline) {
      pendingFocusPayload.value = null
      stopFocusRetryLoop()
      return
    }
    if (focusApplying) return

    focusApplying = true
    focusAttemptSeq += 1
    const attemptNo = focusAttemptSeq
    void applyFocusSongPayload(payload, attemptNo)
      .then((done) => {
        if (done && pendingFocusPayload.value === payload) {
          pendingFocusPayload.value = null
          stopFocusRetryLoop()
        }
      })
      .finally(() => {
        focusApplying = false
      })
  }

  const ensureFocusRetryLoop = () => {
    focusRetryDeadline = Date.now() + FOCUS_RETRY_TIMEOUT_MS
    if (focusRetryTimer) return
    focusRetryTimer = setInterval(runPendingFocusAttempt, FOCUS_RETRY_INTERVAL_MS)
  }

  const handleFocusSongRequest = (payload?: FocusSongPayload) => {
    if (!payload) return
    if (payload.pane && payload.pane !== pane) return
    focusAttemptSeq = 0
    focusHasHit = false
    focusAutoPlayed = false
    focusStabilizeUntil = 0
    pendingFocusPayload.value = payload
    ensureFocusRetryLoop()
    runPendingFocusAttempt()
  }

  emitter.on('songsArea/focus-song', handleFocusSongRequest)

  watch(
    () => [
      songsAreaState.songListUUID,
      songsAreaState.songInfoArr.length,
      songsAreaState.songInfoArr
    ],
    () => {
      runPendingFocusAttempt()
    },
    { flush: 'post' }
  )

  onUnmounted(() => {
    emitter.off('songsArea/focus-song', handleFocusSongRequest)
    stopFocusRetryLoop()
  })
}
