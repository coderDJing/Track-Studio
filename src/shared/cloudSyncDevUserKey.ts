export const DEV_DEFAULT_CLOUD_SYNC_USER_KEY = 'e100d54b-2e48-458b-a7c5-5c231c183f24'

export const resolveDevCloudSyncUserKey = (stored: string, isDev: boolean): string => {
  const userKey = String(stored || '').trim()
  return userKey || (isDev ? DEV_DEFAULT_CLOUD_SYNC_USER_KEY : '')
}
