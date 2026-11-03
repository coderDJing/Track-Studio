import { is } from '@electron-toolkit/utils'
import store from '../store'
import { fetchWithSystemProxy } from '../fetchWithSystemProxy'
import { resolveBaseUrl } from '../serverDiscovery'
import { resolveDevCloudSyncUserKey } from '../../shared/cloudSyncDevUserKey'
import type { SetSyncSnapshot } from '../../shared/setLibrarySync'
import { parseSetSnapshot } from './validation'

export const setSyncUserKey = (): string =>
  resolveDevCloudSyncUserKey(String(store.settingConfig.cloudSyncUserKey || '').trim(), is.dev)

export async function setSyncRequest(
  endpoint: 'pull' | 'push',
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<SetSyncSnapshot> {
  const response = await fetchWithSystemProxy(
    `${await resolveBaseUrl()}/frkbapi/v1/set-library-sync/${endpoint}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CLOUD_SYNC_API_SECRET_KEY || ''}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ...body, userKey: setSyncUserKey() }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)])
    }
  )
  const raw: unknown = await response.json()
  if (!raw || typeof raw !== 'object' || !('success' in raw) || raw.success !== true) {
    const code = raw && typeof raw === 'object' && 'error' in raw ? String(raw.error) : ''
    throw Object.assign(new Error(code || `SET_SYNC_HTTP_${response.status}`), {
      status: response.status
    })
  }
  return parseSetSnapshot('data' in raw ? raw.data : null)
}
