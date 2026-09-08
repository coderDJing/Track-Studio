import { ipcMain } from 'electron'
import { log } from '../log'
import {
  getSongCover as svcGetSongCover,
  getSongCoverThumb as svcGetSongCoverThumb,
  persistSongCoverDisplayCache as svcPersistSongCoverDisplayCache,
  sweepSongListCovers as svcSweepSongListCovers
} from '../services/covers'
import {
  readTrackMetadata as svcReadTrackMetadata,
  updateTrackMetadata as svcUpdateTrackMetadata
} from '../services/metadataEditor'
import { autoFillTrackMetadata, cancelMetadataAutoFill } from '../services/metadataAutoFill'
import {
  searchMusicBrainz,
  fetchMusicBrainzSuggestion,
  cancelMusicBrainzRequests
} from '../services/musicBrainz'
import {
  matchTrackWithAcoustId,
  cancelAcoustIdRequests,
  validateAcoustIdClientKeyValue,
  getAcoustIdClientKeyStatus
} from '../services/acoustId'
import {
  findSimilarTracksBatch,
  cancelSimilarTracksBatch,
  getSimilarTrackBlockedRecommendationKeys,
  blockSimilarTrackRecommendation
} from '../services/similarTracks'
import {
  IMusicBrainzSearchPayload,
  IMusicBrainzSuggestionParams,
  IMusicBrainzAcoustIdPayload,
  ITrackMetadataUpdatePayload,
  IMetadataAutoFillRequest,
  ISimilarTracksBatchRequest,
  ISimilarTrackBlockTarget
} from '../../types/globals'
import { isLibraryMergeMutationLocked } from '../services/libraryMerge/runtime'
import { scheduleCuratedLibrarySyncIfUnderCurated } from '../cloudSyncScheduler'
import {
  SongCoverSessionRegistry,
  type SongCoverSessionContext
} from '../services/songCoverSessions'

const songCoverSessions = new SongCoverSessionRegistry()
const songCoverCleanupAttachedSenderIds = new Set<number>()

type PersistSongCoverDisplayCachePayload = {
  filePath?: unknown
  listRootDir?: unknown
  imageHash?: unknown
  legacyExt?: unknown
  format?: unknown
  data?: unknown
  requestContext?: SongCoverSessionContext
}

type MetadataUpdateError = {
  message?: unknown
  stderr?: unknown
  exitCode?: unknown
  code?: unknown
}

