import choiceDialog from '@renderer/components/choiceDialog'
import confirm from '@renderer/components/confirmDialog'
import rekordboxDesktopTargetDialog from '@renderer/components/rekordboxDesktopTargetDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import {
  buildRekordboxSourceCacheKey,
  clearRekordboxSourceCachesByKind,
  setCachedRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import { normalizePlaylistTrackNumber, sortByPlaylistTrackNumber } from '@shared/playlistTrackOrder'
import type { IPioneerPlaylistTreeNode, ISongInfo } from '../../../types/globals'
import type {
  RekordboxDesktopCleanupCopiedTracksRequest,
  RekordboxDesktopPlaylistRequest,
  RekordboxDesktopPlaylistResponse,
  RekordboxDesktopPlaylistSuccessSummary,
  RekordboxDesktopPlaylistTrackInput,
  RekordboxDesktopPlaylistWriteTarget
} from '@shared/rekordboxDesktopPlaylist'
import { delSongsViaSend } from '@renderer/utils/recycleBinActions'
import {
  copyTracksToStorage,
  ensureRekordboxDesktopStorageDirConfigured
} from '@renderer/utils/rekordboxTrackStorage'

type RekordboxDesktopDeletePayload = {
  songListPath?: string
  sourceType?: string
}

type RekordboxDesktopPlaylistWriteResult = RekordboxDesktopPlaylistSuccessSummary & {
  removedSourceFilePaths?: string[]
  removedSetItemIds?: string[]
}

const pad = (value: number) => String(value).padStart(2, '0')

const buildTimestampLabel = () => {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours()
  )}-${pad(now.getMinutes())}`
}

const buildDefaultSelectedTracksPlaylistName = () =>
  t('rekordboxDesktop.defaultPlaylistName', { time: buildTimestampLabel() })

const buildTrackInput = (song: ISongInfo): RekordboxDesktopPlaylistTrackInput => ({
  filePath: song.filePath,
  displayName: String(song.title || song.fileName || '').trim(),
  playlistTrackNumber: normalizePlaylistTrackNumber(song.playlistTrackNumber),
  artist: typeof song.artist === 'string' ? song.artist : '',
  album: typeof song.album === 'string' ? song.album : '',
  genre: typeof song.genre === 'string' ? song.genre : '',
  label: typeof song.label === 'string' ? song.label : '',
  bitrate: typeof song.bitrate === 'number' ? song.bitrate : undefined,
  duration: typeof song.duration === 'string' ? song.duration : '',
  hotCues: Array.isArray(song.hotCues) ? song.hotCues.map((cue) => ({ ...cue })) : [],
  memoryCues: Array.isArray(song.memoryCues) ? song.memoryCues.map((cue) => ({ ...cue })) : [],
  setItemId: typeof song.setItemId === 'string' ? song.setItemId : undefined
})

const buildJobId = () =>
  `rekordbox-desktop-playlist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const openTargetDialog = async (params: {
  title: string
  defaultPlaylistName: string
  trackCount?: number
}) => {
  const result = await rekordboxDesktopTargetDialog({
    dialogTitle: params.title,
    defaultPlaylistName: params.defaultPlaylistName,
    trackCount: params.trackCount
  })
  if (result === 'cancel') return null
  return result.target
}

const resolveTargetName = (target: RekordboxDesktopPlaylistWriteTarget) =>
  target.mode === 'append'
    ? String(target.playlistName || '').trim() || String(target.playlistId)
    : target.playlistName

const refreshDesktopTreeAfterSuccess = async (summary: RekordboxDesktopPlaylistSuccessSummary) => {
  clearRekordboxSourceCachesByKind('desktop')
  const runtime = useRuntimeStore()
  if (runtime.pioneerDeviceLibrary.selectedSourceKind !== 'desktop') return

  try {
    const result = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'load-tree')
    )) as {
      treeNodes?: IPioneerPlaylistTreeNode[]
    }
    const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
    const sourceCacheKey = buildRekordboxSourceCacheKey({
      sourceKind: 'desktop',
      sourceKey: runtime.pioneerDeviceLibrary.selectedSourceKey,
      rootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
      libraryType: runtime.pioneerDeviceLibrary.selectedLibraryType || 'masterDb'
    })
    setCachedRekordboxSourceTree(sourceCacheKey, treeNodes, {
      selectedPlaylistId: summary.playlistId
    })
    runtime.pioneerDeviceLibrary.treeNodes = treeNodes
    runtime.pioneerDeviceLibrary.selectedPlaylistId = summary.playlistId
    runtime.pioneerDeviceLibrary.loading = false
  } catch {}
}

