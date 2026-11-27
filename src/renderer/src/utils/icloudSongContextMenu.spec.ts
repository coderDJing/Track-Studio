import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ISongInfo } from 'src/types/globals'

const invoke = vi.fn()
const exportDialog = vi.fn()
const selectSongListDialog = vi.fn()
const appendExternalSongsToSet = vi.fn()
const appendDownloadedFilesToMixtape = vi.fn()
const openRekordboxDesktopPlaylistForSelectedTracks = vi.fn()
const openRekordboxXmlExportForSelectedTracks = vi.fn()
const openExternalLibraryPlaylistForSelectedTracks = vi.fn()
const openBatchSimilarTracksDialogForSeeds = vi.fn()
const confirmDialog = vi.fn()
const delSongsViaSend = vi.fn()
const findDirPathByUuid = vi.fn()
const analyzeFingerprintsForPaths = vi.fn()
const invokeMetadataAutoFill = vi.fn()
const startBpmFix = vi.fn()
const openEditMetadataDialog = vi.fn()
const openConvertDialog = vi.fn()
const openStemDialog = vi.fn()
const openAutoSummary = vi.fn()
const promptTrackAnalysisSelection = vi.fn()
const showTrackReanalysisRuntimeBlockedHint = vi.fn()

vi.mock('@renderer/components/exportDialog', () => ({
  default: (...args: unknown[]) => exportDialog(...args)
}))
vi.mock('@renderer/components/selectSongListDialog', () => ({
  default: (...args: unknown[]) => selectSongListDialog(...args)
}))
vi.mock('@renderer/components/confirmDialog', () => ({
  default: (...args: unknown[]) => confirmDialog(...args)
}))
vi.mock('@renderer/utils/setCustody', () => ({
  appendExternalSongsToSet: (...args: unknown[]) => appendExternalSongsToSet(...args)
}))
vi.mock('@renderer/utils/mixtapePlaylistAppend', () => ({
  appendDownloadedFilesToMixtape: (...args: unknown[]) => appendDownloadedFilesToMixtape(...args)
}))
vi.mock('@renderer/utils/rekordboxDesktopPlaylist', () => ({
  openRekordboxDesktopPlaylistForSelectedTracks: (...args: unknown[]) =>
    openRekordboxDesktopPlaylistForSelectedTracks(...args)
}))
vi.mock('@renderer/utils/rekordboxXmlExport', () => ({
  openRekordboxXmlExportForSelectedTracks: (...args: unknown[]) =>
    openRekordboxXmlExportForSelectedTracks(...args)
}))
vi.mock('@renderer/utils/externalLibraryPlaylist', () => ({
  openExternalLibraryPlaylistForSelectedTracks: (...args: unknown[]) =>
    openExternalLibraryPlaylistForSelectedTracks(...args)
}))
vi.mock('@renderer/utils/similarTracksActions', () => ({
  openBatchSimilarTracksDialogForSeeds: (...args: unknown[]) =>
    openBatchSimilarTracksDialogForSeeds(...args)
}))
vi.mock('@renderer/utils/musicSearch', () => ({
  createMusicSearchMenuItems: () => [{ menuName: 'tracks.neteaseSearch' }]
}))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))
vi.mock('@renderer/utils/trackReanalysis', () => ({
  promptTrackAnalysisSelection: (...args: unknown[]) => promptTrackAnalysisSelection(...args)
}))
vi.mock('@renderer/utils/trackReanalysisRuntimeGate', () => ({
  showTrackReanalysisRuntimeBlockedHint: (...args: unknown[]) =>
    showTrackReanalysisRuntimeBlockedHint(...args)
}))
vi.mock('@renderer/utils/recycleBinActions', () => ({
  delSongsViaSend: (...args: unknown[]) => delSongsViaSend(...args)
}))
vi.mock('@renderer/utils/libraryUtils', () => ({
  default: { findDirPathByUuid: (...args: unknown[]) => findDirPathByUuid(...args) }
}))
vi.mock('@renderer/utils/fingerprintActions', () => ({
  analyzeFingerprintsForPaths: (...args: unknown[]) => analyzeFingerprintsForPaths(...args)
}))
vi.mock('@renderer/utils/metadataAutoFill', () => ({
  invokeMetadataAutoFill: (...args: unknown[]) => invokeMetadataAutoFill(...args)
}))
vi.mock('@renderer/utils/bpmFixActions', () => ({
  startBpmFix: (...args: unknown[]) => startBpmFix(...args)
}))
vi.mock('@renderer/components/editMetadataDialog', () => ({
  default: (...args: unknown[]) => openEditMetadataDialog(...args)
}))
vi.mock('@renderer/components/audioConvertDialog', () => ({
  default: (...args: unknown[]) => openConvertDialog(...args)
}))
vi.mock('@renderer/components/libraryStemSeparationDialog', () => ({
  default: (...args: unknown[]) => openStemDialog(...args)
}))
vi.mock('@renderer/components/autoMetadataSummaryDialog', () => ({
  default: (...args: unknown[]) => openAutoSummary(...args)
}))

