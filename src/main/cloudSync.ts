import { ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import store from './store'
import { getCollectionHashForSync, unionFingerprintList } from './fingerprintStore'
import { log } from './log'
import mainWindow from './window/mainWindow'
import { persistSettingConfig } from './settingsPersistence'
import { fetchWithSystemProxy } from './fetchWithSystemProxy'
import {
  getCuratedArtistSyncErrorPayload,
  isCuratedArtistSyncUnsupportedServer,
  syncCuratedArtistCloudSnapshot
} from './curatedArtistCloudSync'
import { resolveBaseUrl } from './serverDiscovery'
import type { CloudSyncTrigger } from '../types/cloudSync'
import { resolveDevCloudSyncUserKey } from '../shared/cloudSyncDevUserKey'
import { isCuratedLibrarySyncEnabled, saveLibrarySettingsFromConfig } from './librarySettingsDb'
import { bindCloudSyncScheduler, restartCloudSyncScheduler } from './cloudSyncScheduler'
import { syncCuratedLibraryLiveSync } from './curatedLibrarySync/liveSync'
import { enqueueCloudWork } from './curatedLibrarySync/queue'

const CLOUD_SYNC = {
  PREFIX: '/frkbapi/v1/fingerprint-sync',
  API_SECRET_KEY: process.env.CLOUD_SYNC_API_SECRET_KEY || ''
}

type CloudSyncConfig = { userKey?: string }
let cloudSyncConfig: CloudSyncConfig = {}
type RecordLike = Record<string, unknown>
type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]
type FingerprintMode = 'pcm' | 'file'
type ErrorLike = {
  message?: unknown
  code?: unknown
  cause?: unknown
}
type ValidateUserKeyResponse = {
  success?: boolean
  data?: {
    isActive?: boolean
    userKey?: string
  }
  error?: unknown
  limit?: unknown
  status?: number
}

const isRecord = (value: unknown): value is RecordLike =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const getFingerprintMode = (): FingerprintMode =>
  store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'

