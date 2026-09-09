import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT } from '@shared/horizontalBrowseTransport'

type IpcListener = Parameters<typeof ipcRenderer.on>[1]
type IpcMethod = 'invoke' | 'send' | 'on'

export interface PreloadApi {
  showFilesPath: (file: File) => string
  getDevRuntimeInfo: () => {
    instanceId: string
  }
}

const sanitizeDevInstanceId = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

const resolveDevInstanceId = (): string => {
  const isDevRuntime =
    process.env.NODE_ENV === 'development' || !!String(process.env.ELECTRON_RENDERER_URL || '')
  if (!isDevRuntime) return ''
  return sanitizeDevInstanceId(process.env.FRKB_DEV_INSTANCE)
}

const exactInvokeChannels = new Set([
  'changeGlobalShortcut',
  'check-path-exists',
  'check-paths-exist',
  'clearTracksFingerprintLibrary',
  'deduplicateSongListByFingerprint',
  'delSongsAwaitable',
  'dirPathExists',
  'emptyDir',
  'emptyRecycleBin',
  'exportSongFingerprint',
  'exportSongListToDir',
  'exportSongsToDir',
  'find-db-root-upwards',
  'foundNewVersionWindow-startUpdate',
  'get-default-database-parent-dir',
  'get-drives',
  'get-file-sizes',
  'get-user-home',
  'get-windows-hide-ext',
  'getLibrary',
  'getSetting',
  'getSongCoverThumb',
  'getSongFingerprintListLength',
  'getSongListTrackCount',
  'importSongFingerprint',
  'library-setup:cancel',
  'library-setup:clearErrorHint',
  'library-setup:getState',
  'library-setup:init',
  'moveSongsToDir',
  'operateFileSystemChange',
  'paths:exists',
  'persistSongCoverDisplayCache',
  'permanentlyDelSongs',
  'playerGlobalShortcut:update',
  'playerGlobalShortcut:updateSeekPercentModifier',
  'playlist:batchTrackCount',
  'playlist:fast-open',
  'playlist:verify-tracks',
  'probe-database-dir',
  'reSelectLibrary',
  'read-directory',
  'scanSongList',
  'select-audio-files',
  'select-existing-database-file',
  'select-folder',
  'select-songFingerprintFile',
  'setSetting',
  'sweepSongListCovers'
])

const exactSendChannels = new Set([
  'addSongFingerprint',
  'cancelSongCoverSession',
  'checkForUpdates',
  'cloudSync/cancel',
  'databaseSchemaMigrationWindow-close',
  'external-open:renderer-ready',
  'file-op-control',
  'foundNewVersionWindow-toggle-close',
  'foundNewVersionWindow-toggle-minimize',
  'key-analysis:queue-deck-idle',
  'key-analysis:queue-playing',
  'key-analysis:queue-visible',
  'layoutConfigChanged',
  'main-window-browse-mode-updated',
  'mixtape-drag-session:cancel',
  'mixtape-drag-session:create',
  'mixtape-waveform:queue-visible',
  'mixtape:open',
  'mixtapeWindow-open-dialog',
  'mixtapeWindow-toggle-close',
  'mixtapeWindow-toggle-maximize',
  'mixtapeWindow-toggle-minimize',
  'open-current-library-root-in-explorer',
  'openFileExplorer',
  'openLocalBrowser',
  'openLog',
  'outputLog',
  'player:foreground-activity',
  'readSongFile',
  'show-item-in-folder',
  'showWhatsNew',
  'startExternalSongDrag',
  'startImportSongs',
  'toggle-close',
  'toggle-maximize',
  'toggle-minimize',
  'updateWindow-open-applications-folder',
  'updateWindow-open-download-folder',
  'updateWindow-open-downloaded-file',
  'updateWindow-open-manual-download',
  'updateWindow-quit-app',
  'updateWindow-restart-app-for-update',
  'updateWindow-recheck',
  'updateWindow-startDownload',
  'updateWindow-toggle-close',
  'updateWindow-toggle-minimize',
  'whatsNew-acknowledge',
  'whatsNew-toggle-close',
  'whatsNew-toggle-minimize'
])

const exactSendTransportChannels = new Set(['horizontal-browse-transport:set-playback-rate-live'])

const exactListenChannels = new Set([
  'addSongFingerprintFinished',
  'analysis-runtime-download-state',
  'demucs-model-download-state',
  'audio:convert:done',
  'cloudSync/error',
  'cloudSync/notice',
  'cloudSync/progress',
  'cloudSync/state',
  'cloudSync/summary',
  'curatedLibrarySync/notice',
  'curatedLibrarySync/status',
  'curatedLibrarySync/needsJoin',
  'curatedLibrarySync/playlistsChanged',
  'curated-artists-updated',
  'databaseInitWindow-showErrorHint',
  'databaseInitWindow-schemaMigrationProgress',
  'library-setup:state',
  'dev-songlist-trace:error',
  'dev-songlist-trace:exported',
  'dev-songlist-trace:state',
  'external-open/imported',
  'file-op-interrupted',
  'fingerprints:addExistingFinished',
  'foundNewVersion-data',
  HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT,
  'importFinished',
  'isError',
  'isLatestVersion',
  'isRequesting',
  'key-analysis:manual-batch-end',
  'key-analysis:manual-batch-start',
  'key-analysis:stage-update',
  'layoutConfigReaded',
  'library-merge:open-dialog',
  'library-merge:progress',
  'library-relocate:open-dialog',
  'library-relocate:progress',
  'library-stem-status-updated',
  'curated-library-merge:open-dialog',
  'library-tree-updated',
  'mainWin-max',
  'mainWindowBlur',
  'mixtape-bpm-batch-ready',
  'mixtape-items-removed',
  'mixtape-open',
  'mixtape-output:progress',
  'mixtape-stem-cpu-slow-hint',
  'mixtape-stem-runtime-progress',
  'mixtape-stem-status-updated',
  'mixtape-waveform-updated',
  'mixtapeWindow-max',
  'newVersion',
  'noAudioFileWasScanned',
  'open-global-song-search',
  'openDialogFromTray',
  'player/global-shortcut',
  'playlist:view-refreshed',
  'progressSet',
  'readSongFileError',
  'readedSongFile',
  'recycle-bin:empty-completed',
  'recording-library:changed',
  'releaseNotesRange',
  'setting-changed',
  'song-energy-updated',
  'song-grid-batch-updated',
  'song-grid-updated',
  'song-hot-cues-updated',
  'song-key-updated',
  'song-memory-cues-updated',
  'song-structure-updated',
  'song-waveform-updated',
  'startup:state',
  'theme/system-updated',
  'tray-action',
  'updateDownloaded',
  'updateProgress',
  'whatsNew-data'
])

