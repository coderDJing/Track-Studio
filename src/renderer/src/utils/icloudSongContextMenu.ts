import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import confirm from '@renderer/components/confirmDialog'
import exportDialog from '@renderer/components/exportDialog'
import openConvertDialog from '@renderer/components/audioConvertDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog'
import { createMusicSearchMenuItems } from '@renderer/utils/musicSearch'
import { appendExternalSongsToSet } from '@renderer/utils/setCustody'
import { appendDownloadedFilesToMixtape } from '@renderer/utils/mixtapePlaylistAppend'
import { openRekordboxDesktopPlaylistForSelectedTracks } from '@renderer/utils/rekordboxDesktopPlaylist'
import { openRekordboxXmlExportForSelectedTracks } from '@renderer/utils/rekordboxXmlExport'
import { openExternalLibraryPlaylistForSelectedTracks } from '@renderer/utils/externalLibraryPlaylist'
import { openBatchSimilarTracksDialogForSeeds } from '@renderer/utils/similarTracksActions'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import { startBpmFix } from '@renderer/utils/bpmFixActions'
import { delSongsViaSend } from '@renderer/utils/recycleBinActions'
import libraryUtils from '@renderer/utils/libraryUtils'
import { promptTrackAnalysisSelection } from '@renderer/utils/trackReanalysis'
import { showTrackReanalysisRuntimeBlockedHint } from '@renderer/utils/trackReanalysisRuntimeGate'
import { t } from '@renderer/utils/translate'
import { icloudLocalActionError, prepareIcloudSongsForLocalAction } from './icloudPrepareLocal'
import type { ConvertOptions } from '@renderer/components/audioConvertDialog.types'
import type { IMenu, ISongInfo } from '../../../types/globals'

const ICLOUD_SONG_LIST_UUID = 'icloud-music'

/**
 * 普通列表里没有「移动到歌单」这一项；移动进歌单就是移动到筛选库 / 精选库。
 * iCloud 的重新分析走同一套曲库分析，只是先把选中文件落到本机。
 */
export const ICLOUD_FORBIDDEN_SONG_MENU_NAMES = ['library.moveToPlaylist'] as const

export function writesInsideIcloudDrive(filePath: string | undefined) {
  const value = String(filePath || '').replace(/\\/g, '/')
  return value.includes('com~apple~CloudDocs') || value.includes('/Mobile Documents/')
}

