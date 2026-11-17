import confirm from '@renderer/components/confirmDialog'
import openRekordboxXmlExportDialog from '@renderer/components/rekordboxXmlExportDialog'
import { t } from '@renderer/utils/translate'
import type { ISongInfo } from '../../../types/globals'
import { normalizePlaylistTrackNumber, sortByPlaylistTrackNumber } from '@shared/playlistTrackOrder'
import type {
  RekordboxXmlExportMode,
  RekordboxXmlExportRequest,
  RekordboxXmlExportResponse,
  RekordboxXmlExportSourceLibraryName,
  RekordboxXmlExportSuccessSummary,
  RekordboxXmlExportTrackInput
} from '@shared/rekordboxXmlExport'

const pad = (value: number) => String(value).padStart(2, '0')

const buildTimestampLabel = () => {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours()
  )}-${pad(now.getMinutes())}`
}

const sanitizeBaseName = (value: string, fallback: string) => {
  const trimmed = String(value || '').trim()
  const stripped = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped || fallback
}

const basename = (value: string) => {
  const normalized = String(value || '').replace(/\\/g, '/')
  const lastSlashIndex = normalized.lastIndexOf('/')
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized
}

const buildSelectedTracksDefaultPlaylistName = () =>
  t('rekordboxXmlExport.defaultPlaylistName', { time: buildTimestampLabel() })

const buildDefaultExportDirName = (playlistName: string) => {
  const baseName = sanitizeBaseName(playlistName, 'Track Studio Export')
  return `${baseName} ${buildTimestampLabel()}`
}

const buildDefaultXmlFileName = (playlistName: string) => {
  const baseName = sanitizeBaseName(playlistName, 'Track Studio Export')
  return `${baseName}.xml`
}

const buildTrackInput = (song: ISongInfo): RekordboxXmlExportTrackInput => ({
  filePath: song.filePath,
  displayName: String(song.title || song.fileName || basename(song.filePath)).trim(),
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
  `rekordbox-xml-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const openExportLocation = (xmlPath: string) => {
  if (!xmlPath) return
  window.electron.ipcRenderer.send('show-item-in-folder', xmlPath)
}

const showSuccessSummary = async (summary: RekordboxXmlExportSuccessSummary) => {
  openExportLocation(summary.xmlPath)
  await confirm({
    title: t('rekordboxXmlExport.successTitle'),
    content: [
      t('rekordboxXmlExport.successMode', {
        mode:
          summary.mode === 'move'
            ? t('rekordboxXmlExport.modeMove')
            : t('rekordboxXmlExport.modeCopy')
      }),
      t('rekordboxXmlExport.successTrackCount', { count: summary.trackCount }),
      t('rekordboxXmlExport.successExportDir', { path: summary.exportDirPath }),
      t('rekordboxXmlExport.successXmlPath', { path: summary.xmlPath })
    ],
    confirmShow: false,
    innerWidth: 620,
    innerHeight: 320,
    textAlign: 'left',
    canCopyText: true
  })
}

const showFailureSummary = async (response: Extract<RekordboxXmlExportResponse, { ok: false }>) => {
  const lines: string[] = []
  if (response.summary.cancelled) {
    lines.push(t('rekordboxXmlExport.failedCancelled'))
  }
  lines.push(t('rekordboxXmlExport.failedReason', { message: response.summary.errorMessage }))
  lines.push(
    response.summary.rolledBack
      ? t('rekordboxXmlExport.rollbackDone')
      : t('rekordboxXmlExport.rollbackBestEffort')
  )
  lines.push(t('rekordboxXmlExport.failureLibraryUnchanged'))
  lines.push(t('rekordboxXmlExport.failureLogHint', { path: response.summary.logPath }))
  await confirm({
    title: t('rekordboxXmlExport.failureTitle'),
    content: lines,
    confirmShow: false,
    innerWidth: 620,
    innerHeight: 340,
    textAlign: 'left',
    canCopyText: true
  })
}

const runExportRequest = async (request: RekordboxXmlExportRequest) => {
  try {
    const response = (await window.electron.ipcRenderer.invoke(
      'rekordbox-xml-export:run',
      request
    )) as RekordboxXmlExportResponse
    if (response.ok) {
      await showSuccessSummary(response.summary)
      return response.summary
    }
    await showFailureSummary(response)
    return null
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error || t('common.unknownError'))
    await confirm({
      title: t('rekordboxXmlExport.failureTitle'),
      content: [t('rekordboxXmlExport.failedReason', { message })],
      confirmShow: false
    })
    return null
  }
}

export const openRekordboxXmlExportForSelectedTracks = async (params: {
  tracks: ISongInfo[]
  sourceLibraryName: RekordboxXmlExportSourceLibraryName
  songListUUID: string
  playlistName?: string
  lockMode?: RekordboxXmlExportMode
  prepareTracks?: (tracks: ISongInfo[]) => Promise<ISongInfo[] | null>
}) => {
  const orderedTracks = sortByPlaylistTrackNumber(params.tracks)
  const defaultPlaylistName =
    String(params.playlistName || '').trim() || buildSelectedTracksDefaultPlaylistName()
  const dialogResult = await openRekordboxXmlExportDialog({
    dialogTitle: t('rekordboxXmlExport.dialogTitleTracks'),
    defaultExportDirName: buildDefaultExportDirName(defaultPlaylistName),
    defaultXmlFileName: buildDefaultXmlFileName(defaultPlaylistName),
    defaultXmlPlaylistName: defaultPlaylistName,
    lockMode: params.lockMode
  })
  if (dialogResult === 'cancel') return null

  let exportTracks = orderedTracks
  if (params.prepareTracks) {
    const prepared = await params.prepareTracks(orderedTracks)
    if (!prepared || prepared.length === 0) return null
    exportTracks = prepared
  }

  return await runExportRequest({
    jobId: buildJobId(),
    targetRootDir: dialogResult.targetRootDir,
    exportDirName: dialogResult.exportDirName,
    xmlFileName: dialogResult.xmlFileName,
    xmlPlaylistName: dialogResult.xmlPlaylistName,
    mode: params.lockMode || dialogResult.mode,
    sourceLibraryName: params.sourceLibraryName,
    source: {
      kind: 'selected-tracks',
      songListUUID: params.songListUUID,
      tracks: exportTracks.map(buildTrackInput)
    }
  })
}

export const openRekordboxXmlExportForPlaylist = async (params: {
  sourceLibraryName: RekordboxXmlExportSourceLibraryName
  songListUUID: string
  songListPath: string
  playlistName: string
}) => {
  const defaultPlaylistName = String(params.playlistName || '').trim() || t('tracks.title')
  const dialogResult = await openRekordboxXmlExportDialog({
    dialogTitle: t('rekordboxXmlExport.dialogTitlePlaylist'),
    defaultExportDirName: buildDefaultExportDirName(defaultPlaylistName),
    defaultXmlFileName: buildDefaultXmlFileName(defaultPlaylistName),
    defaultXmlPlaylistName: defaultPlaylistName
  })
  if (dialogResult === 'cancel') return null

  return await runExportRequest({
    jobId: buildJobId(),
    targetRootDir: dialogResult.targetRootDir,
    exportDirName: dialogResult.exportDirName,
    xmlFileName: dialogResult.xmlFileName,
    xmlPlaylistName: dialogResult.xmlPlaylistName,
    mode: dialogResult.mode,
    sourceLibraryName: params.sourceLibraryName,
    source: {
      kind: 'playlist',
      songListUUID: params.songListUUID,
      songListPath: params.songListPath,
      playlistName: params.playlistName
    }
  })
}