import { icloudState } from './icloudLibrary'
import { cancelCloudPlayback, cloudPlaybackStates } from './icloudPlayback'
import { cancelIcloudLocalAction } from './icloudPrepareLocal'
import {
  createIcloudSongMenuArr,
  handleIcloudSongMenuChoice,
  ICLOUD_FORBIDDEN_SONG_MENU_NAMES
} from './icloudSongContextMenu'

const song = (name: string): ISongInfo =>
  ({
    filePath: `icloud-song:${name}`,
    fileName: name,
    title: name,
    icloudOrigin: { relativePath: name, rootToken: 'root', key: `icloud-song:${name}` }
  }) as ISongInfo

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (channel: string, relative: string) => {
    if (channel === 'icloud:prepare-local')
      return { ok: true, value: { relative, filePath: `/tmp/icloud/${relative}` } }
    return { ok: true, value: true }
  })
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  icloudState.value = {
    supported: true,
    visible: true,
    available: true,
    configured: true,
    folder: 'drive',
    rootToken: 'root'
  }
  cloudPlaybackStates.value = {}
  exportDialog
    .mockReset()
    .mockResolvedValue({ folderPathVal: '/tmp/export', deleteSongsAfterExport: true })
  selectSongListDialog.mockReset().mockResolvedValue({ uuid: 'set-1' })
  appendExternalSongsToSet.mockReset().mockResolvedValue(undefined)
  appendDownloadedFilesToMixtape.mockReset().mockResolvedValue(undefined)
  openRekordboxDesktopPlaylistForSelectedTracks.mockReset().mockResolvedValue({})
  openRekordboxXmlExportForSelectedTracks.mockReset().mockResolvedValue({})
  openExternalLibraryPlaylistForSelectedTracks.mockReset().mockResolvedValue({})
  openBatchSimilarTracksDialogForSeeds.mockReset().mockResolvedValue(undefined)
  confirmDialog.mockReset().mockResolvedValue('confirm')
  delSongsViaSend
    .mockReset()
    .mockResolvedValue({ success: 1, failed: 0, removedPaths: ['/tmp/icloud/a.mp3'] })
  findDirPathByUuid.mockReset().mockReturnValue('/tmp/playlist')
  analyzeFingerprintsForPaths.mockReset().mockResolvedValue(undefined)
  invokeMetadataAutoFill.mockReset().mockResolvedValue({ items: [{ status: 'applied' }] })
  startBpmFix.mockReset().mockResolvedValue(undefined)
  openEditMetadataDialog
    .mockReset()
    .mockResolvedValue({ updatedSongInfo: { filePath: '/tmp/icloud/a.mp3' } })
  openConvertDialog
    .mockReset()
    .mockResolvedValue({ strategy: 'new_file', outputDir: '/tmp/out', targetFormat: 'mp3' })
  openStemDialog.mockReset().mockResolvedValue(undefined)
  openAutoSummary.mockReset().mockResolvedValue(undefined)
  promptTrackAnalysisSelection.mockReset().mockResolvedValue({
    files: ['icloud-song:a.mp3'],
    selection: { key: true, beatGrid: true, energy: false, waveform: true, structure: false },
    analysisBpmRangeId: 'default',
    analysisGridMode: 'normal'
  })
  showTrackReanalysisRuntimeBlockedHint.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cancelIcloudLocalAction()
  cancelCloudPlayback()
  cloudPlaybackStates.value = {}
  icloudState.value = null
  vi.unstubAllGlobals()
})

