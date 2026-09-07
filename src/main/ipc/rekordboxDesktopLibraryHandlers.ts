import { ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import mainWindow from '../window/mainWindow'
import {
  probeRekordboxDesktopLibrary,
  probeRekordboxDesktopLibraryWriteAvailability
} from '../services/rekordboxDesktopLibrary/detect'
import { createRekordboxDesktopPlaylist } from '../services/rekordboxDesktopLibrary/createPlaylist'
import {
  createRekordboxDesktopEmptyPlaylist,
  createRekordboxDesktopPlaylistFolder
} from '../services/rekordboxDesktopLibrary/playlistFolder'
import { moveRekordboxDesktopPlaylist } from '../services/rekordboxDesktopLibrary/movePlaylist'
import {
  deleteRekordboxDesktopPlaylistNode,
  renameRekordboxDesktopPlaylistNode
} from '../services/rekordboxDesktopLibrary/playlistNode'
import { loadRekordboxDesktopPlaylistTree } from '../services/rekordboxDesktopLibrary/tree'
import {
  loadRekordboxDesktopPlaylistTracks,
  attachRekordboxDesktopPlaylistRuntime,
  reorderRekordboxDesktopPlaylistTracks,
  removeRekordboxDesktopPlaylistTracks
} from '../services/rekordboxDesktopLibrary/tracks'
import {
  loadRekordboxDesktopPreviewWaveforms,
  streamRekordboxDesktopPreviewWaveforms
} from '../services/rekordboxDesktopLibrary/waveform'
import { loadRekordboxDesktopDetailWaveforms } from '../services/rekordboxDesktopLibrary/detailWaveform'
import {
  cleanupCopiedTracks,
  copyTracksToRekordboxDesktopStorage
} from '../services/rekordboxDesktopLibrary/storage'
import { buildPioneerPlaylistTree } from '../services/pioneerDeviceLibrary/tree'
import type {
  RekordboxDesktopCreateEmptyPlaylistRequest,
  RekordboxDesktopCreateEmptyPlaylistResponse,
  RekordboxDesktopPlaylistRequest,
  RekordboxDesktopPlaylistResponse,
  RekordboxDesktopCreateFolderRequest,
  RekordboxDesktopCreateFolderResponse,
  RekordboxDesktopDeletePlaylistRequest,
  RekordboxDesktopDeletePlaylistResponse,
  RekordboxDesktopReorderPlaylistTracksRequest,
  RekordboxDesktopReorderPlaylistTracksResponse,
  RekordboxDesktopRemovePlaylistTracksRequest,
  RekordboxDesktopRemovePlaylistTracksResponse,
  RekordboxDesktopRenamePlaylistRequest,
  RekordboxDesktopRenamePlaylistResponse
} from '../../shared/rekordboxDesktopPlaylist'
import type {
  RekordboxDesktopMovePlaylistRequest,
  RekordboxDesktopMovePlaylistResponse
} from '../../shared/rekordboxDesktopPlaylist'
import type {
  RekordboxDesktopCopyTracksToStorageRequest,
  RekordboxDesktopCopyTracksToStorageResponse
} from '../../shared/rekordboxDesktopPlaylist'
import type { RekordboxDesktopCleanupCopiedTracksRequest } from '../../shared/rekordboxDesktopPlaylist'
import type { IPioneerPlaylistTrack } from '../../types/globals'

export function registerRekordboxDesktopLibraryHandlers() {
  const mimeFromExt = (ext: string) =>
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.bmp'
            ? 'image/bmp'
            : 'image/jpeg'

  ipcMain.handle('rekordbox-desktop-library:probe', async () => {
    return await probeRekordboxDesktopLibrary(false)
  })

  ipcMain.handle('rekordbox-desktop-library:probe-write', async () => {
    return await probeRekordboxDesktopLibraryWriteAvailability(true)
  })

  ipcMain.handle('rekordbox-desktop-library:load-tree', async () => {
    const loaded = await loadRekordboxDesktopPlaylistTree()
    return {
      ...loaded.probe,
      treeNodes: buildPioneerPlaylistTree(loaded.nodes)
    }
  })

  ipcMain.handle(
    'rekordbox-desktop-library:load-playlist-tracks',
    async (_event, playlistId: number) => {
      const loaded = await loadRekordboxDesktopPlaylistTracks(playlistId)
      return {
        ...loaded.probe,
        playlistId: loaded.playlistId,
        playlistName: loaded.playlistName,
        trackTotal: loaded.trackTotal,
        tracks: loaded.tracks
      }
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:load-playlist-tracks-meta',
    async (_event, playlistId: number) => {
      const loaded = await loadRekordboxDesktopPlaylistTracks(playlistId, { includeRuntime: false })
      return {
        ...loaded.probe,
        playlistId: loaded.playlistId,
        playlistName: loaded.playlistName,
        trackTotal: loaded.trackTotal,
        tracks: loaded.tracks
      }
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:attach-playlist-tracks-runtime',
    async (_event, tracks: unknown) => {
      const nextTracks = await attachRekordboxDesktopPlaylistRuntime(
        Array.isArray(tracks) ? (tracks as IPioneerPlaylistTrack[]) : []
      )
      return { tracks: nextTracks }
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:create-playlist',
    async (
      _event,
      request: RekordboxDesktopPlaylistRequest
    ): Promise<RekordboxDesktopPlaylistResponse> => {
      return await createRekordboxDesktopPlaylist(request, {
        reportProgress: (payload) => {
          mainWindow.instance?.webContents.send('progressSet', payload)
        }
      })
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:create-empty-playlist',
    async (
      _event,
      request: RekordboxDesktopCreateEmptyPlaylistRequest
    ): Promise<RekordboxDesktopCreateEmptyPlaylistResponse> => {
      return await createRekordboxDesktopEmptyPlaylist(request)
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:create-folder',
    async (
      _event,
      request: RekordboxDesktopCreateFolderRequest
    ): Promise<RekordboxDesktopCreateFolderResponse> => {
      return await createRekordboxDesktopPlaylistFolder(request)
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:move-playlist',
    async (
      _event,
      request: RekordboxDesktopMovePlaylistRequest
    ): Promise<RekordboxDesktopMovePlaylistResponse> => {
      return await moveRekordboxDesktopPlaylist(request)
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:rename-playlist',
    async (
      _event,
      request: RekordboxDesktopRenamePlaylistRequest
    ): Promise<RekordboxDesktopRenamePlaylistResponse> => {
      return await renameRekordboxDesktopPlaylistNode(request)
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:delete-playlist',
    async (
      _event,
      request: RekordboxDesktopDeletePlaylistRequest
    ): Promise<RekordboxDesktopDeletePlaylistResponse> => {
      return await deleteRekordboxDesktopPlaylistNode(request)
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:remove-playlist-tracks',
    async (
      _event,
      request: RekordboxDesktopRemovePlaylistTracksRequest
    ): Promise<RekordboxDesktopRemovePlaylistTracksResponse> => {
      return await removeRekordboxDesktopPlaylistTracks(request)
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:reorder-playlist-tracks',
    async (
      _event,
      request: RekordboxDesktopReorderPlaylistTracksRequest
    ): Promise<RekordboxDesktopReorderPlaylistTracksResponse> => {
      return await reorderRekordboxDesktopPlaylistTracks(request)
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:copy-tracks-to-storage',
    async (
      _event,
      request: RekordboxDesktopCopyTracksToStorageRequest
    ): Promise<RekordboxDesktopCopyTracksToStorageResponse> => {
      const jobId = `rekordbox-desktop-copy-${Date.now()}`
      return await copyTracksToRekordboxDesktopStorage(request, {
        jobId,
        reportProgress: (payload) => {
          mainWindow.instance?.webContents.send('progressSet', payload)
        }
      })
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:cleanup-copied-tracks',
    async (_event, request: RekordboxDesktopCleanupCopiedTracksRequest) => {
      await cleanupCopiedTracks(Array.isArray(request?.filePaths) ? request.filePaths : [])
      return { ok: true }
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:get-preview-waveforms',
    async (_event, rootPath: string, analyzePaths: string[]) => {
      return await loadRekordboxDesktopPreviewWaveforms(rootPath, analyzePaths)
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:get-detail-waveforms',
    async (_event, rootPath: string, analyzePaths: string[]) => {
      return await loadRekordboxDesktopDetailWaveforms(rootPath, analyzePaths)
    }
  )

  ipcMain.on(
    'rekordbox-desktop-library:stream-preview-waveforms',
    async (
      event,
      payload: {
        requestId?: string
        rootPath?: string
        analyzePaths?: string[]
      }
    ) => {
      const requestId = String(payload?.requestId || '').trim()
      if (!requestId) return
      const rootPath = String(payload?.rootPath || '').trim()
      const analyzePaths = Array.isArray(payload?.analyzePaths) ? payload.analyzePaths : []

      try {
        const result = await streamRekordboxDesktopPreviewWaveforms(
          rootPath,
          analyzePaths,
          (item) => {
            try {
              event.sender.send('rekordbox-desktop-library:preview-waveform-item', {
                requestId,
                ...item
              })
            } catch {}
          }
        )
        try {
          event.sender.send('rekordbox-desktop-library:preview-waveform-done', {
            requestId,
            rootPath: result.rootPath,
            total: result.total
          })
        } catch {}
      } catch (error) {
        try {
          event.sender.send('rekordbox-desktop-library:preview-waveform-done', {
            requestId,
            error: error instanceof Error ? error.message : String(error || 'unknown error')
          })
        } catch {}
      }
    }
  )

  ipcMain.handle('rekordbox-desktop-library:get-cover-thumb', async (_event, coverPath: string) => {
    const normalized = String(coverPath || '').trim()
    if (!normalized) return null
    try {
      const data = await fs.readFile(normalized)
      const mime = mimeFromExt(path.extname(normalized).toLowerCase())
      return {
        format: mime,
        data,
        dataUrl: `data:${mime};base64,${data.toString('base64')}`
      }
    } catch {
      return null
    }
  })
}