// 简单的全局节流器：相邻请求至少间隔 650ms，保证每分钟 <= 100 次
const RATE_LIMIT_MIN_INTERVAL_MS = 650
function createRateLimiter(minIntervalMs: number) {
  let nextAvailableAt = 0
  return async function limitOnce() {
    const now = Date.now()
    const scheduledAt = Math.max(now, nextAvailableAt)
    const waitMs = Math.max(0, scheduledAt - now)
    nextAvailableAt = scheduledAt + minIntervalMs
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
}
const limitRequestOnce = createRateLimiter(RATE_LIMIT_MIN_INTERVAL_MS)
async function limitedFetch(input: FetchInput, init?: FetchInit) {
  await limitRequestOnce()
  return await fetchWithSystemProxy(input, init)
}

// 同步启动频控：5 分钟内最多 10 次
const SYNC_WINDOW_MS = 5 * 60 * 1000
const SYNC_MAX_IN_WINDOW = 10
let syncStartTimestamps: number[] = []
let cloudSyncRunning = false

function isScheduledTrigger(trigger: CloudSyncTrigger): boolean {
  return trigger === 'scheduled'
}

function isActionableScheduledFailure(message: string, error?: unknown): boolean {
  if (
    message === 'cloudSync.errors.keyInvalid' ||
    message === 'cloudSync.errors.keyDisabled' ||
    message === 'cloudSync.errors.limitExceeded' ||
    message === 'cloudSync.errors.limitExceededOnCheck'
  ) {
    return true
  }
  const body = isRecord(error) ? error : null
  const nested = isRecord(body?.error) ? body.error : body
  const code = String(nested?.code || nested?.error || body?.error || '').toUpperCase()
  return (
    code === 'INVALID_USER_KEY' ||
    code === 'USER_KEY_NOT_FOUND' ||
    code === 'USER_KEY_INACTIVE' ||
    code === 'FINGERPRINT_LIMIT_EXCEEDED'
  )
}
function canStartSyncNow() {
  const now = Date.now()
  syncStartTimestamps = syncStartTimestamps.filter((t) => now - t < SYNC_WINDOW_MS)
  return syncStartTimestamps.length < SYNC_MAX_IN_WINDOW
}
function markSyncStarted() {
  syncStartTimestamps.push(Date.now())
}

// 将后端错误结构标准化为前端 i18n key（避免直接透传中文 message）
function mapBackendErrorToI18nKey(payload: unknown): string {
  const body = isRecord(payload) ? payload : null
  const error = String(body?.error || '').toUpperCase()
  switch (error) {
    case 'INVALID_API_KEY':
      return 'cloudSync.errors.cannotConnect'
    case 'INVALID_USER_KEY':
    case 'USER_KEY_NOT_FOUND':
      return 'cloudSync.errors.keyInvalid'
    case 'USER_KEY_INACTIVE':
      return 'cloudSync.errors.keyDisabled'
    case 'DIFF_SESSION_NOT_FOUND':
      return 'cloudSync.errors.sessionNotExist'
    case 'DIFF_SESSION_USER_MISMATCH':
      return 'cloudSync.errors.keyMismatch'
    case 'REQUEST_TOO_LARGE':
      return 'cloudSync.errors.requestTooLarge'
    case 'VALIDATION_ERROR':
      return 'cloudSync.errors.validationFailed'
    case 'INVALID_CURATED_ARTIST_SNAPSHOT':
      return 'cloudSync.errors.curatedArtistValidationFailed'
    case 'SYNC_RATE_LIMIT_EXCEEDED':
    case 'RATE_LIMIT_EXCEEDED':
      return 'cloudSync.errors.tooFrequent'
    case 'STRICT_RATE_LIMIT_EXCEEDED':
      return 'cloudSync.errors.sensitiveOperationTooFrequent'
    case 'FINGERPRINT_LIMIT_EXCEEDED':
      return 'cloudSync.errors.limitExceeded'
  }
  const backendMsg = String(body?.message || '')
  if (backendMsg.includes('请求参数验证失败')) return 'cloudSync.errors.validationFailed'
  if (backendMsg.includes('分页拉取差异数据失败')) return 'cloudSync.errors.pullDiffPageFailed'
  if (backendMsg.includes('请求体大小超过限制')) return 'cloudSync.errors.requestTooLarge'
  return 'cloudSync.errors.validationFailed'
}

async function validateUserKeyRequest(
  userKeyRaw: string,
  baseUrl: string
): Promise<ValidateUserKeyResponse> {
  const userKey = (userKeyRaw || '').trim()
  const requestBody = { userKey }
  const res = await limitedFetch(`${baseUrl}${CLOUD_SYNC.PREFIX}/validate-user-key`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  })
  const responseText = await res.text()
  if (!responseText.trim()) {
    return { success: false, error: 'EMPTY_RESPONSE', status: res.status }
  }
  try {
    const parsed: unknown = JSON.parse(responseText)
    if (!isRecord(parsed)) {
      return { success: false, error: 'INVALID_RESPONSE', status: res.status }
    }
    return parsed as ValidateUserKeyResponse
  } catch {
    return { success: false, error: 'INVALID_JSON_RESPONSE', status: res.status }
  }
}

const persistDevUserKeyIfNeeded = (userKey: string) => {
  if (!is.dev) return
  if (String(store.settingConfig?.cloudSyncUserKey || '').trim() === userKey) return
  store.settingConfig.cloudSyncUserKey = userKey
  void persistSettingConfig()
  void saveLibrarySettingsFromConfig()
}

ipcMain.handle('cloudSync/config/get', () => {
  const storedUserKey = resolveDevCloudSyncUserKey(
    String(store.settingConfig?.cloudSyncUserKey || '').trim(),
    is.dev
  )
  persistDevUserKeyIfNeeded(storedUserKey)
  cloudSyncConfig.userKey = storedUserKey
  // 同步当前指纹模式给渲染层
  const mode = getFingerprintMode()
  return { userKey: storedUserKey, mode }
})

