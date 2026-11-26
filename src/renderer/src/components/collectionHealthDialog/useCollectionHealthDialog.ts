import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import emitter from '@renderer/utils/mitt'
import { useRuntimeStore } from '@renderer/stores/runtime'
import showEditMetadataDialog from '@renderer/components/editMetadataDialog'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import type {
  CollectionHealthAlbumGroup,
  CollectionHealthAlbumVariant,
  CollectionHealthActionResponse,
  CollectionHealthCheck,
  CollectionHealthDuplicateGroup,
  CollectionHealthSnapshot,
  CollectionHealthTrackHit
} from '@shared/collectionHealth'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

const LOW_BITRATE_STORAGE_KEY = 'FRKB_COLLECTION_HEALTH_LOW_BITRATE'
const DEFAULT_LOW_BITRATE = 192

export const LOW_BITRATE_OPTIONS = [128, 160, 192, 256, 320]

export const COLLECTION_HEALTH_CHECK_ORDER: CollectionHealthCheck[] = [
  'lowBitrate',
  'noCover',
  'albumTags',
  'duplicates'
]

const refOf = (hit: { listRoot: string; filePath: string }) => ({
  listRoot: hit.listRoot,
  filePath: hit.filePath
})

const filePathKey = (value: string) =>
  normalizeFilePathForComparison(value, isCurrentRendererWindowsPathPlatform())

type HealthLocateLibrary = 'FilterLibrary' | 'CuratedLibrary' | 'SetLibrary' | 'MixtapeLibrary'

const isHealthLocateLibrary = (value: string): value is HealthLocateLibrary =>
  value === 'FilterLibrary' ||
  value === 'CuratedLibrary' ||
  value === 'SetLibrary' ||
  value === 'MixtapeLibrary'

const readStoredThreshold = (): number => {
  try {
    const raw = Number(localStorage.getItem(LOW_BITRATE_STORAGE_KEY))
    if (LOW_BITRATE_OPTIONS.includes(raw)) return raw
  } catch {}
  return DEFAULT_LOW_BITRATE
}

