import { sameRendererFilePath, RendererFilePathMap } from '@renderer/utils/filePathComparison'

import { FIXED_MIXTAPE_STEM_MODE } from '@shared/mixtapeStemMode'
import type {
  MixtapeTrack,
  RawWaveformData,
  RawWaveformLevel,
  StemWaveformData,
  TimelineTrackLayout
} from '@renderer/composables/mixtape/types'
import type { TimelineWaveformData } from '@renderer/composables/mixtape/timelineRenderAndLoadTypes'

type RawWaveformBatchTarget = {
  filePath: string
  listRoot?: string
}

type ValueRef<T> = {
  value: T
}

type StemWaveformBundleRequestItem = {
  listRoot?: string
  sourceFilePath: string
  stemMode: typeof FIXED_MIXTAPE_STEM_MODE
  stemModel?: string
  stemVersion?: string
  stemPaths: {
    vocalPath?: string
    instPath?: string
    bassPath?: string
    drumsPath?: string
  }
}

type StemWaveformBundleResponse = {
  items?: Array<{
    sourceFilePath?: string
    stems?: Array<{ stemId?: string; filePath?: string; data?: unknown }>
  }>
}

type RawWaveformBatchResponse = {
  items?: Array<{ filePath: string; data: RawWaveformData | null }>
}

type TimelineWaveformLoadingCtx = {
  tracks: ValueRef<MixtapeTrack[]>
  waveformDataMap: Map<string, TimelineWaveformData | null>
  waveformQueuedMissing: Set<string>
  rawWaveformDataMap: Map<string, RawWaveformData | null>
  rawWaveformPyramidMap: Map<string, RawWaveformLevel[]>
  waveformInflight: Set<string>
  rawWaveformInflight: Set<string>
  waveformVersion: ValueRef<number>
  pushStemWaveformToWorker: (filePath: string, data: StemWaveformData | null) => void
  pushRawWaveformToWorker: (filePath: string, data: RawWaveformData | null) => void
  clearWaveformTileCacheForFile: (filePath: string) => void
  scheduleWaveformDraw: () => void
  scheduleFullPreRender: () => void
  scheduleWorkerPreRender: () => void
  resolveWaveformListRoot: (track: MixtapeTrack) => string
  resolveTrackWaveformSources: (
    track: MixtapeTrack
  ) => Array<{ filePath: string; listRoot?: string }>
  resolveTrackWaveformFilePaths: (track: MixtapeTrack) => string[]
  buildSequentialLayoutForZoom: (zoom: number) => { layout: TimelineTrackLayout[] }
  forEachVisibleLayoutItem: (
    snapshot: { layout: TimelineTrackLayout[] },
    visibleStart: number,
    visibleEnd: number,
    iteratee: (item: TimelineTrackLayout) => void
  ) => void
  normalizedRenderZoom: ValueRef<number>
  timelineScrollRef: ValueRef<{
    osInstance?: () => { elements(): { viewport?: HTMLElement } } | null
  } | null>
  timelineScrollLeft: ValueRef<number>
  timelineViewportWidth: ValueRef<number>
  decodeStemWaveformData: (payload: unknown) => StemWaveformData | null
  storeWaveformData: (filePath: string, data: TimelineWaveformData | null) => void
  fetchWaveformBatch: (filePaths: string[], listRoot?: string) => Promise<void>
  decodeRawWaveformData: (payload: unknown) => RawWaveformData | null
  buildRawWaveformPyramid: (raw: RawWaveformData) => RawWaveformLevel[]
  isStemMixMode: () => boolean
  useRawWaveform: ValueRef<boolean>
  getWaveformLoadTimer: () => ReturnType<typeof setTimeout> | null
  setWaveformLoadTimer: (timer: ReturnType<typeof setTimeout> | null) => void
  isTransportPreloadingActive: () => boolean
  ENABLE_STEM_PREVIEW_WAVEFORM: boolean
  WAVEFORM_BATCH_SIZE: number
  RAW_WAVEFORM_BATCH_SIZE: number
  RAW_WAVEFORM_TARGET_RATE: number
  RAW_VISIBLE_BUFFER_PX: number
  RAW_BATCH_MAX_CONCURRENT: number
}