const invokePrefixes = [
  'acoustid:',
  'analysis-runtime:',
  'audio:convert:',
  'audio:metadata:',
  'clipboard:',
  'cloudSync/',
  'curatedArtists:',
  'curatedLibrarySync/',
  'dev-songlist-trace:',
  'demucs-model:',
  'externalPlaylist:',
  'fingerprints:',
  'horizontal-browse-transport:',
  'key-analysis:',
  'library:',
  'library-stem:',
  'library-merge:',
  'library-relocate:',
  'mini-player:',
  'metadata:',
  'mixtape:',
  'mixtape-drag-session:',
  'mixtape-stem-waveform-cache:',
  'mixtape-waveform-raw:',
  'musicbrainz:',
  'playlist:batchRename:',
  'recordingLibrary:',
  'recycleBin:',
  'rekordbox-xml-export:',
  'setList:',
  'similarTracks:',
  'song-search:',
  'song-edit:',
  'song:',
  'songList:',
  'track:cache:',
  'unified-display-waveform-cache:',
  'waveform-global-overview-cache:',
  'waveform-list-preview-cache:'
]

const sourceChannelPrefixes = ['pioneer-device-library:', 'rekordbox-desktop-library:']

const isAllowedIpcChannel = (method: IpcMethod, channel: string): boolean => {
  if (!channel) return false
  if (method === 'invoke') {
    return (
      exactInvokeChannels.has(channel) ||
      invokePrefixes.some((prefix) => channel.startsWith(prefix)) ||
      sourceChannelPrefixes.some((prefix) => channel.startsWith(prefix))
    )
  }
  if (method === 'send') {
    return (
      exactSendChannels.has(channel) ||
      exactSendTransportChannels.has(channel) ||
      channel.startsWith('mini-player:') ||
      sourceChannelPrefixes.some((prefix) => channel === `${prefix}stream-preview-waveforms`)
    )
  }
  return (
    exactListenChannels.has(channel) ||
    channel.startsWith('mini-player:') ||
    sourceChannelPrefixes.some(
      (prefix) =>
        channel === `${prefix}preview-waveform-item` || channel === `${prefix}preview-waveform-done`
    )
  )
}

const assertAllowedIpcChannel = (method: IpcMethod, channel: string) => {
  if (isAllowedIpcChannel(method, channel)) return
  throw new Error(`Blocked unauthorized IPC channel: ${method}:${channel}`)
}

const blockedIpcMethod = (method: string): never => {
  throw new Error(`Blocked unsupported IPC method: ${method}`)
}

const safeIpcRenderer = {
  invoke(channel: string, ...args: unknown[]) {
    assertAllowedIpcChannel('invoke', channel)
    return ipcRenderer.invoke(channel, ...args)
  },
  send(channel: string, ...args: unknown[]) {
    assertAllowedIpcChannel('send', channel)
    ipcRenderer.send(channel, ...args)
  },
  on(channel: string, listener: IpcListener) {
    assertAllowedIpcChannel('on', channel)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  once(channel: string, listener: IpcListener) {
    assertAllowedIpcChannel('on', channel)
    ipcRenderer.once(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  removeListener(channel: string, listener: IpcListener) {
    assertAllowedIpcChannel('on', channel)
    ipcRenderer.removeListener(channel, listener)
    return safeIpcRenderer
  },
  removeAllListeners(channel: string) {
    assertAllowedIpcChannel('on', channel)
    ipcRenderer.removeAllListeners(channel)
  },
  postMessage() {
    blockedIpcMethod('postMessage')
  },
  sendSync() {
    blockedIpcMethod('sendSync')
  },
  sendTo() {
    blockedIpcMethod('sendTo')
  },
  sendToHost() {
    blockedIpcMethod('sendToHost')
  }
}

const safeElectronApi = {
  ...electronAPI,
  ipcRenderer: safeIpcRenderer
}

// Custom APIs for renderer
const api: PreloadApi = {
  showFilesPath(file) {
    const path = webUtils.getPathForFile(file)
    return path
  },
  getDevRuntimeInfo() {
    return {
      instanceId: resolveDevInstanceId()
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', safeElectronApi)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    try {
      ipcRenderer.send('outputLog', {
        level: 'error',
        source: 'preload',
        scope: 'context-bridge',
        message: error instanceof Error ? error.stack || error.message : String(error)
      })
    } catch {}
    console.error(error)
  }
} else {
  window.electron = safeElectronApi
  window.api = api
}
