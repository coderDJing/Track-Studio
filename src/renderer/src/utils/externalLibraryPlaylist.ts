import confirm from '@renderer/components/confirmDialog'
import externalLibraryTargetDialog from '@renderer/components/externalLibraryTargetDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import type { ExternalLibraryMutationResponse, ExternalLibraryKind } from '@shared/externalLibrary'
import type { ExternalLibrarySourceProbe } from '@shared/externalLibrary'
import type {
  RekordboxDesktopPlaylistSuccessSummary,
  RekordboxDesktopPlaylistTrackInput
} from '@shared/rekordboxDesktopPlaylist'
import type { ISongInfo } from '../../../types/globals'
import {
  copyTracksToStorage,
  ensureSeratoTrackStorageDirConfigured
} from '@renderer/utils/rekordboxTrackStorage'

type ExternalLibraryPlaylistWriteResult = ExternalLibraryMutationResponse['summary'] &
  RekordboxDesktopPlaylistSuccessSummary & {
    removedSourceFilePaths?: string[]
    removedSetItemIds?: string[]
  }

export const openExternalLibraryPlaylistForSelectedTracks = async (params: {
  tracks: ISongInfo[]
}): Promise<ExternalLibraryPlaylistWriteResult | null> => {
  const runtime = useRuntimeStore()
  const kind: ExternalLibraryKind = 'serato'
  let sourcePath =
    runtime.externalDjLibrary.selectedKind === 'serato'
      ? String(runtime.externalDjLibrary.selectedSourcePath || '').trim()
      : ''
  if (!sourcePath) {
    const probes = (await window.electron.ipcRenderer.invoke(
      'external-library:probe'
    )) as ExternalLibrarySourceProbe[]
    sourcePath = String(
      probes.find((item) => item.kind === 'serato' && item.available)?.sourcePath || ''
    ).trim()
  }
  const trackPaths = Array.from(
    new Set(params.tracks.map((track) => String(track.filePath || '').trim()).filter(Boolean))
  )
  if (!sourcePath) {
    await confirm({
      title: t('library.externalLibraryFailureTitle'),
      content: [t('library.seratoLibraryNotFound')],
      confirmShow: false
    })
    return null
  }
  if (!trackPaths.length) return null

  const target = await externalLibraryTargetDialog({
    kind,
    sourcePath,
    dialogTitle: t('library.externalWriteDialogTitle'),
    defaultPlaylistName: t('library.externalWriteDefaultPlaylistName'),
    trackCount: trackPaths.length
  })
  if (target === 'cancel') return null

  const storageDir = await ensureSeratoTrackStorageDirConfigured()
  if (!storageDir) return null
  const storageTracks: RekordboxDesktopPlaylistTrackInput[] = params.tracks.map((track) => ({
    filePath: track.filePath,
    displayName: String(track.title || track.fileName || '').trim(),
    artist: typeof track.artist === 'string' ? track.artist : '',
    album: typeof track.album === 'string' ? track.album : '',
    genre: typeof track.genre === 'string' ? track.genre : '',
    label: typeof track.label === 'string' ? track.label : '',
    duration: typeof track.duration === 'string' ? track.duration : '',
    hotCues: Array.isArray(track.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : [],
    memoryCues: Array.isArray(track.memoryCues) ? track.memoryCues.map((cue) => ({ ...cue })) : []
  }))
  const copyResponse = await copyTracksToStorage({
    targetRootDir: storageDir,
    tracks: storageTracks
  })
  if (!copyResponse.ok) {
    await confirm({
      title: t('library.externalLibraryFailureTitle'),
      content: [
        t('library.externalLibraryFailedReason', { message: copyResponse.summary.errorMessage })
      ],
      confirmShow: false
    })
    return null
  }
  const storedTrackPaths = copyResponse.summary.copiedTracks
    .map((track) => String(track.filePath || '').trim())
    .filter(Boolean)

  const response = (await window.electron.ipcRenderer.invoke('external-library:mutate', {
    kind,
    path: sourcePath,
    operation: 'write-tracks',
    externalId: target.target.externalId,
    trackPaths: storedTrackPaths,
    trackPathMappings: params.tracks.map((track, index) => ({
      sourcePath: track.filePath,
      storedPath: String(copyResponse.summary.copiedTracks[index]?.filePath || '').trim()
    })),
    trackCueMappings: params.tracks.map((track, index) => ({
      storedPath: String(copyResponse.summary.copiedTracks[index]?.filePath || '').trim(),
      hotCues: Array.isArray(track.hotCues) ? track.hotCues.map((cue) => ({ ...cue })) : []
    }))
  })) as ExternalLibraryMutationResponse
  if (!response.ok) {
    await confirm({
      title: t('library.externalLibraryFailureTitle'),
      content: [
        t('library.externalLibraryFailedReason', { message: response.summary.errorMessage })
      ],
      confirmShow: false
    })
    return null
  }
  await confirm({
    title: t('library.externalWriteSuccessTitle'),
    content: [
      t('library.externalWriteSuccessLine', {
        name: target.target.playlistName || '',
        added: Number(response.summary.addedCount || 0),
        skipped: Number(response.summary.skippedDuplicateCount || 0)
      })
    ],
    confirmShow: false
  })
  return {
    ...response.summary,
    mode: 'append',
    playlistId: Number(response.summary.playlistId || 0),
    playlistName: target.target.playlistName || '',
    trackCount: trackPaths.length,
    addedToPlaylistCount: Number(response.summary.addedCount || 0),
    skippedDuplicateCount: Number(response.summary.skippedDuplicateCount || 0),
    addedToCollectionCount: 0,
    reusedCollectionCount: 0
  }
}
