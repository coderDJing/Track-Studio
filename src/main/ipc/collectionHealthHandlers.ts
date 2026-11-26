import { ipcMain } from 'electron'
import mainWindow from '../window/mainWindow'
import { isLibraryMergeMutationLocked } from '../services/libraryMerge/runtime'
import {
  getCollectionHealthSnapshot,
  markDuplicateGroupNotDuplicate,
  removeCollectionHealthTracks,
  removeDuplicateTracks,
  setCollectionHealthIgnore,
  setCollectionHealthSnapshotSender,
  startCollectionHealthScan,
  stopCollectionHealthScan
} from '../services/collectionHealth/scan'
import { unifyAlbumTags } from '../services/collectionHealth/actions'
import type {
  CollectionHealthCheck,
  CollectionHealthIgnoreToggleRequest,
  CollectionHealthMarkDuplicateFalseRequest,
  CollectionHealthRemoveDuplicatesRequest,
  CollectionHealthRemoveTracksRequest,
  CollectionHealthStartRequest,
  CollectionHealthUnifyAlbumRequest,
  CollectionHealthTrackRef
} from '../../shared/collectionHealth'
import type { CoreLibraryName } from '../coreLibraries'

const SUPPORTED_LIBRARIES = new Set<string>(['FilterLibrary', 'CuratedLibrary', 'SetLibrary'])

const isSupportedLibrary = (value: unknown): value is CoreLibraryName =>
  typeof value === 'string' && SUPPORTED_LIBRARIES.has(value)

const isValidRef = (value: unknown): value is CollectionHealthTrackRef => {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  return typeof ref.listRoot === 'string' && typeof ref.filePath === 'string'
}

const isValidCheck = (value: unknown): value is CollectionHealthCheck =>
  value === 'lowBitrate' || value === 'noCover' || value === 'albumTags' || value === 'duplicates'

const sendSnapshot = () => {
  const targetWindow = mainWindow.instance
  if (!targetWindow || targetWindow.isDestroyed()) return
  const snapshot = getCollectionHealthSnapshot()
  if (!snapshot) return
  try {
    targetWindow.webContents.send('collection-health:snapshot-updated', snapshot)
  } catch {}
}

const emitProgress = (
  progressId: string,
  titleKey: string,
  now: number,
  total: number,
  isInitial = false
) => {
  if (!mainWindow.instance) return
  mainWindow.instance.webContents.send('progressSet', {
    id: progressId,
    titleKey,
    now,
    total,
    isInitial
  })
}

export function registerCollectionHealthHandlers() {
  setCollectionHealthSnapshotSender(() => sendSnapshot())

  ipcMain.handle('collection-health:start', async (_e, payload?: CollectionHealthStartRequest) => {
    if (!payload || !isSupportedLibrary(payload.libraryName)) return null
    if (isLibraryMergeMutationLocked()) return null
    return await startCollectionHealthScan({
      libraryName: payload.libraryName,
      lowBitrateThresholdKbps:
        typeof payload.lowBitrateThresholdKbps === 'number'
          ? payload.lowBitrateThresholdKbps
          : undefined
    })
  })

  ipcMain.handle('collection-health:stop', (_e, payload?: { requestId?: number }) => {
    stopCollectionHealthScan(typeof payload?.requestId === 'number' ? payload.requestId : undefined)
  })

  ipcMain.handle('collection-health:get-snapshot', (_e, payload?: { requestId?: number }) => {
    return getCollectionHealthSnapshot(
      typeof payload?.requestId === 'number' ? payload.requestId : undefined
    )
  })

  ipcMain.handle(
    'collection-health:set-ignore',
    (_e, payload?: CollectionHealthIgnoreToggleRequest) => {
      if (!payload || typeof payload.requestId !== 'number') return null
      if (!isValidRef(payload) || !isValidCheck(payload.check)) return null
      return setCollectionHealthIgnore({
        requestId: payload.requestId,
        listRoot: payload.listRoot,
        filePath: payload.filePath,
        check: payload.check,
        ignored: payload.ignored !== false
      })
    }
  )

  ipcMain.handle(
    'collection-health:mark-not-duplicate',
    (_e, payload?: CollectionHealthMarkDuplicateFalseRequest) => {
      if (!payload || typeof payload.requestId !== 'number') return null
      if (typeof payload.groupId !== 'string' || !payload.groupId) return null
      return markDuplicateGroupNotDuplicate({
        requestId: payload.requestId,
        groupId: payload.groupId
      })
    }
  )

  ipcMain.handle(
    'collection-health:remove-duplicates',
    async (_e, payload?: CollectionHealthRemoveDuplicatesRequest) => {
      if (!payload || typeof payload.requestId !== 'number') return null
      if (isLibraryMergeMutationLocked()) return null
      if (!isValidRef(payload.keep) || !Array.isArray(payload.remove)) return null
      const remove = payload.remove.filter(isValidRef)
      if (!remove.length) return null
      return await removeDuplicateTracks({
        requestId: payload.requestId,
        keep: payload.keep,
        remove
      })
    }
  )

  ipcMain.handle(
    'collection-health:remove-tracks',
    async (_e, payload?: CollectionHealthRemoveTracksRequest) => {
      if (!payload || typeof payload.requestId !== 'number') return null
      if (isLibraryMergeMutationLocked()) return null
      if (!Array.isArray(payload.tracks)) return null
      const tracks = payload.tracks.filter(isValidRef)
      if (!tracks.length) return null
      return await removeCollectionHealthTracks({
        requestId: payload.requestId,
        tracks
      })
    }
  )

  ipcMain.handle(
    'collection-health:unify-album',
    async (_e, payload?: CollectionHealthUnifyAlbumRequest) => {
      if (!payload || typeof payload.requestId !== 'number') return null
      if (isLibraryMergeMutationLocked()) return null
      if (typeof payload.album !== 'string' || !payload.album.trim()) return null
      if (!Array.isArray(payload.tracks)) return null
      const tracks = payload.tracks.filter(isValidRef)
      if (!tracks.length) return null
      const progressId = `collection_health_album_${payload.requestId}_${Date.now()}`
      let lastEmitAt = 0
      return await unifyAlbumTags(
        { requestId: payload.requestId, album: payload.album, tracks },
        (done, total) => {
          const now = Date.now()
          if (done < total && now - lastEmitAt < 200) return
          lastEmitAt = now
          emitProgress(progressId, 'collectionHealth.unifyAlbumProgress', done, total, done === 0)
        }
      )
    }
  )
}
