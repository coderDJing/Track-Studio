import { is } from '@electron-toolkit/utils'
import { log } from './log'
import store from './store'
import { persistSettingConfig } from './settingsPersistence'
import { fetchWithSystemProxy } from './fetchWithSystemProxy'

const DISCOVERY_URL = process.env.CLOUD_SYNC_DISCOVERY_URL || ''
const BOOTSTRAP_PROD_BASE_URL = 'http://47.116.100.222:3001'
const RETIRED_PROD_BASE_URL = 'http://106.54.200.160:3119'
const DISCOVERY_MAX_ATTEMPTS = 2
const DISCOVERY_RETRY_DELAY_MS = 400

const normalizeBaseUrl = (value: unknown): string => {
  const candidate = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  if (!candidate) return ''
  try {
    const parsed = new URL(candidate)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password
    ) {
      return ''
    }
    return candidate
  } catch {
    return ''
  }
}

const isRetiredProdBaseUrl = (baseUrl: string): boolean => baseUrl === RETIRED_PROD_BASE_URL

const configuredProdBaseUrl = normalizeBaseUrl(process.env.CLOUD_SYNC_BASE_URL_PROD || '')

const DEFAULT_BASE_URL = is.dev
  ? process.env.CLOUD_SYNC_BASE_URL_DEV || 'http://localhost:3001'
  : configuredProdBaseUrl && !isRetiredProdBaseUrl(configuredProdBaseUrl)
    ? configuredProdBaseUrl
    : BOOTSTRAP_PROD_BASE_URL

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const getFallbackBaseUrl = (): string => {
  const lastKnownBaseUrl = normalizeBaseUrl(store.settingConfig?.cloudSyncLastKnownBaseUrl)
  if (lastKnownBaseUrl && !isRetiredProdBaseUrl(lastKnownBaseUrl)) return lastKnownBaseUrl
  return DEFAULT_BASE_URL
}

const rememberDiscoveredBaseUrl = (baseUrl: string): void => {
  if (store.settingConfig?.cloudSyncLastKnownBaseUrl === baseUrl) return
  store.settingConfig.cloudSyncLastKnownBaseUrl = baseUrl
  void persistSettingConfig().catch((error: unknown) => {
    log.error('[cloudSync] 保存最近可用服务器地址失败', { error })
  })
}

const describeDiscoveryFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'unknown error')

/**
 * 从线上发现文件解析服务器地址。
 * 每次操作开始时重新获取，避免服务器迁移后继续请求旧地址。
 * 内容格式：{"baseUrl":"http://xxx"}
 */
export async function resolveBaseUrl(): Promise<string> {
  // 开发态不走线上 server.json，避免自测打到生产
  if (is.dev) {
    return DEFAULT_BASE_URL
  }
  // 没有配置发现地址，直接用默认
  if (!DISCOVERY_URL) {
    return getFallbackBaseUrl()
  }

  let lastFailure = 'unknown error'
  for (let attempt = 1; attempt <= DISCOVERY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchWithSystemProxy(DISCOVERY_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      })
      if (!res.ok) {
        lastFailure = `HTTP ${res.status}`
      } else {
        const json: unknown = await res.json()
        const discovered = normalizeBaseUrl(
          json && typeof json === 'object' && 'baseUrl' in json ? json.baseUrl : undefined
        )
        if (discovered && !isRetiredProdBaseUrl(discovered)) {
          rememberDiscoveredBaseUrl(discovered)
          return discovered
        }
        lastFailure = '响应缺少有效的服务器地址'
      }
    } catch (error) {
      lastFailure = describeDiscoveryFailure(error)
    }

    if (attempt < DISCOVERY_MAX_ATTEMPTS) {
      await wait(DISCOVERY_RETRY_DELAY_MS)
    }
  }

  const fallbackBaseUrl = getFallbackBaseUrl()
  log.error('[cloudSync] 服务器地址发现失败，使用已知地址', {
    attempts: DISCOVERY_MAX_ATTEMPTS,
    reason: lastFailure,
    fallbackBaseUrl
  })
  return fallbackBaseUrl
}