const showSuccessSummary = async (
  summary: RekordboxDesktopPlaylistSuccessSummary,
  removedSourceFilePaths?: string[]
) => {
  await refreshDesktopTreeAfterSuccess(summary)
  const lines = [
    t('rekordboxDesktop.successPlaylistName', { name: summary.playlistName }),
    t('rekordboxDesktop.successTrackCount', { count: summary.trackCount }),
    t('rekordboxDesktop.successAddedToPlaylist', { count: summary.addedToPlaylistCount }),
    t('rekordboxDesktop.successSkippedDuplicates', { count: summary.skippedDuplicateCount }),
    t('rekordboxDesktop.successAddedToCollection', { count: summary.addedToCollectionCount }),
    t('rekordboxDesktop.successReusedCollection', { count: summary.reusedCollectionCount })
  ]
  if (Array.isArray(removedSourceFilePaths) && removedSourceFilePaths.length > 0) {
    lines.push(
      t('rekordboxDesktop.successDeletedSourceTracks', { count: removedSourceFilePaths.length })
    )
  }
  await confirm({
    title:
      summary.mode === 'append'
        ? t('rekordboxDesktop.appendSuccessTitle')
        : t('rekordboxDesktop.successTitle'),
    content: lines,
    confirmShow: false,
    innerHeight: 0
  })
}

const showFailureSummary = async (params: { errorMessage: string; logPath?: string }) => {
  const lines = [t('rekordboxDesktop.failedReason', { message: params.errorMessage })]
  if (params.logPath) {
    lines.push(t('rekordboxDesktop.failureLogHint', { path: params.logPath }))
  }
  await confirm({
    title: t('rekordboxDesktop.failureTitle'),
    content: lines,
    confirmShow: false,
    innerWidth: 620,
    innerHeight: 0,
    textAlign: 'left',
    canCopyText: Boolean(params.logPath)
  })
}

const chooseSourceRetentionMode = async (params: {
  target: RekordboxDesktopPlaylistWriteTarget
  trackCount?: number
  storageDir: string
}) => {
  const content = [
    params.target.mode === 'append'
      ? t('rekordboxDesktop.confirmAppendPlaylistName', {
          name: resolveTargetName(params.target)
        })
      : t('rekordboxDesktop.confirmPlaylistName', { name: resolveTargetName(params.target) }),
    typeof params.trackCount === 'number' && params.trackCount > 0
      ? t('rekordboxDesktop.confirmTrackCount', { count: params.trackCount })
      : t('rekordboxDesktop.confirmTrackCountUnknown'),
    t('rekordboxDesktop.storageDirConfirmLine', { path: params.storageDir }),
    t('rekordboxDesktop.keepSourceQuestion')
  ]

  return await choiceDialog({
    title: t('rekordboxDesktop.confirmTitle'),
    content,
    options: [
      { key: 'enter', label: t('rekordboxDesktop.keepSourceTracks') },
      { key: 'reset', label: t('rekordboxDesktop.deleteSourceTracksToRecycleBin') },
      { key: 'cancel', label: t('common.cancel') }
    ],
    innerWidth: 620,
    innerHeight: 260
  })
}

const collectPlaylistTrackInputs = async (params: {
  songListPath: string
  songListUUID: string
}): Promise<RekordboxDesktopPlaylistTrackInput[]> => {
  const result = (await window.electron.ipcRenderer.invoke(
    'scanSongList',
    params.songListPath,
    params.songListUUID
  )) as {
    scanData?: ISongInfo[]
  } | null
  const scanData = Array.isArray(result?.scanData) ? result.scanData : []
  return sortByPlaylistTrackNumber(scanData).map((item) => buildTrackInput(item))
}

const cleanupCopiedTracks = async (filePaths: string[]) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  try {
    await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'cleanup-copied-tracks'),
      {
        filePaths
      } satisfies RekordboxDesktopCleanupCopiedTracksRequest
    )
  } catch {}
}