export function useCollectionHealthDialog(props: { libraryName: string }) {
  const runtime = useRuntimeStore()

  const snapshot = ref<CollectionHealthSnapshot | null>(null)
  const loading = ref(true)
  const actionBusy = ref(false)
  const loadError = ref('')
  const threshold = ref<number>(readStoredThreshold())

  const libraryDisplayName = computed(() => toLibraryDisplayName(props.libraryName))

  const enabledChecks = computed<CollectionHealthCheck[]>(() => {
    if (props.libraryName === 'CuratedLibrary') return [...COLLECTION_HEALTH_CHECK_ORDER]
    return ['lowBitrate', 'duplicates']
  })

  const activeCheck = ref<CollectionHealthCheck>('lowBitrate')
  watch(enabledChecks, (list) => {
    if (!list.includes(activeCheck.value)) activeCheck.value = list[0]
  })

  const requestId = computed(() => snapshot.value?.requestId ?? 0)

  const checkResult = (check: CollectionHealthCheck) => snapshot.value?.checks[check] ?? null

  const probeTotal = computed(() => snapshot.value?.checks.duplicates.total ?? 0)
  const probeDone = computed(() => snapshot.value?.checks.duplicates.done ?? 0)
  const probePercent = computed(() =>
    probeTotal.value > 0 ? Math.round((probeDone.value / probeTotal.value) * 100) : 0
  )
  const probing = computed(() => {
    const status = snapshot.value?.checks.duplicates.status
    return status === 'working' || status === 'waiting-idle'
  })

  const thresholdOptions = LOW_BITRATE_OPTIONS.map((value) => ({
    label: t('collectionHealth.lowBitrate.thresholdOption', { kbps: value }),
    value
  }))

  const checkCount = (check: CollectionHealthCheck): number => checkResult(check)?.hitCount ?? 0

  const setSnapshot = (next: CollectionHealthSnapshot | null) => {
    if (next) snapshot.value = next
  }

  let startSeq = 0
  const startScan = async () => {
    const seq = ++startSeq
    loading.value = true
    loadError.value = ''
    try {
      const result = (await window.electron.ipcRenderer.invoke('collection-health:start', {
        libraryName: props.libraryName,
        lowBitrateThresholdKbps: threshold.value
      })) as CollectionHealthSnapshot | null
      if (seq !== startSeq) return
      if (result) snapshot.value = result
      else loadError.value = t('collectionHealth.startFailed')
    } catch (error) {
      if (seq !== startSeq) return
      loadError.value =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : t('collectionHealth.startFailed')
    } finally {
      if (seq === startSeq) loading.value = false
    }
  }

  watch(threshold, (value) => {
    try {
      localStorage.setItem(LOW_BITRATE_STORAGE_KEY, String(value))
    } catch {}
    void startScan()
  })

  const handleSnapshotUpdated = (_event: unknown, next: CollectionHealthSnapshot) => {
    if (!next || next.libraryName !== props.libraryName) return
    snapshot.value = next
    loading.value = false
  }

  const handleStop = () => {
    void window.electron.ipcRenderer.invoke('collection-health:stop', {
      requestId: requestId.value || undefined
    })
  }

  onMounted(() => {
    window.electron.ipcRenderer.on('collection-health:snapshot-updated', handleSnapshotUpdated)
    void startScan()
  })

  onUnmounted(() => {
    window.electron.ipcRenderer.removeListener(
      'collection-health:snapshot-updated',
      handleSnapshotUpdated
    )
    startSeq += 1
    handleStop()
  })

  const toggleIgnore = async (
    check: CollectionHealthCheck,
    hit: CollectionHealthTrackHit,
    ignored: boolean
  ) => {
    if (!requestId.value) return
    try {
      const next = (await window.electron.ipcRenderer.invoke('collection-health:set-ignore', {
        requestId: requestId.value,
        check,
        ...refOf(hit),
        ignored
      })) as CollectionHealthSnapshot | null
      setSnapshot(next)
    } catch (error) {
      console.error('[collection-health] set ignore failed', error)
    }
  }

  const ignoreTracks = async (check: CollectionHealthCheck, hits: CollectionHealthTrackHit[]) => {
    if (!requestId.value || !hits.length) return
    actionBusy.value = true
    try {
      for (const hit of hits) {
        await toggleIgnore(check, hit, true)
      }
    } finally {
      actionBusy.value = false
    }
  }

  const locateTrack = async (hit: CollectionHealthTrackHit): Promise<boolean> => {
    const songListUUID = String(hit.songListUuid || '').trim()
    if (!songListUUID || !isHealthLocateLibrary(props.libraryName)) {
      await confirm({
        title: t('collectionHealth.locateFailedTitle'),
        content: [
          t('collectionHealth.locateFailedNoPlaylist', { name: hit.title || hit.fileName })
        ],
        confirmShow: false
      })
      return false
    }
    runtime.lastSongListUUIDByLibrary[props.libraryName] = songListUUID
    runtime.libraryAreaSelected = props.libraryName
    if (runtime.songsArea.songListUUID !== songListUUID) {
      runtime.songsArea.songListUUID = songListUUID
    }
    emitter.emit('songsArea/focus-song', {
      songListUUID,
      filePath: hit.filePath,
      autoPlay: false,
      flash: true
    })
    return true
  }

  const editTrack = async (hit: CollectionHealthTrackHit) => {
    const result = await showEditMetadataDialog({ filePath: hit.filePath })
    if (result === 'cancel') return
    emitter.emit('metadataBatchUpdated', {
      updates: [{ song: result.updatedSongInfo, oldFilePath: result.oldFilePath }]
    })
    await startScan()
  }

  const autoFillCovers = async (hits: CollectionHealthTrackHit[]) => {
    if (!hits.length) return
    actionBusy.value = true
    runtime.isProgressing = true
    try {
      const summary = await invokeMetadataAutoFill(hits.map((hit) => hit.filePath))
      if (!summary) return
      const { default: openAutoSummary } =
        await import('@renderer/components/autoMetadataSummaryDialog')
      await openAutoSummary(summary)
      const updates =
        summary.items
          ?.filter((item) => item.status === 'applied' && item.updatedSongInfo)
          .map((item) => ({
            song: item.updatedSongInfo as NonNullable<typeof item.updatedSongInfo>,
            oldFilePath: item.oldFilePath
          })) || []
      if (updates.length) {
        emitter.emit('metadataBatchUpdated', { updates })
      }
      await startScan()
    } catch (error) {
      await confirm({
        title: t('common.error'),
        content: [
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : t('common.unknownError')
        ],
        confirmShow: false
      })
    } finally {
      runtime.isProgressing = false
      actionBusy.value = false
    }
  }

  const markGroupNotDuplicate = async (group: CollectionHealthDuplicateGroup) => {
    if (!requestId.value) return
    const result = await confirm({
      title: t('collectionHealth.duplicates.markNotDuplicate'),
      content: [
        t('collectionHealth.duplicates.markConfirm', { count: group.tracks.length }),
        t('collectionHealth.duplicates.markHint')
      ],
      textAlign: 'left'
    })
    if (result !== 'confirm') return
    actionBusy.value = true
    try {
      const next = (await window.electron.ipcRenderer.invoke(
        'collection-health:mark-not-duplicate',
        { requestId: requestId.value, groupId: group.groupId }
      )) as CollectionHealthSnapshot | null
      setSnapshot(next)
    } catch (error) {
      console.error('[collection-health] mark not duplicate failed', error)
    } finally {
      actionBusy.value = false
    }
  }

  const removeDuplicates = async (group: CollectionHealthDuplicateGroup, keepFilePath: string) => {
    if (!requestId.value) return
    const keep =
      group.tracks.find((track) => filePathKey(track.filePath) === filePathKey(keepFilePath)) ||
      group.tracks[0]
    const others = group.tracks.filter((track) => track !== keep)
    if (!others.length) return
    const result = await confirm({
      title: t('collectionHealth.duplicates.removeTitle'),
      content: [
        t('collectionHealth.duplicates.removeConfirm', {
          count: others.length,
          name: keep.title || keep.fileName
        }),
        t('collectionHealth.duplicates.removeHint')
      ],
      textAlign: 'left'
    })
    if (result !== 'confirm') return
    actionBusy.value = true
    try {
      const response = (await window.electron.ipcRenderer.invoke(
        'collection-health:remove-duplicates',
        {
          requestId: requestId.value,
          keep: refOf(keep),
          remove: others.map(refOf)
        }
      )) as CollectionHealthActionResponse | null
      setSnapshot(response?.snapshot ?? null)
      if (response?.failed?.length) {
        await confirm({
          title: t('common.error'),
          content: [
            t('collectionHealth.duplicates.removeFailed', { count: response.failed.length }),
            ...response.failed.slice(0, 5).map((item) => `${item.filePath}: ${item.error}`)
          ],
          confirmShow: false,
          textAlign: 'left',
          canCopyText: true
        })
      }
    } catch (error) {
      console.error('[collection-health] remove duplicates failed', error)
    } finally {
      actionBusy.value = false
    }
  }

  const removeTrack = async (hit: CollectionHealthTrackHit) => {
    if (!requestId.value) return
    const result = await confirm({
      title: t('collectionHealth.removeTrackTitle'),
      content: [
        t('collectionHealth.removeTrackConfirm', { name: hit.title || hit.fileName }),
        t('collectionHealth.removeTrackHint')
      ],
      textAlign: 'left'
    })
    if (result !== 'confirm') return
    actionBusy.value = true
    try {
      const response = (await window.electron.ipcRenderer.invoke(
        'collection-health:remove-tracks',
        { requestId: requestId.value, tracks: [refOf(hit)] }
      )) as CollectionHealthActionResponse | null
      setSnapshot(response?.snapshot ?? null)
      if (response?.failed?.length) {
        await confirm({
          title: t('common.error'),
          content: [
            t('collectionHealth.removeTrackFailed', { count: response.failed.length }),
            ...response.failed.slice(0, 5).map((item) => `${item.filePath}: ${item.error}`)
          ],
          confirmShow: false,
          textAlign: 'left',
          canCopyText: true
        })
      }
    } catch (error) {
      console.error('[collection-health] remove track failed', error)
    } finally {
      actionBusy.value = false
    }
  }

  const unifyAlbum = async (
    group: CollectionHealthAlbumGroup,
    variant: CollectionHealthAlbumVariant
  ) => {
    if (!requestId.value) return
    const targets = group.variants
      .filter((item) => item.album !== variant.album)
      .flatMap((item) => item.tracks)
      .filter((hit) => hit.album !== variant.album)
    if (!targets.length) return
    const result = await confirm({
      title: t('collectionHealth.album.unifyTitle'),
      content: [
        t('collectionHealth.album.unifyConfirm', {
          count: targets.length,
          album: variant.album
        }),
        t('collectionHealth.album.unifyHint')
      ],
      textAlign: 'left'
    })
    if (result !== 'confirm') return
    actionBusy.value = true
    try {
      const response = (await window.electron.ipcRenderer.invoke('collection-health:unify-album', {
        requestId: requestId.value,
        album: variant.album,
        tracks: targets.map(refOf)
      })) as CollectionHealthActionResponse | null
      setSnapshot(response?.snapshot ?? null)
      if (response?.updates?.length) {
        emitter.emit('metadataBatchUpdated', { updates: response.updates })
      }
      if (response?.failed?.length) {
        await confirm({
          title: t('common.error'),
          content: [
            t('collectionHealth.album.unifyFailed', { count: response.failed.length }),
            ...response.failed.slice(0, 5).map((item) => `${item.filePath}: ${item.error}`)
          ],
          confirmShow: false,
          textAlign: 'left',
          canCopyText: true
        })
      }
    } catch (error) {
      console.error('[collection-health] unify album failed', error)
    } finally {
      actionBusy.value = false
    }
  }

  return {
    snapshot,
    loading,
    actionBusy,
    loadError,
    threshold,
    thresholdOptions,
    libraryDisplayName,
    enabledChecks,
    activeCheck,
    requestId,
    checkResult,
    checkCount,
    probeTotal,
    probeDone,
    probePercent,
    probing,
    startScan,
    toggleIgnore,
    ignoreTracks,
    locateTrack,
    editTrack,
    autoFillCovers,
    markGroupNotDuplicate,
    removeDuplicates,
    removeTrack,
    unifyAlbum
  }
}