it('uses ordinary-list labels, including writes that need confirmation, and omits actions that cannot land', () => {
  const names = createIcloudSongMenuArr()
    .flat()
    .map((item) => item.menuName)
  expect(names).toEqual([
    'icloud.play',
    'tracks.exportTracks',
    'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks',
    'rekordboxXmlExport.menuExportSelectedTracks',
    'library.writeToSeratoPlaylist',
    'library.writeToTraktorPlaylist',
    'library.moveToFilter',
    'library.moveToCurated',
    'library.copyToFilter',
    'library.copyToCurated',
    'library.addToSet',
    'library.addToMixtape',
    'tracks.deleteTracks',
    'tracks.deleteAllAbove',
    'tracks.showInFileExplorer',
    'tracks.neteaseSearch',
    'similarTracks.menu',
    'metadata.autoFillMenu',
    'tracks.editMetadata',
    'fingerprints.analyzeAndAdd',
    'tracks.clearTrackCache',
    'tracks.convertFormat',
    'stemSeparation.menu',
    'bpmFix.menu'
  ])
  expect(createIcloudSongMenuArr()[4][0]).toMatchObject({
    menuName: 'tracks.deleteTracks',
    shortcutKey: 'Delete'
  })
  for (const forbidden of ICLOUD_FORBIDDEN_SONG_MENU_NAMES) expect(names).not.toContain(forbidden)
})

it('exports with forceCopyOnly after the destination is chosen, and never deletes the iCloud original', async () => {
  await handleIcloudSongMenuChoice({ menuName: 'tracks.exportTracks', songs: [song('a.mp3')] })
  expect(exportDialog).toHaveBeenCalledWith({ title: 'tracks.title', forceCopyOnly: true })
  expect(invoke).toHaveBeenCalledWith('exportSongsToDir', '/tmp/export', false, [
    expect.objectContaining({ filePath: '/tmp/icloud/a.mp3' })
  ])
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-play')).toBe(false)
})

it('does not localize or export when the export dialog is cancelled', async () => {
  exportDialog.mockResolvedValue('cancel')
  await handleIcloudSongMenuChoice({ menuName: 'tracks.exportTracks', songs: [song('a.mp3')] })
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-local')).toBe(false)
  expect(invoke.mock.calls.some(([channel]) => channel === 'exportSongsToDir')).toBe(false)
})

it('adds to SET by copying into custody, never moving or referencing the iCloud original path', async () => {
  await handleIcloudSongMenuChoice({ menuName: 'library.addToSet', songs: [song('a.mp3')] })
  expect(selectSongListDialog).toHaveBeenCalledWith({
    libraryName: 'SetLibrary',
    actionMode: 'copy'
  })
  expect(appendExternalSongsToSet).toHaveBeenCalledWith({
    playlistUuid: 'set-1',
    items: [
      expect.objectContaining({
        song: expect.objectContaining({ filePath: '/tmp/icloud/a.mp3' }),
        originPathSnapshot: 'a.mp3'
      })
    ]
  })
  expect(invoke.mock.calls.some(([channel]) => channel === 'setList:append-items')).toBe(false)
  expect(invoke.mock.calls.some(([channel]) => channel === 'setList:append-custody-items')).toBe(
    false
  )
})

it('adds to Mixtape by copying into the vault after on-demand localization', async () => {
  selectSongListDialog.mockResolvedValue({ uuid: 'mix-1' })
  await handleIcloudSongMenuChoice({ menuName: 'library.addToMixtape', songs: [song('a.mp3')] })
  expect(selectSongListDialog).toHaveBeenCalledWith({
    libraryName: 'MixtapeLibrary',
    actionMode: 'copy'
  })
  expect(appendDownloadedFilesToMixtape).toHaveBeenCalledWith({
    playlistId: 'mix-1',
    entries: [expect.objectContaining({ filePath: '/tmp/icloud/a.mp3' })]
  })
})

it('looks up similar tracks only after the selected files are local, using a read-only fingerprint path', async () => {
  await handleIcloudSongMenuChoice({ menuName: 'similarTracks.menu', songs: [song('a.mp3')] })
  expect(openBatchSimilarTracksDialogForSeeds).toHaveBeenCalledWith([
    expect.objectContaining({ filePath: '/tmp/icloud/a.mp3' })
  ])
})