const deleteSourceTracksAfterWrite = async (params: {
  sourceFilePaths: string[]
  setItemIds?: string[]
  deletePayload?: RekordboxDesktopDeletePayload
}) => {
  const setItemIds = Array.isArray(params.setItemIds)
    ? params.setItemIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  if (setItemIds.length > 0) {
    const summary = (await window.electron.ipcRenderer.invoke(
      'setList:recycle-item-files',
      setItemIds
    )) as {
      success?: number
      failed?: number
      removedPaths?: string[]
      removedSetItemIds?: string[]
    }
    const failed = Number(summary?.failed || 0)
    if (failed > 0) {
      await confirm({
        title: t('rekordboxDesktop.deleteSourceFailedTitle'),
        content: [
          t('rekordboxDesktop.deleteSourceSuccessCount', { count: Number(summary?.success || 0) }),
          t('rekordboxDesktop.deleteSourceFailedCount', { count: failed })
        ],
        confirmShow: false,
        innerHeight: 0
      })
    }
    return {
      removedPaths: Array.isArray(summary?.removedPaths) ? summary.removedPaths : [],
      removedSetItemIds: Array.isArray(summary?.removedSetItemIds) ? summary.removedSetItemIds : []
    }
  }

  const payload =
    params.deletePayload?.songListPath || params.deletePayload?.sourceType
      ? {
          filePaths: params.sourceFilePaths,
          songListPath: params.deletePayload?.songListPath,
          sourceType: params.deletePayload?.sourceType
        }
      : params.sourceFilePaths
  const summary = await delSongsViaSend(payload)
  const removedPaths = Array.isArray(summary?.removedPaths) ? summary.removedPaths : []
  const failed = Number(summary?.failed || 0)
  if (failed > 0) {
    await confirm({
      title: t('rekordboxDesktop.deleteSourceFailedTitle'),
      content: [
        t('rekordboxDesktop.deleteSourceSuccessCount', { count: Number(summary?.success || 0) }),
        t('rekordboxDesktop.deleteSourceFailedCount', { count: failed })
      ],
      confirmShow: false,
      innerHeight: 0
    })
  }
  return { removedPaths, removedSetItemIds: [] }
}

const runCreateRequest = async (request: RekordboxDesktopPlaylistRequest) => {
  if (!(await ensureRekordboxDesktopWriteAvailable('write'))) {
    return null
  }

  try {
    const response = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'create-playlist'),
      request
    )) as RekordboxDesktopPlaylistResponse
    if (response.ok) {
      return response.summary
    }
    await showFailureSummary(response.summary)
    return null
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error || t('common.unknownError'))
    await showFailureSummary({ errorMessage: message })
    return null
  }
}

