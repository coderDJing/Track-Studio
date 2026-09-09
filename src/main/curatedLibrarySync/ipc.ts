import { ipcMain } from 'electron'
import store from '../store'
import {
  cancelCuratedLibrarySync,
  completeCuratedLibrarySyncStatus,
  getCuratedLibrarySyncActivity,
  getCuratedLibrarySyncStatus,
  isCuratedLibrarySyncRunning,
  runCuratedLibrarySync
} from './engine'
import { enqueueCloudWork, enqueueCuratedLibrarySync } from './queue'
import { fetchCuratedLibraryStatus, resetCloudCuratedLibrary } from './apiClient'
import { isCuratedLibraryLiveConnected, syncCuratedLibraryLiveSync } from './liveSync'
import {
  clearPendingCuratedLibraryJoinPrompt,
  getPendingCuratedLibraryJoinPrompt
} from './joinPrompt'
import {
  forgetCuratedLibrarySyncJoinState,
  isCuratedLibrarySyncEnabled,
  readCuratedLibrarySyncConflicts,
  readCuratedLibrarySyncFailures,
  readCuratedLibrarySyncQuotaCache,
  writeCuratedLibrarySyncConflicts,
  writeCuratedLibrarySyncFailures,
  writeCuratedLibrarySyncQuotaCache
} from '../librarySettingsDb'
import { parseConflictItems, parseFailureItems } from './reports'
import { is } from '@electron-toolkit/utils'
import { resolveDevCloudSyncUserKey } from '../../shared/cloudSyncDevUserKey'
import type {
  CuratedLibrarySyncOverview,
  CuratedLibrarySyncStartPayload
} from '../../shared/curatedLibrarySync'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const withActivity = (
  overview: Omit<CuratedLibrarySyncOverview, 'activity'>
): CuratedLibrarySyncOverview => ({
  ...overview,
  activity: getCuratedLibrarySyncActivity()
})

const readQuotaCache = () => {
  const raw = readCuratedLibrarySyncQuotaCache()
  if (!isRecord(raw)) {
    return {
      quotaUsedBytes: 0,
      quotaBytes: 0,
      fileCount: 0,
      revision: 0,
      snapshotReady: false
    }
  }
  return {
    quotaUsedBytes: Number(raw.quotaUsedBytes) || 0,
    quotaBytes: Number(raw.quotaBytes) || 0,
    fileCount: Number(raw.fileCount) || 0,
    revision: Number(raw.revision) || 0,
    snapshotReady: raw.snapshotReady === true
  }
}

const buildOverview = async (): Promise<CuratedLibrarySyncOverview> => {
  const cached = readQuotaCache()
  const conflicts = parseConflictItems(readCuratedLibrarySyncConflicts())
  const failures = parseFailureItems(readCuratedLibrarySyncFailures())
  const cachedOverview = {
    liveConnected: isCuratedLibraryLiveConnected(),
    snapshotReady: cached.snapshotReady,
    revision: cached.revision,
    fileCount: cached.fileCount,
    quotaUsedBytes: cached.quotaUsedBytes,
    quotaBytes: cached.quotaBytes,
    conflicts,
    failures
  }
  const userKey = resolveDevCloudSyncUserKey(
    String(store.settingConfig?.cloudSyncUserKey || '').trim(),
    is.dev
  )
  if (!userKey) {
    return withActivity({
      ...cachedOverview,
      liveConnected: false
    })
  }
  // 首次静默上传时云端快照还是 0 首；不要每次刷新都打 status，以免把设置页卡住。
  if (isCuratedLibrarySyncRunning()) {
    return withActivity(cachedOverview)
  }
  try {
    const status = await fetchCuratedLibraryStatus()
    writeCuratedLibrarySyncQuotaCache({
      quotaUsedBytes: status.blobBytes,
      quotaBytes: status.quotaBytes,
      fileCount: status.fileCount,
      revision: status.revision,
      snapshotReady: status.snapshotReady
    })
    return withActivity({
      liveConnected: isCuratedLibraryLiveConnected(),
      snapshotReady: status.snapshotReady,
      revision: status.revision,
      fileCount: status.fileCount,
      quotaUsedBytes: status.blobBytes,
      quotaBytes: status.quotaBytes,
      conflicts,
      failures
    })
  } catch {
    return withActivity(cachedOverview)
  }
}