it('writes Rekordbox, Serato and Traktor from copies and keeps the iCloud originals', async () => {
  await handleIcloudSongMenuChoice({
    menuName: 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks',
    songs: [song('a.mp3')]
  })
  expect(openRekordboxDesktopPlaylistForSelectedTracks).toHaveBeenCalledWith(
    expect.objectContaining({
      forceKeepSourceTracks: true,
      songListUUID: 'icloud-music',
      prepareTracks: expect.any(Function)
    })
  )
  const desktop = openRekordboxDesktopPlaylistForSelectedTracks.mock.calls[0][0]
  await expect(desktop.prepareTracks([song('a.mp3')])).resolves.toEqual([
    expect.objectContaining({ filePath: '/tmp/icloud/a.mp3' })
  ])

  await handleIcloudSongMenuChoice({
    menuName: 'rekordboxXmlExport.menuExportSelectedTracks',
    songs: [song('a.mp3')]
  })
  expect(openRekordboxXmlExportForSelectedTracks).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceLibraryName: 'IcloudLibrary',
      lockMode: 'copy',
      prepareTracks: expect.any(Function)
    })
  )

  await handleIcloudSongMenuChoice({
    menuName: 'library.writeToSeratoPlaylist',
    songs: [song('a.mp3')]
  })
  expect(openExternalLibraryPlaylistForSelectedTracks).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'serato', prepareTracks: expect.any(Function) })
  )
  await handleIcloudSongMenuChoice({
    menuName: 'library.writeToTraktorPlaylist',
    songs: [song('a.mp3')]
  })
  expect(openExternalLibraryPlaylistForSelectedTracks).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'traktor', prepareTracks: expect.any(Function) })
  )
})

it('does not download or delete when the iCloud removal confirm is cancelled', async () => {
  confirmDialog.mockResolvedValue('cancel')
  await handleIcloudSongMenuChoice({ menuName: 'tracks.deleteTracks', songs: [song('a.mp3')] })
  expect(confirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ content: ['icloud.confirmRemove'] })
  )
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-local')).toBe(false)
  expect(delSongsViaSend).not.toHaveBeenCalled()
})

it('moves only the confirmed songs into the recycle bin after they are local', async () => {
  const changed = vi.fn()
  await handleIcloudSongMenuChoice({
    menuName: 'tracks.deleteTracks',
    songs: [song('a.mp3')],
    onChanged: changed
  })
  expect(delSongsViaSend).toHaveBeenCalledWith({
    filePaths: ['/tmp/icloud/a.mp3'],
    sourceType: 'external'
  })
  expect(changed).toHaveBeenCalledWith({ stopRelativePaths: ['a.mp3'] })
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-play')).toBe(false)
})

it('does not delete when localization of the songs being removed is cancelled', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'icloud:prepare-local') return { ok: false, error: 'cancelled' }
    return { ok: true, value: true }
  })
  const changed = vi.fn()
  await handleIcloudSongMenuChoice({
    menuName: 'tracks.deleteTracks',
    songs: [song('a.mp3')],
    onChanged: changed
  })
  expect(delSongsViaSend).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

it('deletes only the songs above the clicked row, not the selection', async () => {
  const above = song('above.mp3')
  const current = song('current.mp3')
  await handleIcloudSongMenuChoice({
    menuName: 'tracks.deleteAllAbove',
    songs: [current],
    anchor: current,
    visibleSongs: [above, current, song('below.mp3')]
  })
  expect(invoke).toHaveBeenCalledWith('icloud:prepare-local', 'above.mp3', expect.any(Object))
  expect(delSongsViaSend).toHaveBeenCalledWith({
    filePaths: ['/tmp/icloud/above.mp3'],
    sourceType: 'external'
  })
})

it('does nothing when there is no song above the clicked row', async () => {
  const current = song('current.mp3')
  await handleIcloudSongMenuChoice({
    menuName: 'tracks.deleteAllAbove',
    songs: [current],
    anchor: current,
    visibleSongs: [current]
  })
  expect(confirmDialog).not.toHaveBeenCalled()
  expect(delSongsViaSend).not.toHaveBeenCalled()
})

it('moves the local file out of iCloud only after the destination playlist is chosen', async () => {
  invoke.mockImplementation(async (channel: string, relative: string) => {
    if (channel === 'icloud:prepare-local')
      return { ok: true, value: { relative, filePath: `/tmp/icloud/${relative}` } }
    if (channel === 'moveSongsToDir') return { movedEntries: [{}], failed: 0 }
    return { ok: true, value: true }
  })
  const changed = vi.fn()
  await handleIcloudSongMenuChoice({
    menuName: 'library.moveToCurated',
    songs: [song('a.mp3')],
    onChanged: changed
  })
  expect(confirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ content: ['icloud.confirmMove'] })
  )
  expect(selectSongListDialog).toHaveBeenCalledWith({
    libraryName: 'CuratedLibrary',
    actionMode: 'move'
  })
  expect(invoke).toHaveBeenCalledWith('moveSongsToDir', ['/tmp/icloud/a.mp3'], '/tmp/playlist', {
    returnSummary: true
  })
  expect(changed).toHaveBeenCalledWith({ stopRelativePaths: ['a.mp3'] })
})