export const createTimelineWaveformLoadingModule = (ctx: TimelineWaveformLoadingCtx) => {
  const {
    tracks,
    waveformDataMap,
    waveformQueuedMissing,
    rawWaveformDataMap,
    rawWaveformPyramidMap,
    waveformInflight,
    rawWaveformInflight,
    waveformVersion,
    pushStemWaveformToWorker,
    pushRawWaveformToWorker,
    clearWaveformTileCacheForFile,
    scheduleWaveformDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    resolveWaveformListRoot,
    resolveTrackWaveformSources,
    resolveTrackWaveformFilePaths,
    buildSequentialLayoutForZoom,
    forEachVisibleLayoutItem,
    normalizedRenderZoom,
    timelineScrollRef,
    timelineScrollLeft,
    timelineViewportWidth,
    decodeStemWaveformData,
    storeWaveformData,
    fetchWaveformBatch,
    decodeRawWaveformData,
    buildRawWaveformPyramid,
    isStemMixMode,
    useRawWaveform,
    getWaveformLoadTimer,
    setWaveformLoadTimer,
    isTransportPreloadingActive,
    ENABLE_STEM_PREVIEW_WAVEFORM,
    WAVEFORM_BATCH_SIZE,
    RAW_WAVEFORM_BATCH_SIZE,
    RAW_WAVEFORM_TARGET_RATE,
    RAW_VISIBLE_BUFFER_PX,
    RAW_BATCH_MAX_CONCURRENT
  } = ctx

  let rawLoadInFlight = false
  let rawLoadRerunPending = false

  const fetchStemWaveformBundleBatch = async (requestItems: StemWaveformBundleRequestItem[]) => {
    if (!requestItems.length) return
    const requestedFilePathToRoot = new Map<string, string>()
    for (const item of requestItems) {
      const stemPaths = item?.stemPaths || {}
      const requiredPaths = [
        stemPaths.vocalPath,
        stemPaths.instPath,
        stemPaths.bassPath,
        stemPaths.drumsPath
      ]
        .map((value: unknown) => String(value || '').trim())
        .filter(Boolean)
      for (const filePath of requiredPaths) {
        if (requestedFilePathToRoot.has(filePath)) continue
        requestedFilePathToRoot.set(filePath, String(item.listRoot || '').trim())
      }
    }
    const requestedPaths = Array.from(requestedFilePathToRoot.keys())
    if (!requestedPaths.length) return
    for (const filePath of requestedPaths) {
      waveformInflight.add(filePath)
    }

    let response: StemWaveformBundleResponse | null = null
    try {
      response = await window.electron.ipcRenderer.invoke('mixtape-stem-waveform-cache:batch', {
        items: requestItems
      })
    } catch {
      response = null
    }

    const responseItems = Array.isArray(response?.items) ? response!.items : []
    const responseDataMap = new RendererFilePathMap<StemWaveformData | null>()
    for (const item of responseItems) {
      const stems = Array.isArray(item?.stems) ? item.stems : []
      for (const stem of stems) {
        const filePath = String(stem?.filePath || '').trim()
        if (!filePath) continue
        responseDataMap.set(filePath, decodeStemWaveformData(stem?.data) ?? null)
      }
    }

    const missing: string[] = []
    for (const filePath of requestedPaths) {
      const data = responseDataMap.has(filePath) ? responseDataMap.get(filePath) : null
      storeWaveformData(filePath, data ?? null)
      if (data) {
        waveformQueuedMissing.delete(filePath)
      } else {
        missing.push(filePath)
      }
      waveformInflight.delete(filePath)
    }

    if (missing.length) {
      const grouped = new Map<string, string[]>()
      const groupedSet = new Map<string, Set<string>>()
      for (const filePath of missing) {
        if (waveformQueuedMissing.has(filePath)) continue
        const listRoot = requestedFilePathToRoot.get(filePath) || ''
        const existing = grouped.get(listRoot) || []
        const existingSet = groupedSet.get(listRoot) || new Set<string>()
        if (existingSet.has(filePath)) continue
        existingSet.add(filePath)
        existing.push(filePath)
        grouped.set(listRoot, existing)
        groupedSet.set(listRoot, existingSet)
        waveformQueuedMissing.add(filePath)
      }
      for (const [listRoot, filePaths] of grouped.entries()) {
        if (!filePaths.length) continue
        window.electron.ipcRenderer.send('mixtape-waveform:queue-visible', {
          filePaths,
          listRoot: listRoot || undefined
        })
      }
    }
  }

  const fetchRawWaveformBatch = async (targets: RawWaveformBatchTarget[]) => {
    if (!targets.length) return
    const normalizedTargets: RawWaveformBatchTarget[] = []
    const targetSet = new Set<string>()
    for (const target of targets) {
      const filePath = String(target?.filePath || '').trim()
      if (!filePath || targetSet.has(filePath)) continue
      targetSet.add(filePath)
      normalizedTargets.push({
        filePath,
        listRoot: String(target?.listRoot || '').trim()
      })
    }
    if (!normalizedTargets.length) return
    const requestedPaths = normalizedTargets.map((target) => target.filePath)
    const listRootByFilePath: Record<string, string> = {}
    for (const target of normalizedTargets) {
      const listRoot = String(target.listRoot || '').trim()
      if (!listRoot) continue
      listRootByFilePath[target.filePath] = listRoot
    }
    for (const filePath of requestedPaths) {
      rawWaveformInflight.add(filePath)
    }
    let response: RawWaveformBatchResponse | null = null
    try {
      response = await window.electron.ipcRenderer.invoke('mixtape-waveform-raw:batch', {
        filePaths: requestedPaths,
        listRootByFilePath: Object.keys(listRootByFilePath).length ? listRootByFilePath : undefined,
        targetRate: RAW_WAVEFORM_TARGET_RATE,
        preferSharedDecode: true
      })
    } catch {
      response = null
    }
    const items = Array.isArray(response?.items) ? response!.items : []
    const itemMap = new RendererFilePathMap(
      items.map((entry) => [entry?.filePath || '', entry?.data ?? null] as const)
    )
    let updated = false
    for (const filePath of requestedPaths) {
      try {
        const decoded = decodeRawWaveformData(itemMap.get(filePath))
        rawWaveformDataMap.set(filePath, decoded)
        if (decoded) {
          rawWaveformPyramidMap.set(filePath, buildRawWaveformPyramid(decoded))
        } else {
          rawWaveformPyramidMap.delete(filePath)
        }
        pushRawWaveformToWorker(filePath, decoded)
        clearWaveformTileCacheForFile(filePath)
        updated = true
      } catch {
        rawWaveformDataMap.set(filePath, null)
        rawWaveformPyramidMap.delete(filePath)
        pushRawWaveformToWorker(filePath, null)
        clearWaveformTileCacheForFile(filePath)
        updated = true
      } finally {
        rawWaveformInflight.delete(filePath)
      }
    }
    if (updated) {
      waveformVersion.value += 1
    }
    scheduleWaveformDraw()
    scheduleFullPreRender()
    scheduleWorkerPreRender()
  }

  const loadWaveforms = async () => {
    if (!tracks.value.length) return
    if (isStemMixMode() && !ENABLE_STEM_PREVIEW_WAVEFORM) {
      for (const track of tracks.value) {
        const waveformSources = resolveTrackWaveformSources(track)
        for (const source of waveformSources) {
          const filePath = String(source.filePath || '').trim()
          if (!filePath) continue
          if (!waveformDataMap.has(filePath)) {
            waveformDataMap.set(filePath, null)
            pushStemWaveformToWorker(filePath, null)
          }
        }
      }
      scheduleWaveformDraw()
      return
    }
    if (!isStemMixMode()) {
      const grouped = new Map<string, string[]>()
      for (const track of tracks.value) {
        const waveformSources = resolveTrackWaveformSources(track)
        if (!waveformSources.length) continue
        const listRoot = waveformSources[0]?.listRoot || resolveWaveformListRoot(track)
        const listKey = listRoot || ''
        const list = grouped.get(listKey) || []
        for (const source of waveformSources) {
          const filePath = String(source.filePath || '').trim()
          if (!filePath || waveformDataMap.has(filePath) || waveformInflight.has(filePath)) continue
          if (!list.some((candidate) => sameRendererFilePath(candidate, filePath))) {
            list.push(filePath)
          }
        }
        if (list.length) {
          grouped.set(listKey, list)
        }
      }
      if (grouped.size === 0) {
        scheduleWaveformDraw()
        return
      }
      for (const [listRoot, filePaths] of grouped.entries()) {
        for (let i = 0; i < filePaths.length; i += WAVEFORM_BATCH_SIZE) {
          const batch = filePaths.slice(i, i + WAVEFORM_BATCH_SIZE)
          await fetchWaveformBatch(batch, listRoot || undefined)
        }
      }
      return
    }

    const stemBundleRequestItems: StemWaveformBundleRequestItem[] = []
    const stemBundleRequestKeySet = new Set<string>()
    for (const track of tracks.value) {
      const waveformSources = resolveTrackWaveformSources(track)
      if (!waveformSources.length) continue
      const pendingSources = waveformSources.filter((waveformSource: { filePath?: string }) => {
        const filePath = String(waveformSource.filePath || '').trim()
        if (!filePath) return false
        if (waveformDataMap.has(filePath)) return false
        if (waveformInflight.has(filePath)) return false
        return true
      })
      if (!pendingSources.length) continue
      const sourceFilePath = String(track.filePath || '').trim()
      const stemMode = FIXED_MIXTAPE_STEM_MODE
      const requestKey = [
        sourceFilePath,
        stemMode,
        String(track.stemModel || '').trim(),
        String(track.stemVersion || '').trim()
      ].join('::')
      if (sourceFilePath && !stemBundleRequestKeySet.has(requestKey)) {
        stemBundleRequestKeySet.add(requestKey)
        const listRoot = waveformSources[0]?.listRoot || resolveWaveformListRoot(track)
        stemBundleRequestItems.push({
          listRoot,
          sourceFilePath,
          stemMode,
          stemModel: String(track.stemModel || '').trim() || undefined,
          stemVersion: String(track.stemVersion || '').trim() || undefined,
          stemPaths: {
            vocalPath: String(track.stemVocalPath || '').trim() || undefined,
            instPath: String(track.stemInstPath || '').trim() || undefined,
            bassPath: String(track.stemBassPath || '').trim() || undefined,
            drumsPath: String(track.stemDrumsPath || '').trim() || undefined
          }
        })
      }
    }
    if (stemBundleRequestItems.length === 0) {
      scheduleWaveformDraw()
      return
    }
    for (let i = 0; i < stemBundleRequestItems.length; i += WAVEFORM_BATCH_SIZE) {
      const batch = stemBundleRequestItems.slice(i, i + WAVEFORM_BATCH_SIZE)
      await fetchStemWaveformBundleBatch(batch)
    }
  }

  const loadRawWaveforms = async () => {
    if (isTransportPreloadingActive()) {
      rawLoadRerunPending = true
      return
    }
    if (rawLoadInFlight) {
      rawLoadRerunPending = true
      return
    }
    rawLoadInFlight = true
    try {
      if (!tracks.value.length) return
      if (!useRawWaveform.value) return

      const collectVisibleTargets = () => {
        const viewport =
          (timelineScrollRef.value?.osInstance?.()?.elements?.().viewport as
            HTMLElement | undefined) || null
        const viewportLeft = Math.max(
          0,
          Math.floor(viewport?.scrollLeft || Number(timelineScrollLeft.value || 0))
        )
        const viewportWidth = Math.max(
          0,
          Math.floor(viewport?.clientWidth || Number(timelineViewportWidth.value || 0))
        )

        const targets: RawWaveformBatchTarget[] = []
        const targetIndexMap = new Map<string, number>()
        const pushTarget = (filePath: string, listRoot?: string) => {
          const normalizedFilePath = String(filePath || '').trim()
          if (!normalizedFilePath) return
          const existingRaw = rawWaveformDataMap.get(normalizedFilePath)
          if (existingRaw || rawWaveformInflight.has(normalizedFilePath)) return
          const normalizedListRoot = String(listRoot || '').trim()
          const existingIndex = targetIndexMap.get(normalizedFilePath)
          if (typeof existingIndex === 'number') {
            if (normalizedListRoot && !targets[existingIndex].listRoot) {
              targets[existingIndex].listRoot = normalizedListRoot
            }
            return
          }
          targetIndexMap.set(normalizedFilePath, targets.length)
          targets.push({
            filePath: normalizedFilePath,
            listRoot: normalizedListRoot
          })
        }

        if (viewportWidth <= 0) {
          const fallbackLimit = Math.max(RAW_WAVEFORM_BATCH_SIZE, RAW_WAVEFORM_BATCH_SIZE * 2)
          for (const track of tracks.value) {
            const listRoot = resolveWaveformListRoot(track)
            const filePaths = resolveTrackWaveformFilePaths(track)
            for (const filePath of filePaths) {
              pushTarget(filePath, listRoot)
            }
            if (isStemMixMode()) {
              pushTarget(String(track.filePath || '').trim(), listRoot)
            }
            if (targets.length >= fallbackLimit) break
          }
          return targets
        }

        const visibleStart = Math.max(0, viewportLeft - RAW_VISIBLE_BUFFER_PX)
        const visibleEnd = Math.max(
          visibleStart,
          Math.ceil(viewportLeft + viewportWidth + RAW_VISIBLE_BUFFER_PX)
        )
        const snapshot = buildSequentialLayoutForZoom(normalizedRenderZoom.value)
        forEachVisibleLayoutItem(
          snapshot,
          visibleStart,
          visibleEnd,
          (item: TimelineTrackLayout) => {
            const listRoot = resolveWaveformListRoot(item.track)
            const filePaths = resolveTrackWaveformFilePaths(item.track)
            for (const filePath of filePaths) {
              pushTarget(filePath, listRoot)
            }
            if (isStemMixMode()) {
              pushTarget(String(item.track.filePath || '').trim(), listRoot)
            }
          }
        )
        return targets
      }

      const targets = collectVisibleTargets()
      if (!targets.length) return

      const batches: RawWaveformBatchTarget[][] = []
      for (let i = 0; i < targets.length; i += RAW_WAVEFORM_BATCH_SIZE) {
        const batch = targets.slice(i, i + RAW_WAVEFORM_BATCH_SIZE)
        if (batch.length) batches.push(batch)
      }
      if (!batches.length) return

      const maxConcurrent = Math.max(1, Math.min(RAW_BATCH_MAX_CONCURRENT, batches.length))
      let cursor = 0
      const runNext = async () => {
        while (cursor < batches.length) {
          const index = cursor
          cursor += 1
          const batch = batches[index]
          await fetchRawWaveformBatch(batch)
        }
      }
      await Promise.all(Array.from({ length: maxConcurrent }, () => runNext()))
    } finally {
      rawLoadInFlight = false
      if (rawLoadRerunPending) {
        rawLoadRerunPending = false
        void loadRawWaveforms()
      }
    }
  }

  const scheduleWaveformLoad = () => {
    const timer = getWaveformLoadTimer()
    if (timer) clearTimeout(timer)
    if (isTransportPreloadingActive()) {
      setWaveformLoadTimer(
        setTimeout(() => {
          setWaveformLoadTimer(null)
          scheduleWaveformLoad()
        }, 220)
      )
      return
    }
    setWaveformLoadTimer(
      setTimeout(() => {
        setWaveformLoadTimer(null)
        void loadWaveforms()
        void loadRawWaveforms()
      }, 120)
    )
  }

  const handleWaveformUpdated = (_event: unknown, payload: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    waveformDataMap.delete(filePath)
    waveformQueuedMissing.delete(filePath)
    clearWaveformTileCacheForFile(filePath)
    if (!isStemMixMode()) {
      let listRoot = ''
      for (const track of tracks.value) {
        const waveformSource = resolveTrackWaveformSources(track).find(
          (item: { filePath: string }) => sameRendererFilePath(item.filePath, filePath)
        )
        if (waveformSource?.listRoot) {
          listRoot = waveformSource.listRoot
          break
        }
      }
      void fetchWaveformBatch([filePath], listRoot || undefined)
      return
    }
    if (!ENABLE_STEM_PREVIEW_WAVEFORM) {
      scheduleWaveformDraw()
      return
    }

    const stemBundleRequestItems: StemWaveformBundleRequestItem[] = []
    const stemBundleRequestKeySet = new Set<string>()
    for (const track of tracks.value) {
      const waveformSources = resolveTrackWaveformSources(track)
      if (
        !waveformSources.some((source: { filePath?: string }) =>
          sameRendererFilePath(source.filePath, filePath)
        )
      ) {
        continue
      }
      const sourceFilePath = String(track.filePath || '').trim()
      if (!sourceFilePath) continue
      const stemMode = FIXED_MIXTAPE_STEM_MODE
      const requestKey = [
        sourceFilePath,
        stemMode,
        String(track.stemModel || '').trim(),
        String(track.stemVersion || '').trim()
      ].join('::')
      if (stemBundleRequestKeySet.has(requestKey)) continue
      stemBundleRequestKeySet.add(requestKey)
      const listRoot = waveformSources[0]?.listRoot || resolveWaveformListRoot(track)
      stemBundleRequestItems.push({
        listRoot,
        sourceFilePath,
        stemMode,
        stemModel: String(track.stemModel || '').trim() || undefined,
        stemVersion: String(track.stemVersion || '').trim() || undefined,
        stemPaths: {
          vocalPath: String(track.stemVocalPath || '').trim() || undefined,
          instPath: String(track.stemInstPath || '').trim() || undefined,
          bassPath: String(track.stemBassPath || '').trim() || undefined,
          drumsPath: String(track.stemDrumsPath || '').trim() || undefined
        }
      })
    }
    if (stemBundleRequestItems.length > 0) {
      void fetchStemWaveformBundleBatch(stemBundleRequestItems)
      return
    }
    let listRoot = ''
    for (const track of tracks.value) {
      const waveformSource = resolveTrackWaveformSources(track).find((item: { filePath: string }) =>
        sameRendererFilePath(item.filePath, filePath)
      )
      if (waveformSource?.listRoot) {
        listRoot = waveformSource.listRoot
        break
      }
    }
    void fetchWaveformBatch([filePath], listRoot || undefined)
  }

  return {
    fetchStemWaveformBundleBatch,
    fetchRawWaveformBatch,
    loadWaveforms,
    loadRawWaveforms,
    scheduleWaveformLoad,
    handleWaveformUpdated
  }
}