export const openRekordboxDesktopPlaylistForSelectedTracks = async (params: {
  tracks: ISongInfo[]
  songListUUID: string
  playlistName?: string
  deletePayload?: RekordboxDesktopDeletePayload
  forceKeepSourceTracks?: boolean
}): Promise<RekordboxDesktopPlaylistWriteResult | null> => {
  if (!Array.isArray(params.tracks) || params.tracks.length === 0) {
    await confirm({
      title: t('rekordboxDesktop.failureTitle'),
      content: [t('rekordboxDesktop.noTracksToImport')],
      confirmShow: false
    })
    return null
  }

  const target = await openTargetDialog({
    title: t('rekordboxDesktop.dialogTitleTracks'),
    defaultPlaylistName:
      String(params.playlistName || '').trim() || buildDefaultSelectedTracksPlaylistName(),
    trackCount: params.tracks.length
  })
  if (!target) return null

  const storageDir = await ensureRekordboxDesktopStorageDirConfigured()
  if (!storageDir) return null

  const retentionChoice = params.forceKeepSourceTracks
    ? 'enter'
    : await chooseSourceRetentionMode({
        target,
        trackCount: params.tracks.length,
        storageDir
      })
  if (retentionChoice === 'cancel') return null
  const deleteSourceAfterWrite = retentionChoice === 'reset'

  const originalTracks = sortByPlaylistTrackNumber(params.tracks).map((track) =>
    buildTrackInput(track)
  )
  if (!(await ensureRekordboxDesktopWriteAvailable('write'))) {
    return null
  }
  const copyResponse = await copyTracksToStorage({
    targetRootDir: storageDir,
    tracks: originalTracks
  })
  if (!copyResponse.ok) {
    await showFailureSummary(copyResponse.summary)
    return null
  }

  const summary = await runCreateRequest({
    jobId: buildJobId(),
    target,
    source: {
      kind: 'selected-tracks',
      songListUUID: params.songListUUID,
      tracks: copyResponse.summary.copiedTracks
    }
  })
  if (!summary) {
    await cleanupCopiedTracks(copyResponse.summary.copiedTracks.map((item) => item.filePath))
    return null
  }

  let removedSourceFilePaths: string[] = []
  let removedSetItemIds: string[] = []
  if (deleteSourceAfterWrite && copyResponse.summary.sourceFilePaths.length > 0) {
    const deleteSummary = await deleteSourceTracksAfterWrite({
      sourceFilePaths: copyResponse.summary.sourceFilePaths,
      setItemIds: originalTracks
        .map((track) => track.setItemId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
      deletePayload: params.deletePayload
    })
    removedSourceFilePaths = deleteSummary.removedPaths
    removedSetItemIds = deleteSummary.removedSetItemIds
  }

  await showSuccessSummary(summary, removedSourceFilePaths)
  return {
    ...summary,
    removedSourceFilePaths,
    removedSetItemIds
  }
}

export const openRekordboxDesktopPlaylistForPlaylist = async (params: {
  songListUUID: string
  songListPath: string
  playlistName: string
  deletePayload?: RekordboxDesktopDeletePayload
}): Promise<RekordboxDesktopPlaylistWriteResult | null> => {
  const defaultPlaylistName =
    String(params.playlistName || '').trim() || buildDefaultSelectedTracksPlaylistName()
  const target = await openTargetDialog({
    title: t('rekordboxDesktop.dialogTitlePlaylist'),
    defaultPlaylistName
  })
  if (!target) return null

  const storageDir = await ensureRekordboxDesktopStorageDirConfigured()
  if (!storageDir) return null

  const originalTracks = await collectPlaylistTrackInputs({
    songListPath: params.songListPath,
    songListUUID: params.songListUUID
  })
  if (originalTracks.length === 0) {
    await confirm({
      title: t('rekordboxDesktop.failureTitle'),
      content: [t('rekordboxDesktop.noTracksToImport')],
      confirmShow: false
    })
    return null
  }

  const retentionChoice = await chooseSourceRetentionMode({
    target,
    trackCount: originalTracks.length,
    storageDir
  })
  if (retentionChoice === 'cancel') return null
  const deleteSourceAfterWrite = retentionChoice === 'reset'

  if (!(await ensureRekordboxDesktopWriteAvailable('write'))) {
    return null
  }
  const copyResponse = await copyTracksToStorage({
    targetRootDir: storageDir,
    tracks: originalTracks
  })
  if (!copyResponse.ok) {
    await showFailureSummary(copyResponse.summary)
    return null
  }

  const summary = await runCreateRequest({
    jobId: buildJobId(),
    target,
    source: {
      kind: 'selected-tracks',
      songListUUID: params.songListUUID,
      tracks: copyResponse.summary.copiedTracks
    }
  })
  if (!summary) {
    await cleanupCopiedTracks(copyResponse.summary.copiedTracks.map((item) => item.filePath))
    return null
  }

  let removedSourceFilePaths: string[] = []
  let removedSetItemIds: string[] = []
  if (deleteSourceAfterWrite && copyResponse.summary.sourceFilePaths.length > 0) {
    const deleteSummary = await deleteSourceTracksAfterWrite({
      sourceFilePaths: copyResponse.summary.sourceFilePaths,
      setItemIds: originalTracks
        .map((track) => track.setItemId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
      deletePayload: params.deletePayload
    })
    removedSourceFilePaths = deleteSummary.removedPaths
    removedSetItemIds = deleteSummary.removedSetItemIds
  }

  await showSuccessSummary(summary, removedSourceFilePaths)
  return {
    ...summary,
    removedSourceFilePaths,
    removedSetItemIds
  }
}