it('does not download when the move is cancelled before a playlist is chosen', async () => {
  confirmDialog.mockResolvedValueOnce('cancel')
  await handleIcloudSongMenuChoice({ menuName: 'library.moveToFilter', songs: [song('a.mp3')] })
  expect(selectSongListDialog).not.toHaveBeenCalled()
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-local')).toBe(false)
})

it('keeps the iCloud file when the move playlist dialog is cancelled', async () => {
  selectSongListDialog.mockResolvedValueOnce('cancel')
  await handleIcloudSongMenuChoice({ menuName: 'library.moveToFilter', songs: [song('a.mp3')] })
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-local')).toBe(false)
  expect(invoke.mock.calls.some(([channel]) => channel === 'moveSongsToDir')).toBe(false)
})

it('edits only the clicked song, and only after the rewrite warning', async () => {
  const other = song('other.mp3')
  const clicked = song('clicked.mp3')
  await handleIcloudSongMenuChoice({
    menuName: 'tracks.editMetadata',
    songs: [other, clicked],
    anchor: clicked
  })
  expect(confirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ content: ['icloud.confirmRewrite'] })
  )
  expect(openEditMetadataDialog).toHaveBeenCalledWith({ filePath: '/tmp/icloud/clicked.mp3' })
  expect(invoke.mock.calls.filter(([channel]) => channel === 'icloud:prepare-local')).toHaveLength(
    1
  )
})

it('does not download or open the editor when the rewrite warning is cancelled', async () => {
  confirmDialog.mockResolvedValue('cancel')
  await handleIcloudSongMenuChoice({ menuName: 'tracks.editMetadata', songs: [song('a.mp3')] })
  expect(openEditMetadataDialog).not.toHaveBeenCalled()
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-local')).toBe(false)
})

it('writes auto-filled tags only after confirmation and localization', async () => {
  await handleIcloudSongMenuChoice({ menuName: 'metadata.autoFillMenu', songs: [song('a.mp3')] })
  expect(invokeMetadataAutoFill).toHaveBeenCalledWith(['/tmp/icloud/a.mp3'])
  expect(openAutoSummary).toHaveBeenCalled()
})

it('analyzes fingerprints from the local file and does not ask to change the iCloud original', async () => {
  await handleIcloudSongMenuChoice({
    menuName: 'fingerprints.analyzeAndAdd',
    songs: [song('a.mp3')]
  })
  expect(confirmDialog).not.toHaveBeenCalled()
  expect(analyzeFingerprintsForPaths).toHaveBeenCalledWith(['/tmp/icloud/a.mp3'], {
    origin: 'selection'
  })
})

it('does not analyze fingerprints when localization is cancelled', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'icloud:prepare-local') return { ok: false, error: 'cancelled' }
    return { ok: true, value: true }
  })
  await handleIcloudSongMenuChoice({
    menuName: 'fingerprints.analyzeAndAdd',
    songs: [song('a.mp3')]
  })
  expect(analyzeFingerprintsForPaths).not.toHaveBeenCalled()
  expect(confirmDialog).not.toHaveBeenCalled()
})

it('opens stem separation on the local file without a rewrite warning', async () => {
  await handleIcloudSongMenuChoice({
    menuName: 'stemSeparation.menu',
    songs: [song('a.mp3'), song('b.mp3')],
    anchor: song('b.mp3')
  })
  expect(confirmDialog).not.toHaveBeenCalled()
  expect(openStemDialog).toHaveBeenCalledWith({
    filePath: '/tmp/icloud/b.mp3',
    songTitle: 'b.mp3'
  })
  expect(invoke).toHaveBeenCalledWith('icloud:prepare-local', 'b.mp3', expect.any(Object))
})

