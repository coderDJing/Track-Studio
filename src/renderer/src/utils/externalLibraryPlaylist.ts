import confirm from '@renderer/components/confirmDialog'
import externalLibraryTargetDialog from '@renderer/components/externalLibraryTargetDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import type { ExternalLibraryMutationResponse, ExternalLibraryKind } from '@shared/externalLibrary'
import type { TraktorTrackMetadata } from '@shared/externalLibrary'
import type { ExternalLibrarySourceProbe } from '@shared/externalLibrary'
import type {
  RekordboxDesktopPlaylistSuccessSummary,
  RekordboxDesktopPlaylistTrackInput
} from '@shared/rekordboxDesktopPlaylist'
import type { ISongInfo } from '../../../types/globals'
import {
  copyTracksToStorage,
  ensureSeratoTrackStorageDirConfigured,
  ensureTraktorTrackStorageDirConfigured
} from '@renderer/utils/rekordboxTrackStorage'

type ExternalLibraryPlaylistWriteResult = ExternalLibraryMutationResponse['summary'] &
  RekordboxDesktopPlaylistSuccessSummary & {
    removedSourceFilePaths?: string[]
    removedSetItemIds?: string[]
  }

const parseDurationSec = (value: string) => {
  const parts = value.split(':').map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined
  return parts.reduce((total, part) => total * 60 + part, 0)
}

export const openExternalLibraryPlaylistForSelectedTracks = async (params: {
  tracks: ISongInfo[]
  kind?: ExternalLibraryKind
}): Promise<ExternalLibraryPlaylistWriteResult | null> => {
  const runtime = useRuntimeStore()
  const kind: ExternalLibraryKind = params.kind || 'serato'
  const failureTitle = t(
    kind === 'serato' ? 'library.seratoFailureTitle' : 'library.traktorFailureTitle'
  )
  let sourcePath =
    runtime.externalDjLibrary.selectedKind === kind
      ? String(runtime.externalDjLibrary.selectedSourcePath || '').trim()
      : ''
  if (!sourcePath) {
    const probes = (await window.electron.ipcRenderer.invoke(
      'external-library:probe'
    )) as ExternalLibrarySourceProbe[]
    sourcePath = String(
      probes.find((item) => item.kind === kind && item.available)?.sourcePath || ''
    ).trim()
  }
  const trackPaths = Array.from(
    new Set(params.tracks.map((track) => String(track.filePath || '').trim()).filter(Boolean))
  )
  if (!sourcePath) {
    await confirm({
      title: failureTitle,
      content: [
        t(kind === 'serato' ? 'library.seratoLibraryNotFound' : 'library.traktorLibraryNotFound')
      ],
      confirmShow: false
    })
    return null
  }
  if (!trackPaths.length) return null

  try {
    await window.electron.ipcRenderer.invoke('external-library:check-write', {
      kind,
      path: sourcePath
    })
  } catch (error) {
    await confirm({
      title: failureTitle,
      content: [error instanceof Error ? error.message : String(error)],
      confirmShow: false
    })
    return null
  }

  const target = await externalLibraryTargetDialog({
    kind,
    sourcePath,
    dialogTitle: t(
      kind === 'serato' ? 'library.externalWriteDialogTitle' : 'library.traktorWriteDialogTitle'
    ),
    defaultPlaylistName: t('library.externalWriteDefaultPlaylistName'),
    trackCount: trackPaths.length
  })
  if (target === 'cancel') return null

  const storageDir = await (kind === 'serato'
    ? ensureSeratoTrackStorageDirConfigured()
    : ensureTraktorTrackStorageDirConfigured())
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
      title: failureTitle,
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

  const trackMetadata: TraktorTrackMetadata[] = params.tracks.map((track, index) => ({
    storedPath: String(copyResponse.summary.copiedTracks[index]?.filePath || '').trim(),
    title: track.title || undefined,
    artist: track.artist || undefined,
    album: track.album || undefined,
    genre: track.genre || undefined,
    key: track.key,
    bpm: track.bpm,
    durationSec: parseDurationSec(track.duration),
    bitrate: track.bitrate,
    hotCues: Array.isArray(track.hotCues)
      ? track.hotCues.map((cue) => ({
          slot: cue.slot,
          sec: cue.sec,
          label: cue.label,
          isLoop: cue.isLoop,
          loopEndSec: cue.loopEndSec
        }))
      : [],
    memoryCues: Array.isArray(track.memoryCues)
      ? track.memoryCues.map((cue) => ({
          sec: cue.sec,
          comment: cue.comment,
          isLoop: cue.isLoop,
          loopEndSec: cue.loopEndSec
        }))
      : []
  }))

  const response = (await window.electron.ipcRenderer.invoke('external-library:mutate', {
    kind,
    path: sourcePath,
    operation: 'write-tracks',
    externalId: target.target.externalId,
    trackPaths: storedTrackPaths,
    trackMetadata: kind === 'traktor' ? trackMetadata : undefined,
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
      title: failureTitle,
      content: [
        t('library.externalLibraryFailedReason', { message: response.summary.errorMessage })
      ],
      confirmShow: false
    })
    return null
  }
  await confirm({
    title: t(
      kind === 'serato' ? 'library.externalWriteSuccessTitle' : 'library.traktorWriteSuccessTitle'
    ),
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