export const registerCuratedLibrarySyncIpc = (): void => {
  ipcMain.handle(
    'curatedLibrarySync/start',
    async (_event, payload?: CuratedLibrarySyncStartPayload) => {
      return enqueueCuratedLibrarySync(payload)
    }
  )
  ipcMain.handle('curatedLibrarySync/cancel', async () => cancelCuratedLibrarySync())
  ipcMain.handle('curatedLibrarySync/isRunning', () => isCuratedLibrarySyncRunning())
  ipcMain.handle('curatedLibrarySync/isLiveConnected', () => isCuratedLibraryLiveConnected())
  ipcMain.handle('curatedLibrarySync/getStatus', () => getCuratedLibrarySyncStatus())
  ipcMain.handle('curatedLibrarySync/getOverview', () => buildOverview())
  ipcMain.handle('curatedLibrarySync/clearConflicts', () => {
    writeCuratedLibrarySyncConflicts([])
    return { ok: true }
  })
  ipcMain.handle('curatedLibrarySync/clearFailures', () => {
    writeCuratedLibrarySyncFailures([])
    return { ok: true }
  })
  ipcMain.handle('curatedLibrarySync/retryFailures', async () => {
    return enqueueCuratedLibrarySync({ trigger: 'manual' })
  })
  ipcMain.handle('curatedLibrarySync/getPendingJoin', () => getPendingCuratedLibraryJoinPrompt())
  ipcMain.handle('curatedLibrarySync/clearPendingJoin', () => {
    clearPendingCuratedLibraryJoinPrompt()
    return { ok: true }
  })
  ipcMain.handle('curatedLibrarySync/resetCloud', async () => {
    const userKey = resolveDevCloudSyncUserKey(
      String(store.settingConfig?.cloudSyncUserKey || '').trim(),
      is.dev
    )
    if (!userKey) {
      return { success: false, message: 'cloudSync.notConfigured' }
    }
    await cancelCuratedLibrarySync()
    const waitUntil = Date.now() + 15000
    while (isCuratedLibrarySyncRunning() && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return enqueueCloudWork(async () => {
      try {
        await resetCloudCuratedLibrary()
        forgetCuratedLibrarySyncJoinState()
        syncCuratedLibraryLiveSync()
        if (isCuratedLibrarySyncEnabled()) {
          const aligned = await runCuratedLibrarySync({ trigger: 'manual', joinMode: 'cloud-wins' })
          completeCuratedLibrarySyncStatus(aligned)
          if (aligned.status !== 'success') {
            return {
              success: false,
              message:
                aligned.status === 'failed'
                  ? aligned.message
                  : aligned.status === 'disk_full'
                    ? 'cloudSync.curatedLibrary.errors.diskFull'
                    : aligned.status === 'busy_library'
                      ? 'cloudSync.curatedLibrary.errors.busyLibrary'
                      : 'cloudSync.curatedLibrary.errors.failed'
            }
          }
        }
        return { success: true }
      } catch (error) {
        const payload =
          error && typeof error === 'object' && 'payload' in error
            ? (error as { payload?: unknown }).payload
            : null
        const body = isRecord(payload) ? payload : null
        const code = String(body?.error || '').toUpperCase()
        if (code === 'INVALID_USER_KEY' || code === 'USER_KEY_NOT_FOUND') {
          return { success: false, message: 'cloudSync.errors.keyInvalid' }
        }
        if (code === 'USER_KEY_INACTIVE') {
          return { success: false, message: 'cloudSync.errors.keyDisabled' }
        }
        if (code === 'STRICT_RATE_LIMIT_EXCEEDED') {
          return { success: false, message: 'cloudSync.errors.sensitiveOperationTooFrequent' }
        }
        if (code === 'RATE_LIMIT_EXCEEDED' || code === 'SYNC_RATE_LIMIT_EXCEEDED') {
          return { success: false, message: 'cloudSync.errors.tooFrequent' }
        }
        return { success: false, message: 'cloudSync.errors.cannotConnect' }
      }
    })
  })
}
