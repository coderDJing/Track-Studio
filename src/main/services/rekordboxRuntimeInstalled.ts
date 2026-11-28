import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  REKORDBOX_RUNTIME_INSTALL_DIR_NAME,
  isRekordboxRuntimePlatformKey,
  normalizeRekordboxRuntimeRelativePath,
  resolveRekordboxRuntimePlatformKey,
  type RekordboxRuntimePlatformKey
} from '../../shared/rekordboxRuntimeDownload'

/** 只读本地安装结果。下载、解压、Python 校验在 rekordboxRuntimeDownload。 */
export const REKORDBOX_RUNTIME_INSTALL_META_FILE_NAME = '.frkb-runtime-install.json'
export const REKORDBOX_RUNTIME_INSTALL_META_SCHEMA_VERSION = 1

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export type RekordboxRuntimeInstalledMeta = {
  schemaVersion: number
  platform: RekordboxRuntimePlatformKey
  version: string
  pythonRelativePath: string
  archiveSha256: string
  installedAt: string
  sentinels: Array<{ path: string; sha256: string; size: number }>
}

export type RekordboxRuntimeInstalledInfo = {
  platform: RekordboxRuntimePlatformKey
  version: string
  archiveSha256: string
  platformRootPath: string
  pythonPath: string
}

export const resolveRekordboxRuntimeInstallRoot = (userDataPath: string) =>
  path.join(userDataPath, REKORDBOX_RUNTIME_INSTALL_DIR_NAME)

export const readInstalledRekordboxRuntimeMeta = (
  metaPath: string
): RekordboxRuntimeInstalledMeta | null => {
  try {
    const raw = fs.readFileSync(metaPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<RekordboxRuntimeInstalledMeta>
    if (!parsed || parsed.schemaVersion !== REKORDBOX_RUNTIME_INSTALL_META_SCHEMA_VERSION) {
      return null
    }
    if (!isRekordboxRuntimePlatformKey(parsed.platform)) return null
    if (typeof parsed.version !== 'string' || !parsed.version) return null
    const pythonRelativePath = normalizeRekordboxRuntimeRelativePath(parsed.pythonRelativePath)
    if (!pythonRelativePath) return null
    if (typeof parsed.archiveSha256 !== 'string' || !SHA256_PATTERN.test(parsed.archiveSha256)) {
      return null
    }
    if (!Array.isArray(parsed.sentinels)) return null
    const sentinels: RekordboxRuntimeInstalledMeta['sentinels'] = []
    for (const item of parsed.sentinels) {
      if (!item || typeof item !== 'object') return null
      const entryPath = normalizeRekordboxRuntimeRelativePath(item.path)
      const sha256 = String(item.sha256 || '').toLowerCase()
      if (!entryPath || !SHA256_PATTERN.test(sha256)) return null
      if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0) return null
      sentinels.push({ path: entryPath, sha256, size: item.size })
    }
    return {
      schemaVersion: REKORDBOX_RUNTIME_INSTALL_META_SCHEMA_VERSION,
      platform: parsed.platform,
      version: parsed.version,
      pythonRelativePath,
      archiveSha256: parsed.archiveSha256,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
      sentinels
    }
  } catch {
    return null
  }
}

const isSentinelCurrent = (
  platformRootPath: string,
  sentinel: RekordboxRuntimeInstalledMeta['sentinels'][number]
) => {
  try {
    const stat = fs.statSync(path.join(platformRootPath, ...sentinel.path.split('/')))
    return stat.isFile() && stat.size === sentinel.size
  } catch {
    return false
  }
}

export const probeInstalledRekordboxRuntime = (
  userDataPath: string
): RekordboxRuntimeInstalledInfo | null => {
  const platformKey = resolveRekordboxRuntimePlatformKey(process.platform, process.arch)
  if (!platformKey) return null
  const platformRootPath = path.join(resolveRekordboxRuntimeInstallRoot(userDataPath), platformKey)
  const meta = readInstalledRekordboxRuntimeMeta(
    path.join(platformRootPath, REKORDBOX_RUNTIME_INSTALL_META_FILE_NAME)
  )
  if (!meta || meta.platform !== platformKey) return null
  const pythonPath = path.join(platformRootPath, ...meta.pythonRelativePath.split('/'))
  const sentinelsCurrent =
    meta.sentinels.length > 0 &&
    meta.sentinels.every((sentinel) => isSentinelCurrent(platformRootPath, sentinel))
  if (!sentinelsCurrent) return null
  try {
    if (!fs.statSync(pythonPath).isFile()) return null
  } catch {
    return null
  }
  return {
    platform: platformKey,
    version: meta.version,
    archiveSha256: meta.archiveSha256,
    platformRootPath,
    pythonPath
  }
}

export const resolveInstalledRekordboxDesktopRuntimeRootPath = (): string =>
  resolveRekordboxRuntimeInstallRoot(app.getPath('userData'))

export const probeInstalledRekordboxDesktopRuntime = (): RekordboxRuntimeInstalledInfo | null =>
  probeInstalledRekordboxRuntime(app.getPath('userData'))