// 重置用户云端数据（不重置使用统计）
ipcMain.handle('cloudSync/resetUserData', async (_e, payload: { notes?: string }) => {
  try {
    const userKey = (cloudSyncConfig.userKey || '').trim()
    if (!userKey) {
      return { success: false, message: 'cloudSync.notConfigured' }
    }
    const baseUrl = await resolveBaseUrl()
    const body: { userKey: string; notes?: string } = { userKey }
    if (payload && typeof payload.notes === 'string' && payload.notes.trim()) {
      body.notes = payload.notes.trim()
    }
    const res = await limitedFetch(`${baseUrl}${CLOUD_SYNC.PREFIX}/reset`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const json = await res.json()
    if (json?.success === true) {
      return { success: true, data: json }
    }
    // 失败：按后端错误码映射提示
    const messageKey = mapBackendErrorToI18nKey(json)
    return { success: false, message: messageKey, error: json }
  } catch (e) {
    log.error('[cloudSync] /reset failed', e)
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  }
})

ipcMain.handle('cloudSync/config/save', async (_e, payload: { userKey: string }) => {
  const userKey = (payload?.userKey || '').trim()
  try {
    const currentKey = String(store.settingConfig?.cloudSyncUserKey || '').trim()
    if (isCuratedLibrarySyncEnabled() && currentKey && currentKey !== userKey) {
      return { success: false, message: 'cloudSync.curatedLibrary.errors.cannotChangeUserKey' }
    }
    const baseUrl = await resolveBaseUrl()
    const json = await validateUserKeyRequest(userKey, baseUrl)
    if (json?.success === true && json?.data?.isActive === true) {
      cloudSyncConfig.userKey = json?.data?.userKey || userKey
      store.settingConfig.cloudSyncUserKey = cloudSyncConfig.userKey
      await persistSettingConfig()
      await saveLibrarySettingsFromConfig()
      restartCloudSyncScheduler({ immediate: true })
      syncCuratedLibraryLiveSync()
      return { success: true }
    }
    const error = String(json?.error || '').toUpperCase()
    if (error === 'INVALID_USER_KEY' || error === 'USER_KEY_NOT_FOUND') {
      return { success: false, message: 'cloudSync.errors.keyInvalid' }
    }
    if (error === 'USER_KEY_INACTIVE' || json?.data?.isActive === false) {
      return { success: false, message: 'cloudSync.errors.keyDisabled' }
    }
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  } catch (_err) {
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  }
})

ipcMain.handle('cloudSync/testConnectivity', async (_e, payload: { userKey: string }) => {
  try {
    const baseUrl = await resolveBaseUrl()
    const json = await validateUserKeyRequest(payload?.userKey || '', baseUrl)
    if (json?.success === true && json?.data?.isActive === true) {
      const limitNum = Number(json?.limit)
      return {
        success: true,
        message: 'cloudSync.connectivityOk',
        limit: Number.isFinite(limitNum) ? limitNum : undefined
      }
    }
    const error = String(json?.error || '').toUpperCase()
    if (error === 'INVALID_USER_KEY' || error === 'USER_KEY_NOT_FOUND') {
      return { success: false, message: 'cloudSync.errors.keyInvalid' }
    }
    if (error === 'USER_KEY_INACTIVE' || json?.data?.isActive === false) {
      return { success: false, message: 'cloudSync.errors.keyDisabled' }
    }
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  } catch (_err) {
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  }
})

async function startCloudSync(trigger: CloudSyncTrigger = 'manual') {
  const silent = isScheduledTrigger(trigger)
  // 频控：限制 5 分钟内最多 10 次同步启动
  // 在接近上限时（第 9 次或第 10 次）给出友好提示并告知下一次安全操作时间
  {
    const now = Date.now()
    const windowTs = syncStartTimestamps.filter((t) => now - t < SYNC_WINDOW_MS)
    if (windowTs.length >= SYNC_MAX_IN_WINDOW) {
      const oldestTs = windowTs[0] ?? now
      const retryAfterMs = Math.max(0, SYNC_WINDOW_MS - (now - oldestTs))
      if (!silent && mainWindow.instance) {
        mainWindow.instance.webContents.send('cloudSync/error', {
          message: '操作过于频繁：5 分钟内最多允许发起 10 次同步',
          error: {
            code: 'RATE_LIMITED',
            scope: 'sync_start',
            windowMs: SYNC_WINDOW_MS,
            max: SYNC_MAX_IN_WINDOW,
            retryAfterMs
          }
        })
        mainWindow.instance.webContents.send('cloudSync/state', 'failed')
      }
      return 'rate_limited'
    }
    // 第 9 次（窗口内已有 8 次，将要发起第 9 次）或第 10 次（已有 9 次，将要发起第 10 次）给提示
    if (
      !silent &&
      (windowTs.length === SYNC_MAX_IN_WINDOW - 2 || windowTs.length === SYNC_MAX_IN_WINDOW - 1)
    ) {
      const oldestTs = windowTs[0] ?? now
      const retryAfterMs = Math.max(0, SYNC_WINDOW_MS - (now - oldestTs))
      const seconds = Math.ceil(retryAfterMs / 1000)
      const msg =
        windowTs.length === SYNC_MAX_IN_WINDOW - 2
          ? `温馨提示：5 分钟内已累计 8 次同步，本次为第 9 次。为避免触发限制，建议在 ${seconds} 秒后再次发起同步。`
          : `温馨提示：5 分钟内已累计 9 次同步，本次为第 10 次。再次发起同步前，请等待 ${seconds} 秒。`
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('cloudSync/notice', {
          message: msg,
          code: 'rate_limit_warning',
          currentInWindow: windowTs.length,
          windowMs: SYNC_WINDOW_MS,
          max: SYNC_MAX_IN_WINDOW,
          retryAfterMs
        })
      }
    }
  }
  if (!canStartSyncNow()) {
    const now = Date.now()
    // 重新清理一次，确保时间戳窗口准确
    syncStartTimestamps = syncStartTimestamps.filter((t) => now - t < SYNC_WINDOW_MS)
    const oldestTs = syncStartTimestamps[0] ?? now
    const retryAfterMs = Math.max(0, SYNC_WINDOW_MS - (now - oldestTs))
    if (!silent && mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/error', {
        message: '操作过于频繁：5 分钟内最多允许发起 10 次同步',
        error: {
          code: 'RATE_LIMITED',
          scope: 'sync_start',
          windowMs: SYNC_WINDOW_MS,
          max: SYNC_MAX_IN_WINDOW,
          retryAfterMs
        }
      })
      mainWindow.instance.webContents.send('cloudSync/state', 'failed')
    }
    return 'rate_limited'
  }
  markSyncStarted()
  const baseUrl = await resolveBaseUrl()
  if (!cloudSyncConfig.userKey) {
    cloudSyncConfig.userKey = resolveDevCloudSyncUserKey(
      String(store.settingConfig?.cloudSyncUserKey || '').trim(),
      is.dev
    )
  }
  if (!cloudSyncConfig.userKey) {
    return 'not_configured'
  }

  let cancelRequested = false
  const onCancel = () => {
    cancelRequested = true
  }
  ipcMain.once('cloudSync/cancel', onCancel)

  let lastProgressPercent = 0
  const sendProgress = (phase: string, percent: number, details?: unknown) => {
    if (mainWindow.instance) {
      const normalizedPercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
      const nextPercent = Math.max(lastProgressPercent, normalizedPercent)
      lastProgressPercent = nextPercent
      mainWindow.instance.webContents.send('cloudSync/progress', {
        phase,
        percent: nextPercent,
        details
      })
    }
  }
  const sendState = (state: 'syncing' | 'success' | 'failed' | 'cancelled') => {
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/state', state)
    }
  }
  const sendError = (message: string, error?: unknown) => {
    if (silent && !isActionableScheduledFailure(message, error)) return
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/error', { message, error })
    }
  }
  const sendNotice = (payload: Record<string, unknown>) => {
    if (silent) return
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/notice', payload)
    }
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  try {
    sendState('syncing')
    const startAt = Date.now()
    const pad = (n: number) => String(n).padStart(2, '0')
    const formatTs = (ms: number) => {
      const d = new Date(ms)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    let addedToServerTotal = 0
    let curatedArtistClientInitialCount = 0
    let curatedArtistClientCountAfter = 0
    let curatedArtistServerInitialCount = 0
    let curatedArtistServerCountAfter = 0
    let curatedArtistNeedSync = false
    const toNumber = (v: unknown, fallback = 0) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    // 服务器端为当前 userKey 设置的上限（来自 /check）
    let serverLimit: number | null = null
    // 0) validate-user-key：在进入流程前快速校验 userKey 是否有效且启用
    try {
      const valid = await validateUserKeyRequest(cloudSyncConfig.userKey, baseUrl)
      if (!(valid?.success === true && valid?.data?.isActive === true)) {
        const errorCode = String(valid?.error || 'INVALID_USER_KEY').toUpperCase()
        const msg =
          errorCode === 'USER_KEY_INACTIVE'
            ? 'cloudSync.errors.keyDisabled'
            : errorCode === 'USER_KEY_NOT_FOUND' || errorCode === 'INVALID_USER_KEY'
              ? 'cloudSync.errors.keyInvalid'
              : 'cloudSync.errors.cannotConnect'
        log.error('[cloudSync] /validate-user-key error', {
          request: {
            url: `${baseUrl}${CLOUD_SYNC.PREFIX}/validate-user-key`,
            userKeyLength: String(cloudSyncConfig.userKey || '').length
          },
          response: {
            success: valid.success,
            error: valid.error,
            status: valid.status
          }
        })
        sendError(msg, { error: errorCode })
        sendState('failed')
        return 'failed'
      }
    } catch (_e) {
      log.error('[cloudSync] /validate-user-key network error', {
        request: {
          url: `${baseUrl}${CLOUD_SYNC.PREFIX}/validate-user-key`,
          userKeyLength: String(cloudSyncConfig.userKey || '').length
        },
        error: _e
      })
      sendError('cloudSync.errors.cannotConnect', { error: 'NETWORK' })
      sendState('failed')
      return 'failed'
    }

    // 1) /check（集合哈希：小写、升序、无分隔符；空数组等价于 sha256('')）
    const mode = getFingerprintMode()
    const { hash, fingerprints: clientFingerprints } = await getCollectionHashForSync(mode)
    const checkRes = await limitedFetch(`${baseUrl}${CLOUD_SYNC.PREFIX}/check`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userKey: cloudSyncConfig.userKey,
        count: clientFingerprints.length,
        hash,
        mode
      })
    })
    const checkJson = await checkRes.json()
    if (!checkJson?.success) {
      log.error('[cloudSync] /check error', {
        request: {
          url: `${baseUrl}${CLOUD_SYNC.PREFIX}/check`,
          userKeyLength: String(cloudSyncConfig.userKey || '').length,
          count: clientFingerprints.length,
          hash,
          mode
        },
        status: checkRes.status,
        response: checkJson
      })
      sendError(mapBackendErrorToI18nKey(checkJson), checkJson)
      sendState('failed')
      return 'failed'
    }
    // 最新后端返回顶层字段
    const serverCount = toNumber(checkJson?.serverCount)
    const clientCount = toNumber(checkJson?.clientCount)
    const limitFromServer = toNumber(checkJson?.limit, 0)
    if (Number.isFinite(limitFromServer) && limitFromServer > 0) {
      serverLimit = limitFromServer
    }
    const fingerprintNeedSync = checkJson?.needSync === true
    if (String(checkJson?.reason || '') === 'sync_in_progress') {
      if (silent) {
        sendState('cancelled')
        return 'sync_in_progress'
      }
      sendError('cloudSync.errors.syncInProgress', checkJson)
      sendState('failed')
      return 'sync_in_progress'
    }
    sendProgress('checking', 5, { clientCount, serverCount })
    // 配额上限预检查：若客户端集合数量已大于上限，直接终止
    if (serverLimit && clientCount > serverLimit) {
      log.error('[cloudSync] limit exceeded on /check precheck', {
        limit: serverLimit,
        clientCount,
        serverCount
      })
      sendError('cloudSync.errors.limitExceededOnCheck', {
        code: 'FINGERPRINT_LIMIT_EXCEEDED',
        details: {
          phase: 'check',
          limit: serverLimit,
          clientCount,
          serverCount
        }
      })
      sendState('failed')
      return 'failed'
    }
    const batchSize = 1000
    let mergedList = [...clientFingerprints]
    let serverFinalCount = toNumber(serverCount)
    let clientFinalCount = toNumber(clientCount)
    let pulledToClientTotal = 0
    let verifiedHashMatched = !fingerprintNeedSync

    if (fingerprintNeedSync) {
      // 2) diff_up 分批
      const toAdd: string[] = []
      for (let i = 0; i < clientFingerprints.length; i += batchSize) {
        if (cancelRequested) {
          sendState('cancelled')
          return 'cancelled'
        }
        const batch = clientFingerprints.slice(i, i + batchSize)
        const diffRes = await limitedFetch(`${baseUrl}${CLOUD_SYNC.PREFIX}/bidirectional-diff`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            userKey: cloudSyncConfig.userKey,
            clientFingerprints: batch,
            batchIndex: Math.floor(i / batchSize),
            batchSize,
            mode
          })
        })
        const diffJson = await diffRes.json()
        // 最新后端返回顶层字段
        const missingServer: string[] = diffJson?.serverMissingFingerprints
        if (!diffJson?.success) {
          log.error('[cloudSync] /bidirectional-diff error', {
            request: {
              url: `${baseUrl}${CLOUD_SYNC.PREFIX}/bidirectional-diff`,
              userKeyLength: String(cloudSyncConfig.userKey || '').length,
              fingerprintCount: batch.length,
              batchIndex: Math.floor(i / batchSize),
              batchSize,
              mode
            },
            status: diffRes.status,
            response: diffJson
          })
          sendError(mapBackendErrorToI18nKey(diffJson), diffJson)
          sendState('failed')
          return 'failed'
        }
        if (Array.isArray(missingServer)) {
          for (const m of missingServer) toAdd.push(String(m).toLowerCase())
        }
        const progressBase = 5
        const diffPortion = 30
        const progress =
          progressBase +
          Math.min(
            ((i + batch.length) / Math.max(clientFingerprints.length, 1)) * diffPortion,
            diffPortion
          )
        sendProgress('diffing', Math.round(progress), { toAddCount: toAdd.length })
      }
      const uploadList = Array.from(new Set(toAdd))
      // 3) analyze-diff
      const clientForAnalyze = clientFingerprints
      const analyzeRes = await limitedFetch(`${baseUrl}${CLOUD_SYNC.PREFIX}/analyze-diff`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userKey: cloudSyncConfig.userKey,
          clientFingerprints: clientForAnalyze,
          mode
        })
      })
      const analyzeJson = await analyzeRes.json()
      // 最新后端返回顶层字段
      let diffSessionId: string = analyzeJson?.diffSessionId
      const stats = analyzeJson?.diffStats || {}
      const clientMissingCount = Number(stats.clientMissingCount ?? 0)
      const pageSizeFromAnalysis = Number(stats.pageSize ?? 1000)
      if (!analyzeJson?.success) {
        log.error('[cloudSync] /analyze-diff error', {
          request: {
            url: `${baseUrl}${CLOUD_SYNC.PREFIX}/analyze-diff`,
            userKeyLength: String(cloudSyncConfig.userKey || '').length,
            fingerprintCount: clientForAnalyze.length,
            mode
          },
          status: analyzeRes.status,
          response: analyzeJson
        })
        sendError(mapBackendErrorToI18nKey(analyzeJson), analyzeJson)
        sendState('failed')
        return 'failed'
      }
      sendProgress('analyzing', 40)

      // 4) pull-diff-page 分页
      const totalPages: number = Math.ceil(clientMissingCount / Math.max(pageSizeFromAnalysis, 1))
      const mergedSet = new Set<string>(clientFingerprints)
      for (let page = 0; page < totalPages; page++) {
        if (cancelRequested) {
          sendState('cancelled')
          return 'cancelled'
        }
        const pageRes = await limitedFetch(`${baseUrl}${CLOUD_SYNC.PREFIX}/pull-diff-page`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            userKey: cloudSyncConfig.userKey,
            diffSessionId,
            pageIndex: page,
            mode
          })
        })
        const pageJson = await pageRes.json()
        // 最新后端返回顶层字段
        const missingArr: string[] = pageJson?.missingFingerprints
        if (!pageJson?.success) {
          if (pageJson?.error === 'DIFF_SESSION_NOT_FOUND') {
            page = -1
            log.error('[cloudSync] /pull-diff-page error: diff session expired', {
              request: {
                url: `${baseUrl}${CLOUD_SYNC.PREFIX}/pull-diff-page`,
                userKeyLength: String(cloudSyncConfig.userKey || '').length,
                diffSessionId,
                pageIndex: page,
                mode
              },
              status: pageRes.status,
              response: pageJson
            })
            const retryAnalyze = await limitedFetch(`${baseUrl}${CLOUD_SYNC.PREFIX}/analyze-diff`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                userKey: cloudSyncConfig.userKey,
                clientFingerprints: clientForAnalyze
              })
            })
            const retryAnalyzeJson = await retryAnalyze.json()
            if (!retryAnalyzeJson?.success) {
              log.error('[cloudSync] /analyze-diff retry error', {
                request: {
                  url: `${baseUrl}${CLOUD_SYNC.PREFIX}/analyze-diff`,
                  userKeyLength: String(cloudSyncConfig.userKey || '').length,
                  fingerprintCount: clientForAnalyze.length
                },
                status: retryAnalyze.status,
                response: retryAnalyzeJson
              })
              sendError(mapBackendErrorToI18nKey(retryAnalyzeJson), retryAnalyzeJson)
              sendState('failed')
              return 'failed'
            }
            diffSessionId = retryAnalyzeJson?.diffSessionId
            continue
          }
          log.error('[cloudSync] /pull-diff-page error', {
            request: {
              url: `${baseUrl}${CLOUD_SYNC.PREFIX}/pull-diff-page`,
              userKeyLength: String(cloudSyncConfig.userKey || '').length,
              diffSessionId,
              pageIndex: page,
              mode
            },
            status: pageRes.status,
            response: pageJson
          })
          sendError(mapBackendErrorToI18nKey(pageJson), pageJson)
          sendState('failed')
          return 'failed'
        }
        const missing: string[] = Array.isArray(missingArr) ? missingArr : []
        for (const m of missing) {
          const fingerprint = String(m).toLowerCase()
          if (!mergedSet.has(fingerprint)) {
            mergedSet.add(fingerprint)
            pulledToClientTotal += 1
          }
        }
        const pullPortion = 30
        const progress = 45 + ((page + 1) / Math.max(totalPages, 1)) * pullPortion
        sendProgress('pulling', Math.round(progress), { pulledPages: page + 1, totalPages })
      }

      // 5) commit：先 /add 再本地原子替换
      // 在提交到服务端之前进行本地上限预估
      if (serverLimit && serverLimit > 0) {
        const uniqueNewCount = uploadList.length
        const allowedAddCount = Math.max(0, serverLimit - serverCount)
        if (serverCount + uniqueNewCount > serverLimit) {
          log.error('[cloudSync] pre-add limit exceeded', {
            limit: serverLimit,
            currentCount: serverCount,
            uniqueNewCount,
            allowedAddCount
          })
          sendError('cloudSync.errors.limitExceeded', {
            code: 'FINGERPRINT_LIMIT_EXCEEDED',
            details: {
              phase: 'batch_add',
              limit: serverLimit,
              currentCount: serverCount,
              uniqueNewCount,
              allowedAddCount
            }
          })
          sendState('failed')
          return 'failed'
        }
      }
      sendProgress('committing', 78)
      let committedCount = 0
      for (let i = 0; i < uploadList.length; i += batchSize) {
        const slice = uploadList.slice(i, i + batchSize)
        const addRes = await limitedFetch(`${baseUrl}${CLOUD_SYNC.PREFIX}/add`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ userKey: cloudSyncConfig.userKey, addFingerprints: slice, mode })
        })
        const addJson = await addRes.json()
        const addedCount = toNumber(addJson?.addedCount)
        if (!addJson?.success) {
          log.error('[cloudSync] /add error', {
            request: {
              url: `${baseUrl}${CLOUD_SYNC.PREFIX}/add`,
              userKeyLength: String(cloudSyncConfig.userKey || '').length,
              fingerprintCount: slice.length,
              mode
            },
            status: addRes.status,
            response: addJson
          })
          sendError(mapBackendErrorToI18nKey(addJson), addJson)
          sendState('failed')
          return 'failed'
        }
        addedToServerTotal += addedCount
        serverFinalCount = toNumber(addJson?.serverCountAfter, serverFinalCount)
        committedCount += slice.length
        const ratio = uploadList.length > 0 ? Math.min(committedCount / uploadList.length, 1) : 1
        const progress = 78 + Math.round(ratio * 14) // 78 -> 92
        sendProgress('committing', progress)
      }
      if (uploadList.length === 0) {
        sendProgress('committing', 85)
      }

      // 本地保存（多版本+指针，原子切换）
      mergedList = await unionFingerprintList(Array.from(mergedSet), mode)
      clientFinalCount = mergedList.length

      // 6) 提交后复查 /check
      sendProgress('finalizing', 93)
      const verifyHash = (await getCollectionHashForSync(mode)).hash
      try {
        const verifyRes = await limitedFetch(`${baseUrl}${CLOUD_SYNC.PREFIX}/check`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            userKey: cloudSyncConfig.userKey,
            count: mergedList.length,
            hash: verifyHash,
            mode
          })
        })
        const verifyJson = await verifyRes.json()
        if (!verifyJson?.success) {
          log.error('[cloudSync] /check verify error', {
            request: {
              url: `${baseUrl}${CLOUD_SYNC.PREFIX}/check`,
              userKeyLength: String(cloudSyncConfig.userKey || '').length,
              count: mergedList.length,
              hash: verifyHash,
              mode
            },
            status: verifyRes.status,
            response: verifyJson
          })
        }
        if (verifyJson?.success) {
          verifiedHashMatched = verifyJson?.needSync === false
          serverFinalCount = toNumber(verifyJson?.serverCount, serverFinalCount)
          clientFinalCount = toNumber(verifyJson?.clientCount, clientFinalCount)
        }
      } catch (_e) {
        // 错误需记录日志，但不影响主流程
        log.error('[cloudSync] /check verify network error', {
          request: {
            url: `${baseUrl}${CLOUD_SYNC.PREFIX}/check`,
            userKeyLength: String(cloudSyncConfig.userKey || '').length,
            count: mergedList.length,
            hash: verifyHash,
            mode
          },
          error: _e
        })
      }
    } else {
      sendProgress('finalizing', 85)
    }

    sendProgress('finalizing', 96)
    try {
      const curatedArtistResult = await syncCuratedArtistCloudSnapshot({
        config: {
          baseUrl: baseUrl,
          apiSecretKey: CLOUD_SYNC.API_SECRET_KEY,
          userKey: cloudSyncConfig.userKey
        },
        limitedFetch
      })
      curatedArtistClientInitialCount = toNumber(curatedArtistResult.localSnapshot.count)
      curatedArtistClientCountAfter = toNumber(curatedArtistResult.mergedSnapshot.count)
      curatedArtistServerInitialCount = toNumber(
        curatedArtistResult.response?.serverSnapshotBefore?.artistCount
      )
      curatedArtistServerCountAfter = toNumber(
        curatedArtistResult.response?.mergedSnapshot?.artistCount,
        curatedArtistClientCountAfter
      )
      curatedArtistNeedSync = curatedArtistResult.response?.needSync === true
    } catch (curatedError) {
      const responsePayload = getCuratedArtistSyncErrorPayload(curatedError)
      if (responsePayload) {
        if (isCuratedArtistSyncUnsupportedServer(responsePayload)) {
          sendNotice({
            message: 'cloudSync.curatedArtistSkippedUnsupported'
          })
          curatedArtistClientInitialCount = 0
          curatedArtistClientCountAfter = 0
          curatedArtistServerInitialCount = 0
          curatedArtistServerCountAfter = 0
          curatedArtistNeedSync = false
        } else {
          log.error('[cloudSync] /curated-artist-sync error', {
            request: {
              url: `${baseUrl}/frkbapi/v1/curated-artist-sync/sync`,
              userKeyLength: String(cloudSyncConfig.userKey || '').length
            },
            response: responsePayload
          })
          sendError(mapBackendErrorToI18nKey(responsePayload), responsePayload)
          sendState('failed')
          return 'failed'
        }
      } else {
        log.error('[cloudSync] /curated-artist-sync network error', {
          request: {
            url: `${baseUrl}/frkbapi/v1/curated-artist-sync/sync`,
            userKeyLength: String(cloudSyncConfig.userKey || '').length
          },
          error: curatedError
        })
        sendError('cloudSync.errors.cannotConnect', {
          error: 'NETWORK',
          scope: 'curated_artist_sync'
        })
        sendState('failed')
        return 'failed'
      }
    }

    sendProgress('finalizing', 98)
    await wait(120)
    sendProgress('finalizing', 100)
    const alreadyLatest = !fingerprintNeedSync && !curatedArtistNeedSync
    if (alreadyLatest) {
      sendNotice({
        message: 'cloudSync.errors.alreadyLatest'
      })
    }
    const endAt = Date.now()
    const pulledToClientCount = toNumber(pulledToClientTotal)
    const addedToServerCount = toNumber(addedToServerTotal)
    const summary = {
      startAt: formatTs(startAt),
      endAt: formatTs(endAt),
      durationMs: endAt - startAt,
      clientInitialCount: toNumber(clientFingerprints.length),
      serverInitialCount: toNumber(serverCount),
      addedToServerCount,
      pulledToClientCount,
      curatedArtistClientInitialCount,
      curatedArtistClientCountAfter,
      curatedArtistServerInitialCount,
      curatedArtistServerCountAfter,
      totalClientCountAfter: toNumber(clientFinalCount),
      totalServerCountAfter: toNumber(serverFinalCount),
      verifiedHashMatched
    }
    if (!alreadyLatest && !silent && mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/summary', summary)
    }
    sendState('success')
    return 'success'
  } catch (e: unknown) {
    const error = (isRecord(e) ? e : null) as ErrorLike | null
    const cause = (isRecord(error?.cause) ? error?.cause : null) as ErrorLike | null
    const msg = (() => {
      const rawMsg = String(error?.message || '')
      const code = String(cause?.code || error?.code || '')
      const isNetwork =
        rawMsg.includes('fetch failed') ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN'
      if (isNetwork) return 'cloudSync.errors.cannotConnect'
      return 'common.error'
    })()
    // 捕获到的最终错误需记录
    log.error('[cloudSync] sync failed', { error: e, message: msg })
    sendError(msg, e)
    sendState('failed')
    return 'failed'
  } finally {
    ipcMain.removeListener('cloudSync/cancel', onCancel)
  }
}

export async function runCloudSync(trigger: CloudSyncTrigger = 'manual'): Promise<string> {
  return enqueueCloudWork(async () => {
    if (cloudSyncRunning) return 'already_running'
    cloudSyncRunning = true
    try {
      return await startCloudSync(trigger)
    } finally {
      cloudSyncRunning = false
    }
  })
}

bindCloudSyncScheduler(runCloudSync)

ipcMain.handle('cloudSync/start', async (_e, payload?: { trigger?: CloudSyncTrigger }) => {
  const trigger = payload?.trigger === 'scheduled' ? 'scheduled' : 'manual'
  return runCloudSync(trigger)
})