it('fixes BPM by writing a new file in the iCloud folder and never overwriting', async () => {
  await handleIcloudSongMenuChoice({ menuName: 'bpmFix.menu', songs: [song('a.mp3')] })
  expect(confirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ content: ['icloud.confirmNewFile'] })
  )
  expect(startBpmFix).toHaveBeenCalledWith({
    filePaths: ['/tmp/icloud/a.mp3'],
    songListUUID: 'icloud-music',
    songListPath: '',
    outputDir: '/tmp/icloud'
  })
})

it('does not download for BPM fix when the new-file warning is cancelled', async () => {
  confirmDialog.mockResolvedValue('cancel')
  await handleIcloudSongMenuChoice({ menuName: 'bpmFix.menu', songs: [song('a.mp3')] })
  expect(startBpmFix).not.toHaveBeenCalled()
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-local')).toBe(false)
})

it('asks before replacing an iCloud original, then converts the local file', async () => {
  openConvertDialog.mockResolvedValue({ strategy: 'replace', targetFormat: 'wav' })
  await handleIcloudSongMenuChoice({ menuName: 'tracks.convertFormat', songs: [song('a.mp3')] })
  expect(confirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ content: ['icloud.confirmReplace'] })
  )
  expect(invoke).toHaveBeenCalledWith(
    'audio:convert:start',
    expect.objectContaining({
      files: ['/tmp/icloud/a.mp3'],
      options: expect.objectContaining({ strategy: 'replace' })
    })
  )
})

it('asks before saving a converted file inside iCloud, and skips the warning outside it', async () => {
  openConvertDialog.mockResolvedValue({
    strategy: 'new_file',
    outputDir: '/Users/a/Library/Mobile Documents/com~apple~CloudDocs/Music',
    targetFormat: 'aiff'
  })
  await handleIcloudSongMenuChoice({ menuName: 'tracks.convertFormat', songs: [song('a.mp3')] })
  expect(confirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ content: ['icloud.confirmNewFile'] })
  )

  confirmDialog.mockClear()
  openConvertDialog.mockResolvedValue({
    strategy: 'new_file',
    outputDir: '/tmp/out',
    targetFormat: 'mp3'
  })
  await handleIcloudSongMenuChoice({ menuName: 'tracks.convertFormat', songs: [song('a.mp3')] })
  expect(confirmDialog).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledWith(
    'audio:convert:start',
    expect.objectContaining({
      files: ['/tmp/icloud/a.mp3'],
      options: expect.objectContaining({ outputDir: '/tmp/out' })
    })
  )
})

it('does not download when the convert dialog is cancelled', async () => {
  openConvertDialog.mockResolvedValue('cancel')
  await handleIcloudSongMenuChoice({ menuName: 'tracks.convertFormat', songs: [song('a.mp3')] })
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-local')).toBe(false)
  expect(invoke.mock.calls.some(([channel]) => channel === 'audio:convert:start')).toBe(false)
})

it('shows remove download only for songs that are already on this Mac, away from delete', () => {
  const plain = createIcloudSongMenuArr()
    .flat()
    .map((item) => item.menuName)
  expect(plain).not.toContain('icloud.removeDownload')
  const names = createIcloudSongMenuArr({ canRemoveDownload: true })
    .flat()
    .map((item) => item.menuName)
  expect(names.indexOf('icloud.removeDownload')).toBe(
    names.indexOf('tracks.showInFileExplorer') + 1
  )
  expect(names).toContain('tracks.clearTrackCache')
})

it('removes only the selected local copies, without a confirm dialog or a download', async () => {
  invoke.mockImplementation(async (channel: string, paths: string[]) => {
    if (channel === 'icloud:evict-local')
      return { ok: true, value: [{ relative: paths[0], status: 'evicted' }] }
    return { ok: true, value: true }
  })
  const evicted = vi.fn()
  await handleIcloudSongMenuChoice({
    menuName: 'icloud.removeDownload',
    songs: [song('a.mp3'), song('b.mp3')],
    localRelativePaths: ['a.mp3'],
    rootToken: 'root',
    onEvicted: evicted
  })
  expect(confirmDialog).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledWith('icloud:evict-local', ['a.mp3'], 'root')
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-local')).toBe(false)
  expect(evicted).toHaveBeenCalledWith('a.mp3')
})