export function createIcloudSongMenuArr(options?: { canRemoveDownload?: boolean }): IMenu[][] {
  return [
    [{ menuName: 'icloud.play' }],
    [{ menuName: 'tracks.exportTracks' }],
    [
      { menuName: 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks' },
      { menuName: 'rekordboxXmlExport.menuExportSelectedTracks' },
      { menuName: 'library.writeToSeratoPlaylist' },
      { menuName: 'library.writeToTraktorPlaylist' }
    ],
    [
      { menuName: 'library.moveToFilter' },
      { menuName: 'library.moveToCurated' },
      { menuName: 'library.copyToFilter' },
      { menuName: 'library.copyToCurated' },
      { menuName: 'library.addToSet' },
      { menuName: 'library.addToMixtape' }
    ],
    [
      { menuName: 'tracks.deleteTracks', shortcutKey: 'Delete' },
      { menuName: 'tracks.deleteAllAbove' }
    ],
    [{ menuName: 'tracks.showInFileExplorer' }],
    ...(options?.canRemoveDownload ? [[{ menuName: 'icloud.removeDownload' }]] : []),
    createMusicSearchMenuItems(),
    [{ menuName: 'similarTracks.menu' }],
    [{ menuName: 'metadata.autoFillMenu' }, { menuName: 'tracks.editMetadata' }],
    [{ menuName: 'fingerprints.analyzeAndAdd' }],
    [{ menuName: 'tracks.clearTrackCache' }],
    [{ menuName: 'tracks.convertFormat' }],
    [{ menuName: 'stemSeparation.menu' }, { menuName: 'bpmFix.menu' }]
  ]
}

const errorText = (code: string) => {
  const key = `icloud.errors.${code}`
  const label = t(key)
  return !label || label === key ? t('icloud.errors.failed') : label
}

const showHint = async (message: string) => {
  await confirm({
    title: t('dialog.hint'),
    content: [message],
    confirmShow: false
  })
}

const reportFailure = async (songs: ISongInfo[]) => {
  const code = icloudLocalActionError(songs)
  if (!code) return
  await showHint(errorText(code))
}

const runAction = async (work: () => Promise<unknown>) => {
  try {
    await work()
    return true
  } catch (reason) {
    await showHint(
      reason instanceof Error && reason.message ? reason.message : t('icloud.errors.failed')
    )
    return false
  }
}

const acceptRisk = async (key: string) =>
  (await confirm({ title: t('dialog.hint'), content: [t(key)] })) === 'confirm'

const prepareSelected = async (songs: ISongInfo[], onLocalized?: (relative: string) => void) => {
  const prepared = await prepareIcloudSongsForLocalAction(songs)
  if (!prepared) {
    await reportFailure(songs)
    return null
  }
  for (const song of prepared) {
    const relative = song.icloudOrigin?.relativePath
    if (relative) onLocalized?.(relative)
  }
  return prepared
}

const directoryOf = (filePath: string) => filePath.replace(/[/\\][^/\\]+$/, '')

const relativePaths = (songs: ISongInfo[]) =>
  songs
    .map((song) => song.icloudOrigin?.relativePath)
    .filter((relative): relative is string => Boolean(relative))

const anchorSong = (songs: ISongInfo[], anchor?: ISongInfo) =>
  anchor?.icloudOrigin ? anchor : songs[0]

export function songsAboveAnchor(anchor: ISongInfo | undefined, visibleSongs: ISongInfo[]) {
  if (!anchor) return []
  const index = visibleSongs.findIndex((song) =>
    sameRendererFilePath(song.filePath, anchor.filePath)
  )
  if (index <= 0) return []
  return visibleSongs.slice(0, index).filter((song) => song?.icloudOrigin)
}

const extensionsOf = (songs: ISongInfo[]) =>
  Array.from(
    new Set(
      songs
        .map((song) => {
          const name = song.icloudOrigin?.relativePath || song.fileName || song.filePath
          return (name.match(/(\.[^./\\]+)$/)?.[1] || '').toLowerCase()
        })
        .filter(Boolean)
    )
  )

function isConvertChoice(value: unknown): value is ConvertOptions {
  if (!value || typeof value !== 'object') return false
  return 'strategy' in value && !('files' in value)
}

export async function handleIcloudSongMenuChoice(params: {
  menuName: string
  songs: ISongInfo[]
  anchor?: ISongInfo
  visibleSongs?: ISongInfo[]
  onLocalized?: (relative: string) => void
  onChanged?: (change?: { stopRelativePaths?: string[] }) => void
  localRelativePaths?: string[]
  rootToken?: string
  onEvicted?: (relative: string) => void
  onAnalysisBound?: (items: Array<{ relative: string; filePath: string }>) => void
}) {
  const songs = params.songs.filter((song) => song?.icloudOrigin)
  if (params.menuName === 'icloud.removeDownload') {
    const local = new Set(params.localRelativePaths || [])
    const targets = songs.filter((song) => local.has(song.icloudOrigin?.relativePath || ''))
    if (!targets.length || !params.rootToken) return
    const response = (await window.electron.ipcRenderer.invoke(
      'icloud:evict-local',
      targets.map((song) => song.icloudOrigin?.relativePath),
      params.rootToken
    )) as {
      ok?: boolean
      error?: string
      value?: Array<{ relative?: string; status?: string; error?: string }>
    }
    if (!response?.ok || !Array.isArray(response.value)) {
      await showHint(errorText(response?.error || 'failed'))
      return
    }
    for (const item of response.value) {
      if (item.status === 'evicted' && item.relative) params.onEvicted?.(item.relative)
    }
    const failed = response.value.find((item) => item.status === 'failed' && item.error)
    if (failed?.error) {
      const known = [
        'uploading',
        'notUploaded',
        'pinned',
        'playing',
        'notCloud',
        'failed',
        'boundary',
        'offline',
        'timeout',
        'permission',
        'unavailable'
      ]
      await showHint(
        known.includes(failed.error) ? t(`icloud.errors.${failed.error}`) : errorText(failed.error)
      )
    }
    return
  }
  if (
    !songs.length &&
    params.menuName !== 'tracks.deleteAllAbove' &&
    params.menuName !== 'tracks.editMetadata' &&
    params.menuName !== 'stemSeparation.menu'
  )
    return

  if (params.menuName === 'tracks.exportTracks') {
    const exportResult = await exportDialog({
      title: 'tracks.title',
      forceCopyOnly: true
    })
    if (exportResult === 'cancel') return
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    await runAction(async () => {
      await window.electron.ipcRenderer.invoke(
        'exportSongsToDir',
        exportResult.folderPathVal,
        false,
        JSON.parse(JSON.stringify(prepared))
      )
    })
    return
  }

  if (params.menuName === 'library.addToSet') {
    const choice = await selectSongListDialog({ libraryName: 'SetLibrary', actionMode: 'copy' })
    if (choice === 'cancel') return
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    await runAction(() =>
      appendExternalSongsToSet({
        playlistUuid: choice.uuid,
        items: prepared.map((song) => ({
          song,
          originPathSnapshot: song.icloudOrigin?.relativePath
        }))
      })
    )
    return
  }

  if (params.menuName === 'library.addToMixtape') {
    const choice = await selectSongListDialog({
      libraryName: 'MixtapeLibrary',
      actionMode: 'copy'
    })
    if (choice === 'cancel') return
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    await runAction(() =>
      appendDownloadedFilesToMixtape({
        playlistId: choice.uuid,
        entries: prepared.map((song) => ({ filePath: song.filePath, song }))
      })
    )
    return
  }

  if (params.menuName === 'similarTracks.menu') {
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    await runAction(() => openBatchSimilarTracksDialogForSeeds(prepared))
    return
  }

  if (params.menuName === 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks') {
    await runAction(() =>
      openRekordboxDesktopPlaylistForSelectedTracks({
        tracks: songs,
        songListUUID: ICLOUD_SONG_LIST_UUID,
        forceKeepSourceTracks: true,
        prepareTracks: (selected) => prepareSelected(selected, params.onLocalized)
      })
    )
    return
  }

  if (params.menuName === 'rekordboxXmlExport.menuExportSelectedTracks') {
    await runAction(() =>
      openRekordboxXmlExportForSelectedTracks({
        tracks: songs,
        sourceLibraryName: 'IcloudLibrary',
        songListUUID: ICLOUD_SONG_LIST_UUID,
        lockMode: 'copy',
        prepareTracks: (selected) => prepareSelected(selected, params.onLocalized)
      })
    )
    return
  }

  if (
    params.menuName === 'library.writeToSeratoPlaylist' ||
    params.menuName === 'library.writeToTraktorPlaylist'
  ) {
    await runAction(() =>
      openExternalLibraryPlaylistForSelectedTracks({
        tracks: songs,
        kind: params.menuName === 'library.writeToSeratoPlaylist' ? 'serato' : 'traktor',
        prepareTracks: (selected) => prepareSelected(selected, params.onLocalized)
      })
    )
    return
  }

  if (params.menuName === 'tracks.deleteTracks' || params.menuName === 'tracks.deleteAllAbove') {
    const targets =
      params.menuName === 'tracks.deleteAllAbove'
        ? songsAboveAnchor(params.anchor, params.visibleSongs || [])
        : songs
    if (!targets.length) return
    if (!(await acceptRisk('icloud.confirmRemove'))) return
    const prepared = await prepareSelected(targets, params.onLocalized)
    if (!prepared) return
    const summary = await delSongsViaSend({
      filePaths: prepared.map((song) => song.filePath),
      sourceType: 'external'
    })
    if (!summary.success) {
      await showHint(t('icloud.errors.failed'))
      return
    }
    params.onChanged?.({ stopRelativePaths: relativePaths(targets) })
    if (summary.failed) await showHint(t('icloud.errors.failed'))
    return
  }

  if (params.menuName === 'library.moveToFilter' || params.menuName === 'library.moveToCurated') {
    if (!songs.length || !(await acceptRisk('icloud.confirmMove'))) return
    const choice = await selectSongListDialog({
      libraryName: params.menuName === 'library.moveToFilter' ? 'FilterLibrary' : 'CuratedLibrary',
      actionMode: 'move'
    })
    if (choice === 'cancel') return
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    const target = libraryUtils.findDirPathByUuid(choice.uuid)
    if (!target) {
      await showHint(errorText('destination'))
      return
    }
    const moved = await runAction(async () => {
      const summary = (await window.electron.ipcRenderer.invoke(
        'moveSongsToDir',
        prepared.map((song) => song.filePath),
        target,
        { returnSummary: true }
      )) as { movedEntries?: unknown[]; failed?: number } | null
      const count = Array.isArray(summary?.movedEntries) ? summary.movedEntries.length : 0
      if (!count) throw new Error(t('icloud.errors.failed'))
      if (summary?.failed) await showHint(t('icloud.errors.failed'))
    })
    if (moved) params.onChanged?.({ stopRelativePaths: relativePaths(songs) })
    return
  }

  if (params.menuName === 'tracks.editMetadata') {
    const target = anchorSong(songs, params.anchor)
    if (!target?.icloudOrigin || !(await acceptRisk('icloud.confirmRewrite'))) return
    const prepared = await prepareSelected([target], params.onLocalized)
    if (!prepared?.[0]) return
    const { default: openEditMetadataDialog } =
      await import('@renderer/components/editMetadataDialog')
    const result = await openEditMetadataDialog({ filePath: prepared[0].filePath })
    if (result && result !== 'cancel')
      params.onChanged?.({ stopRelativePaths: relativePaths([target]) })
    return
  }

  if (params.menuName === 'metadata.autoFillMenu') {
    if (!songs.length || !(await acceptRisk('icloud.confirmRewrite'))) return
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    let summary: Awaited<ReturnType<typeof invokeMetadataAutoFill>>
    try {
      summary = await invokeMetadataAutoFill(prepared.map((song) => song.filePath))
    } catch (reason) {
      await showHint(
        reason instanceof Error && reason.message ? reason.message : t('icloud.errors.failed')
      )
      return
    }
    if (!summary) {
      await showHint(t('metadata.autoFillNoEligible'))
      return
    }
    const { default: openAutoSummary } =
      await import('@renderer/components/autoMetadataSummaryDialog')
    await openAutoSummary(summary)
    if (summary.items?.some((item) => item.status === 'applied'))
      params.onChanged?.({ stopRelativePaths: relativePaths(songs) })
    return
  }

  if (params.menuName === 'fingerprints.analyzeAndAdd') {
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    await analyzeFingerprintsForPaths(
      prepared.map((song) => song.filePath),
      { origin: 'selection' }
    )
    return
  }

  if (params.menuName === 'tracks.clearTrackCache') {
    if (!songs.length || !params.rootToken) return
    const prompted = await promptTrackAnalysisSelection({
      filePaths: songs.map((song) => song.icloudOrigin?.key || song.filePath),
      songs,
      purpose: 'reanalysis'
    })
    if (!prompted) return
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    const bound = (await window.electron.ipcRenderer.invoke(
      'icloud:bind-analysis',
      prepared.map((song) => song.icloudOrigin?.relativePath),
      params.rootToken
    )) as {
      ok?: boolean
      error?: string
      value?: Array<{ relative?: string; filePath?: string }>
    }
    const files = (bound.value || [])
      .map((item) => (typeof item.filePath === 'string' ? item.filePath : ''))
      .filter(Boolean)
    if (!bound.ok || !files.length) {
      await showHint(errorText(bound.error || 'failed'))
      return
    }
    params.onAnalysisBound?.(
      (bound.value || []).flatMap((item) =>
        item.relative && item.filePath ? [{ relative: item.relative, filePath: item.filePath }] : []
      )
    )
    const raw: unknown = await window.electron.ipcRenderer.invoke('track:cache:clear:batch', {
      filePaths: files,
      selection: prompted.selection,
      analysisBpmRangeId: prompted.analysisBpmRangeId,
      gridMode: prompted.analysisGridMode
    })
    const blocked =
      raw && typeof raw === 'object' && (raw as { blocked?: unknown }).blocked === true
    if (blocked) {
      const reason = (raw as { reason?: unknown }).reason
      await showTrackReanalysisRuntimeBlockedHint(typeof reason === 'string' ? reason : '')
    }
    return
  }

  if (params.menuName === 'tracks.convertFormat') {
    if (!songs.length) return
    const choice = await openConvertDialog({ sourceExts: extensionsOf(songs) })
    if (!isConvertChoice(choice)) return
    const inCloud =
      choice.strategy === 'replace' ||
      !choice.outputDir ||
      writesInsideIcloudDrive(choice.outputDir)
    if (inCloud) {
      const key = choice.strategy === 'replace' ? 'icloud.confirmReplace' : 'icloud.confirmNewFile'
      if (!(await acceptRisk(key))) return
    }
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    const started = await runAction(() =>
      window.electron.ipcRenderer.invoke('audio:convert:start', {
        files: prepared.map((song) => song.filePath),
        options: choice,
        songListUUID: ICLOUD_SONG_LIST_UUID
      })
    )
    if (!started) return
    params.onChanged?.(
      choice.strategy === 'replace' ? { stopRelativePaths: relativePaths(songs) } : {}
    )
    return
  }

  if (params.menuName === 'stemSeparation.menu') {
    const target = anchorSong(songs, params.anchor)
    if (!target?.icloudOrigin) return
    const prepared = await prepareSelected([target], params.onLocalized)
    if (!prepared?.[0]) return
    const { default: openLibraryStemSeparationDialog } =
      await import('@renderer/components/libraryStemSeparationDialog')
    await openLibraryStemSeparationDialog({
      filePath: prepared[0].filePath,
      songTitle: prepared[0].title
    })
    return
  }

  if (params.menuName === 'bpmFix.menu') {
    if (!songs.length || !(await acceptRisk('icloud.confirmNewFile'))) return
    const prepared = await prepareSelected(songs, params.onLocalized)
    if (!prepared) return
    await startBpmFix({
      filePaths: prepared.map((song) => song.filePath),
      songListUUID: ICLOUD_SONG_LIST_UUID,
      songListPath: '',
      outputDir: directoryOf(prepared[0].filePath)
    })
  }
}