export function registerMediaMetadataHandlers() {
  ipcMain.handle('getSongCover', async (_e, filePath: string) => {
    return await svcGetSongCover(filePath)
  })

  ipcMain.handle(
    'getSongCoverThumb',
    async (
      event,
      filePath: string,
      size: number = 48,
      listRootDir?: string | null,
      requestContext?: SongCoverSessionContext
    ) => {
      const senderId = event.sender.id
      const session = songCoverSessions.activate(senderId, requestContext)
      if (session) {
        if (!songCoverCleanupAttachedSenderIds.has(senderId)) {
          songCoverCleanupAttachedSenderIds.add(senderId)
          event.sender.once('destroyed', () => {
            songCoverCleanupAttachedSenderIds.delete(senderId)
            songCoverSessions.clearSender(senderId)
          })
        }
      }
      return await svcGetSongCoverThumb(filePath, size, listRootDir, {
        priority: requestContext?.priority === 'prefetch' ? 'prefetch' : 'visible',
        shouldAbort: () =>
          event.sender.isDestroyed() || (!!session && songCoverSessions.isStale(session))
      })
    }
  )

  ipcMain.on('cancelSongCoverSession', (event, requestContext?: SongCoverSessionContext) => {
    songCoverSessions.cancel(event.sender.id, requestContext)
  })

  ipcMain.handle(
    'persistSongCoverDisplayCache',
    async (event, payload?: PersistSongCoverDisplayCachePayload) => {
      const session = songCoverSessions.activate(event.sender.id, payload?.requestContext)
      const data =
        payload?.data instanceof Uint8Array
          ? payload.data
          : payload?.data &&
              typeof payload.data === 'object' &&
              'data' in payload.data &&
              Array.isArray(payload.data.data)
            ? new Uint8Array(payload.data.data)
            : null
      if (!data) return false
      return await svcPersistSongCoverDisplayCache({
        filePath: typeof payload?.filePath === 'string' ? payload.filePath : '',
        listRootDir: typeof payload?.listRootDir === 'string' ? payload.listRootDir : '',
        imageHash: typeof payload?.imageHash === 'string' ? payload.imageHash : '',
        legacyExt: typeof payload?.legacyExt === 'string' ? payload.legacyExt : undefined,
        format: typeof payload?.format === 'string' ? payload.format : 'image/jpeg',
        data,
        context: {
          priority: payload?.requestContext?.priority === 'prefetch' ? 'prefetch' : 'visible',
          shouldAbort: () =>
            event.sender.isDestroyed() || (!!session && songCoverSessions.isStale(session))
        }
      })
    }
  )

  ipcMain.handle(
    'sweepSongListCovers',
    async (_e, listRootDir: string, currentFilePaths: string[]) => {
      return await svcSweepSongListCovers(listRootDir, currentFilePaths)
    }
  )

  ipcMain.handle('audio:metadata:get', async (_e, filePath: string) => {
    return await svcReadTrackMetadata(filePath)
  })

  ipcMain.handle('audio:metadata:update', async (_e, payload: ITrackMetadataUpdatePayload) => {
    if (isLibraryMergeMutationLocked()) {
      return {
        success: false,
        message: 'library-merge-in-progress',
        errorCode: 'LIBRARY_MERGE_IN_PROGRESS',
        errorDetail: ''
      }
    }
    try {
      const result = await svcUpdateTrackMetadata(payload)
      scheduleCuratedLibrarySyncIfUnderCurated([
        payload?.filePath,
        result.renamedFrom,
        result.songInfo?.filePath
      ])
      return {
        success: true,
        songInfo: result.songInfo,
        detail: result.detail,
        renamedFrom: result.renamedFrom
      }
    } catch (error) {
      const detail = error && typeof error === 'object' ? (error as MetadataUpdateError) : null
      log.error('更新音频元数据失败', {
        filePath: payload?.filePath,
        error: detail?.message || error,
        stderr: detail?.stderr,
        exitCode: detail?.exitCode
      })
      return {
        success: false,
        message: detail?.message || 'metadata-update-failed',
        errorCode: detail?.code || detail?.message || 'metadata-update-failed',
        errorDetail: detail?.stderr || ''
      }
    }
  })

  ipcMain.handle('metadata:autoFill', async (_e, payload: IMetadataAutoFillRequest) => {
    if (isLibraryMergeMutationLocked()) {
      throw new Error('LIBRARY_MERGE_IN_PROGRESS')
    }
    return await autoFillTrackMetadata(
      payload && Array.isArray(payload.filePaths) ? payload : { filePaths: [] }
    ).then((result) => {
      scheduleCuratedLibrarySyncIfUnderCurated(
        payload && Array.isArray(payload.filePaths) ? payload.filePaths : []
      )
      return result
    })
  })
  ipcMain.handle('metadata:autoFill:cancel', async (_e, progressId: string) => {
    cancelMetadataAutoFill(typeof progressId === 'string' ? progressId : '')
  })

  ipcMain.handle('musicbrainz:search', async (_e, payload: IMusicBrainzSearchPayload) => {
    return await searchMusicBrainz(payload)
  })

  ipcMain.handle('musicbrainz:suggest', async (_e, payload: IMusicBrainzSuggestionParams) => {
    return await fetchMusicBrainzSuggestion(payload)
  })

  ipcMain.handle('musicbrainz:cancelRequests', async () => {
    cancelMusicBrainzRequests()
  })

  ipcMain.handle('musicbrainz:acoustidMatch', async (_e, payload: IMusicBrainzAcoustIdPayload) => {
    return await matchTrackWithAcoustId(payload)
  })

  ipcMain.handle('acoustid:validateClientKey', async (_e, clientKey: string) => {
    await validateAcoustIdClientKeyValue(typeof clientKey === 'string' ? clientKey : '')
  })

  ipcMain.handle('acoustid:getClientKeyStatus', () => {
    return getAcoustIdClientKeyStatus()
  })

  ipcMain.handle('acoustid:cancelRequests', async () => {
    cancelAcoustIdRequests()
  })

  ipcMain.handle('similarTracks:findBatch', async (_e, payload: ISimilarTracksBatchRequest) => {
    return await findSimilarTracksBatch(payload)
  })

  ipcMain.handle('similarTracks:getBlockedRecommendationKeys', async () => {
    return await getSimilarTrackBlockedRecommendationKeys()
  })

  ipcMain.handle(
    'similarTracks:blockRecommendation',
    async (_e, payload: ISimilarTrackBlockTarget) => {
      return await blockSimilarTrackRecommendation(payload)
    }
  )

  ipcMain.handle('similarTracks:cancelBatch', async (_e, progressId: string) => {
    cancelSimilarTracksBatch(typeof progressId === 'string' ? progressId : '')
  })
}