it('asks the system to remove a song that was only prepared for playback', async () => {
  invoke.mockImplementation(async (channel: string, paths: string[]) =>
    channel === 'icloud:evict-local'
      ? { ok: true, value: [{ relative: paths[0], status: 'evicted' }] }
      : { ok: true, value: true }
  )
  const evicted = vi.fn()
  await handleIcloudSongMenuChoice({
    menuName: 'icloud.removeDownload',
    songs: [song('a.mp3')],
    localRelativePaths: ['a.mp3'],
    rootToken: 'root',
    onEvicted: evicted
  })
  expect(invoke).toHaveBeenCalledWith('icloud:evict-local', ['a.mp3'], 'root')
  expect(evicted).toHaveBeenCalledWith('a.mp3')
  expect(confirmDialog).not.toHaveBeenCalled()
})

it('tells the user when the file is still open and does not mark it cloud-only', async () => {
  invoke.mockImplementation(async (channel: string) =>
    channel === 'icloud:evict-local'
      ? { ok: true, value: [{ relative: 'a.mp3', status: 'failed', error: 'playing' }] }
      : { ok: true, value: true }
  )
  const evicted = vi.fn()
  await handleIcloudSongMenuChoice({
    menuName: 'icloud.removeDownload',
    songs: [song('a.mp3')],
    localRelativePaths: ['a.mp3'],
    rootToken: 'root',
    onEvicted: evicted
  })
  expect(confirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ content: ['icloud.errors.playing'], confirmShow: false })
  )
  expect(evicted).not.toHaveBeenCalled()
})

it('tells the user when iCloud is still uploading and does not mark the song cloud-only', async () => {
  invoke.mockImplementation(async (channel: string) =>
    channel === 'icloud:evict-local'
      ? { ok: true, value: [{ relative: 'a.mp3', status: 'failed', error: 'uploading' }] }
      : { ok: true, value: true }
  )
  const evicted = vi.fn()
  await handleIcloudSongMenuChoice({
    menuName: 'icloud.removeDownload',
    songs: [song('a.mp3')],
    localRelativePaths: ['a.mp3'],
    rootToken: 'root',
    onEvicted: evicted
  })
  expect(evicted).not.toHaveBeenCalled()
  expect(confirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ content: ['icloud.errors.uploading'] })
  )
})

it('reanalyzes a downloaded iCloud song with the ordinary dialog after it is local', async () => {
  invoke.mockImplementation(async (channel: string, relative: string) => {
    if (channel === 'icloud:prepare-local')
      return { ok: true, value: { relative, filePath: `/tmp/icloud/${relative}` } }
    if (channel === 'icloud:bind-analysis')
      return {
        ok: true,
        value: [{ relative: 'a.mp3', filePath: '/tmp/icloud/a.mp3' }]
      }
    if (channel === 'track:cache:clear:batch') return { cleared: 1, queued: 1, skipped: 0 }
    return { ok: true, value: true }
  })
  const bound = vi.fn()
  await handleIcloudSongMenuChoice({
    menuName: 'tracks.clearTrackCache',
    songs: [song('a.mp3')],
    rootToken: 'root',
    onAnalysisBound: bound
  })
  expect(promptTrackAnalysisSelection).toHaveBeenCalledWith(
    expect.objectContaining({ purpose: 'reanalysis' })
  )
  expect(invoke).toHaveBeenCalledWith('icloud:bind-analysis', ['a.mp3'], 'root')
  expect(invoke).toHaveBeenCalledWith(
    'track:cache:clear:batch',
    expect.objectContaining({
      filePaths: ['/tmp/icloud/a.mp3'],
      selection: expect.objectContaining({ key: true, beatGrid: true })
    })
  )
  expect(bound).toHaveBeenCalledWith([{ relative: 'a.mp3', filePath: '/tmp/icloud/a.mp3' }])
})

it('does not download when reanalysis is cancelled', async () => {
  promptTrackAnalysisSelection.mockResolvedValueOnce(null)
  await handleIcloudSongMenuChoice({
    menuName: 'tracks.clearTrackCache',
    songs: [song('a.mp3')],
    rootToken: 'root'
  })
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-local')).toBe(false)
  expect(invoke.mock.calls.some(([channel]) => channel === 'track:cache:clear:batch')).toBe(false)
})

it('does not start the SET copy when localization is cancelled', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'icloud:prepare-local') return { ok: false, error: 'cancelled' }
    return { ok: true, value: true }
  })
  await handleIcloudSongMenuChoice({ menuName: 'library.addToSet', songs: [song('a.mp3')] })
  expect(appendExternalSongsToSet).not.toHaveBeenCalled()
  expect(confirmDialog).not.toHaveBeenCalled()
})
