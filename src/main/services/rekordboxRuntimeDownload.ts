import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { log } from '../log'
import { publishOptionalComponentState } from './optionalComponentEvents'
import { buildPortablePythonLaunch } from './rekordboxRuntimePythonLaunch'
import {
  DEFAULT_REKORDBOX_RUNTIME_MANIFEST_URL,
  REKORDBOX_RUNTIME_DOWNLOAD_DIR_NAME,
  REKORDBOX_RUNTIME_INSTALL_DIR_NAME,
  isRekordboxRuntimePlatformKey,
  normalizeRekordboxRuntimeRelativePath,
  parseRekordboxRuntimeManifest,
  resolveRekordboxRuntimePlatformKey,
  selectRekordboxRuntimeAsset,
  type RekordboxRuntimeAsset,
  type RekordboxRuntimePlatformKey
} from '../../shared/rekordboxRuntimeDownload'
import type { RekordboxDesktopLibraryErrorCode } from './rekordboxDesktopLibrary/types'
import {
  assertNoEscapingSymlinks,
  extractTarGzArchive,
  inspectTarGzEntries,
  validateArchiveEntriesForPlatform,
  type RekordboxRuntimeArchiveEntry
} from './rekordboxRuntimeArchive'

export const REKORDBOX_DESKTOP_RUNTIME_COMPONENT_ID = 'rekordbox-desktop-runtime'

/** 下载/安装完成后通知 helper 丢弃旧解释器（含损坏进程）与 probe 缓存。 */
export const rekordboxRuntimeEvents = new EventEmitter()

const INSTALL_META_FILE_NAME = '.frkb-runtime-install.json'
const INSTALL_META_SCHEMA_VERSION = 1
const PYTHON_IMPORT_PROBE_TIMEOUT_MS = 90_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export type RekordboxRuntimePythonProbe = {
  ok: boolean
  error?: string
  pyrekordboxVersion?: string
}

export type RekordboxRuntimeDownloadProgress = {
  downloadedBytes: number
  totalBytes: number
  percent: number
}

export type RekordboxRuntimeInstalledInfo = {
  platform: RekordboxRuntimePlatformKey
  version: string
  archiveSha256: string
  platformRootPath: string
  pythonPath: string
}

type InstalledMeta = {
  schemaVersion: number
  platform: RekordboxRuntimePlatformKey
  version: string
  pythonRelativePath: string
  archiveSha256: string
  installedAt: string
  sentinels: Array<{ path: string; sha256: string; size: number }>
}

export type RekordboxRuntimeInstallerDeps = {
  resolveUserDataPath: () => string
  fetchManifestText: (manifestUrl: string) => Promise<string>
  downloadArchive: (
    asset: RekordboxRuntimeAsset,
    archivePath: string,
    onProgress: (progress: RekordboxRuntimeDownloadProgress) => void
  ) => Promise<void>
  listArchiveEntries: (archivePath: string) => Promise<RekordboxRuntimeArchiveEntry[]>
  extractArchive: (archivePath: string, outputDir: string) => Promise<void>
  computeFileSha256: (filePath: string) => Promise<string>
  validatePython: (pythonPath: string) => Promise<RekordboxRuntimePythonProbe>
  now: () => number
}

export type RekordboxDesktopRuntimeInstaller = {
  resolveInstalledRootPath: () => string
  resolveInstalledPlatformRootPath: () => string
  resolveInstalledPythonPath: () => string | null
  probeInstalled: () => RekordboxRuntimeInstalledInfo | null
  ensure: () => Promise<string>
}

const createRuntimeError = (code: RekordboxDesktopLibraryErrorCode, message: string) => {
  const error = new Error(message) as Error & { code: RekordboxDesktopLibraryErrorCode }
  error.name = 'RekordboxDesktopRuntimeError'
  error.code = code
  return error
}

const runtimeMissingError = (message: string) =>
  createRuntimeError('PYTHON_RUNTIME_MISSING', message)

const unsupportedPlatformError = () =>
  createRuntimeError('UNSUPPORTED_PLATFORM', '当前平台暂不支持 Rekordbox 库。')

const currentPlatformKey = (): RekordboxRuntimePlatformKey | null =>
  resolveRekordboxRuntimePlatformKey(process.platform, process.arch)

const pathExists = async (targetPath: string) => {
  try {
    await fsp.access(targetPath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

const computeFileSha256 = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return await new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

const listTarEntries = async (archivePath: string): Promise<RekordboxRuntimeArchiveEntry[]> =>
  await inspectTarGzEntries(archivePath)

const PYTHON_IMPORT_PROBE_SCRIPT = [
  'import json',
  'payload = {"ok": False, "error": "", "pyrekordboxVersion": ""}',
  'try:',
  '  import pyrekordbox',
  '  import sqlalchemy',
  '  import sqlcipher3',
  '  from pyrekordbox import MasterDatabase',
  '  from pyrekordbox.masterdb import models',
  '  payload["ok"] = hasattr(sqlcipher3, "connect")',
  '  payload["pyrekordboxVersion"] = str(getattr(pyrekordbox, "__version__", ""))',
  'except Exception as exc:',
  '  payload["error"] = str(exc)',
  'print(json.dumps(payload))'
].join('\n')

const defaultValidatePython = async (pythonPath: string): Promise<RekordboxRuntimePythonProbe> => {
  // 自带 runtime 的 prefix 就是 python 可执行文件所在目录；Windows 下同时使用扩展长度路径，
  // 否则深目录（staging/最终安装）会触发 DLL LoadLibrary 的 MAX_PATH 失败。
  const launch = buildPortablePythonLaunch(pythonPath, path.dirname(pythonPath))
  return await new Promise<RekordboxRuntimePythonProbe>((resolve) => {
    const child = childProcess.spawn(launch.command, ['-c', PYTHON_IMPORT_PROBE_SCRIPT], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONNOUSERSITE: '1',
        // 固定到本包 prefix；PYTHONPATH 置空避免用户 site/环境串入。
        PYTHONHOME: launch.pythonHome,
        PYTHONPATH: ''
      }
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: 'python import probe timeout' })
    }, PYTHON_IMPORT_PROBE_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const lastLine =
        stdout
          .split(/\r?\n/g)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1) || ''
      if (code !== 0 || !lastLine) {
        resolve({
          ok: false,
          error: stderr.trim() || `python import probe exit ${String(code ?? '')}`
        })
        return
      }
      try {
        const parsed = JSON.parse(lastLine) as {
          ok?: unknown
          error?: unknown
          pyrekordboxVersion?: unknown
        }
        resolve({
          ok: parsed.ok === true,
          error: typeof parsed.error === 'string' ? parsed.error : undefined,
          pyrekordboxVersion:
            typeof parsed.pyrekordboxVersion === 'string' && parsed.pyrekordboxVersion.trim()
              ? parsed.pyrekordboxVersion.trim()
              : undefined
        })
      } catch (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error || 'invalid probe output')
        })
      }
    })
  })
}

/**
 * 默认依赖全部延迟加载：helper/测试只需注入自己的 deps，不会拉起 demucs 下载栈。
 */
const createDefaultDeps = (): RekordboxRuntimeInstallerDeps => ({
  resolveUserDataPath: () => app.getPath('userData'),
  fetchManifestText: async (manifestUrl) => {
    const { fetchDemucsAsset } = await import('./mixtapeStemRuntimeDownload')
    const response = await fetchDemucsAsset(manifestUrl, {
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`manifest http ${response.status}`)
    return await response.text()
  },
  downloadArchive: async (asset, archivePath, onProgress) => {
    const [{ downloadVerifiedArchive }, { fetchDemucsAsset, computeDemucsAssetSha256 }] =
      await Promise.all([
        import('./mixtapeStemRuntimeDownloadInstall'),
        import('./mixtapeStemRuntimeDownload')
      ])
    await downloadVerifiedArchive(
      { fetchRuntimeAsset: fetchDemucsAsset, computeFileSha256: computeDemucsAssetSha256 },
      asset,
      archivePath,
      onProgress
    )
  },
  listArchiveEntries: listTarEntries,
  extractArchive: extractTarGzArchive,
  computeFileSha256,
  validatePython: defaultValidatePython,
  now: Date.now
})

const resolveManifestUrl = () => {
  const override = String(process.env.FRKB_REKORDBOX_RUNTIME_MANIFEST_URL || '').trim()
  return override || DEFAULT_REKORDBOX_RUNTIME_MANIFEST_URL
}

const publishState = (patch: {
  status: 'idle' | 'downloading' | 'installing' | 'ready' | 'failed'
  percent: number
  downloadedBytes: number
  totalBytes: number
  error: string
}) => {
  try {
    publishOptionalComponentState({
      id: REKORDBOX_DESKTOP_RUNTIME_COMPONENT_ID,
      ...patch
    })
  } catch (error) {
    log.error('[rekordbox-runtime] publish state failed', { error })
  }
}

const readInstalledMeta = (metaPath: string): InstalledMeta | null => {
  try {
    const raw = fs.readFileSync(metaPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<InstalledMeta>
    if (!parsed || parsed.schemaVersion !== INSTALL_META_SCHEMA_VERSION) return null
    if (!isRekordboxRuntimePlatformKey(parsed.platform)) return null
    if (typeof parsed.version !== 'string' || !parsed.version) return null
    const pythonRelativePath = normalizeRekordboxRuntimeRelativePath(parsed.pythonRelativePath)
    if (!pythonRelativePath) return null
    if (typeof parsed.archiveSha256 !== 'string' || !SHA256_PATTERN.test(parsed.archiveSha256)) {
      return null
    }
    if (!Array.isArray(parsed.sentinels)) return null
    const sentinels: InstalledMeta['sentinels'] = []
    for (const item of parsed.sentinels) {
      if (!item || typeof item !== 'object') return null
      const entryPath = normalizeRekordboxRuntimeRelativePath(item.path)
      const sha256 = String(item.sha256 || '').toLowerCase()
      if (!entryPath || !SHA256_PATTERN.test(sha256)) return null
      if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0) return null
      sentinels.push({ path: entryPath, sha256, size: item.size })
    }
    return {
      schemaVersion: INSTALL_META_SCHEMA_VERSION,
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
  sentinel: InstalledMeta['sentinels'][number]
) => {
  try {
    const stat = fs.statSync(path.join(platformRootPath, ...sentinel.path.split('/')))
    return stat.isFile() && stat.size === sentinel.size
  } catch {
    return false
  }
}

export const createRekordboxRuntimeInstaller = (
  overrides: Partial<RekordboxRuntimeInstallerDeps> = {}
): RekordboxDesktopRuntimeInstaller => {
  const deps: RekordboxRuntimeInstallerDeps = { ...createDefaultDeps(), ...overrides }
  const installPromiseByPlatform = new Map<RekordboxRuntimePlatformKey, Promise<string>>()
  /**
   * 已完整校验过的安装签名（版本 + 归档 sha + 哨兵 size/mtime/ctime）。
   * 只缓存“已通过 SHA + Python 校验”的状态；任何文件被同尺寸篡改都会改变 mtime/ctime，
   * 从而让缓存失效并重新完整校验。
   */
  const verifiedSignatureByPlatform = new Map<RekordboxRuntimePlatformKey, string>()

  const resolveInstalledRootPath = () =>
    path.join(deps.resolveUserDataPath(), REKORDBOX_RUNTIME_INSTALL_DIR_NAME)

  const resolveInstalledPlatformRootPath = () => {
    const platformKey = currentPlatformKey()
    return platformKey ? path.join(resolveInstalledRootPath(), platformKey) : ''
  }

  const probeInstalled = (): RekordboxRuntimeInstalledInfo | null => {
    const platformKey = currentPlatformKey()
    if (!platformKey) return null
    const platformRootPath = path.join(resolveInstalledRootPath(), platformKey)
    const meta = readInstalledMeta(path.join(platformRootPath, INSTALL_META_FILE_NAME))
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

  const resolveInstalledPythonPath = () => probeInstalled()?.pythonPath ?? null

  const validateArchiveEntries = (
    entries: readonly RekordboxRuntimeArchiveEntry[],
    platformKey: RekordboxRuntimePlatformKey
  ) => {
    const result = validateArchiveEntriesForPlatform(
      entries,
      platformKey,
      normalizeRekordboxRuntimeRelativePath
    )
    if (!result.ok) {
      throw runtimeMissingError(`运行时归档包含不允许的路径: ${result.reason}`)
    }
    return result
  }

  const verifyStagedFiles = async (
    stagingPlatformRootPath: string,
    asset: RekordboxRuntimeAsset
  ) => {
    for (const file of asset.files) {
      const filePath = path.join(stagingPlatformRootPath, ...file.path.split('/'))
      const stat = await fsp.stat(filePath).catch(() => null)
      if (!stat || !stat.isFile() || stat.size !== file.size) {
        throw runtimeMissingError(`运行时哨兵文件缺失或尺寸不符: ${file.path}`)
      }
      const sha256 = await deps.computeFileSha256(filePath)
      if (sha256.toLowerCase() !== file.sha256) {
        throw runtimeMissingError(`运行时哨兵文件校验失败: ${file.path}`)
      }
    }
  }

  const verifySentinelsAt = async (
    platformRootPath: string,
    meta: InstalledMeta
  ): Promise<boolean> => {
    for (const sentinel of meta.sentinels) {
      const filePath = path.join(platformRootPath, ...sentinel.path.split('/'))
      const stat = await fsp.stat(filePath).catch(() => null)
      if (!stat || !stat.isFile() || stat.size !== sentinel.size) return false
      const sha256 = (await deps.computeFileSha256(filePath).catch(() => '')).toLowerCase()
      if (sha256 !== sentinel.sha256) return false
    }
    return true
  }

  /** 显式 ensure 复用前必须做的完整校验：哨兵 sha + Python 可用。 */
  const verifyInstalledIntegrity = async (
    info: RekordboxRuntimeInstalledInfo
  ): Promise<boolean> => {
    const meta = readInstalledMeta(path.join(info.platformRootPath, INSTALL_META_FILE_NAME))
    if (!meta || meta.archiveSha256 !== info.archiveSha256) return false
    if (!(await verifySentinelsAt(info.platformRootPath, meta))) return false
    const probe = await deps.validatePython(info.pythonPath).catch(() => ({ ok: false }))
    return probe.ok
  }

  /**
   * 安装签名 = 版本/归档 sha/每个哨兵的 size+mtime+ctime。
   * 同尺寸覆盖会刷新 mtime/ctime，签名随之变化，缓存不会掩盖损坏。
   */
  const buildInstalledSignature = (info: RekordboxRuntimeInstalledInfo): string | null => {
    const meta = readInstalledMeta(path.join(info.platformRootPath, INSTALL_META_FILE_NAME))
    if (!meta || meta.archiveSha256 !== info.archiveSha256) return null
    const parts = [`${meta.version}:${meta.archiveSha256}`]
    for (const sentinel of meta.sentinels) {
      const targetPath = path.join(info.platformRootPath, ...sentinel.path.split('/'))
      const stat = fs.statSync(targetPath, { throwIfNoEntry: false })
      if (!stat || !stat.isFile() || stat.size !== sentinel.size) return null
      parts.push(`${sentinel.path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
    }
    return parts.join('|')
  }

  const install = async (platformKey: RekordboxRuntimePlatformKey): Promise<string> => {
    const rootPath = resolveInstalledRootPath()
    const platformRootPath = path.join(rootPath, platformKey)
    const downloadDir = path.join(deps.resolveUserDataPath(), REKORDBOX_RUNTIME_DOWNLOAD_DIR_NAME)
    let activeStage = ''
    let archivePath = ''

    publishState({
      status: 'downloading',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      error: ''
    })

    try {
      const manifestText = await deps.fetchManifestText(resolveManifestUrl())
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(manifestText)
      } catch {
        throw runtimeMissingError('运行时清单不是合法 JSON')
      }
      const manifestResult = parseRekordboxRuntimeManifest(parsedJson)
      if (!manifestResult.ok) {
        throw runtimeMissingError(`运行时清单无效: ${manifestResult.reason}`)
      }
      const asset = selectRekordboxRuntimeAsset(manifestResult.manifest, platformKey)
      if (!asset) {
        throw runtimeMissingError(`运行时清单缺少平台资源: ${platformKey}`)
      }

      await fsp.mkdir(downloadDir, { recursive: true })
      archivePath = path.join(downloadDir, asset.archiveName)
      await fsp.rm(archivePath, { force: true }).catch(() => {})
      await deps.downloadArchive(asset, archivePath, (progress) => {
        publishState({
          status: 'downloading',
          percent: progress.percent,
          downloadedBytes: progress.downloadedBytes,
          totalBytes: progress.totalBytes || asset.archiveSize,
          error: ''
        })
      })

      const archiveStat = await fsp.stat(archivePath)
      if (archiveStat.size !== asset.archiveSize) {
        throw runtimeMissingError(
          `运行时归档尺寸不符: expected=${asset.archiveSize} actual=${archiveStat.size}`
        )
      }
      const archiveSha256 = (await deps.computeFileSha256(archivePath)).toLowerCase()
      if (archiveSha256 !== asset.archiveSha256) {
        await fsp.rm(archivePath, { force: true }).catch(() => {})
        throw runtimeMissingError('运行时归档 sha256 不匹配')
      }

      publishState({
        status: 'installing',
        percent: 100,
        downloadedBytes: asset.archiveSize,
        totalBytes: asset.archiveSize,
        error: ''
      })

      const entries = await deps.listArchiveEntries(archivePath)
      validateArchiveEntries(entries, platformKey)

      await fsp.mkdir(rootPath, { recursive: true })
      activeStage = path.join(rootPath, `.staging-${platformKey}-${deps.now()}`)
      await fsp.rm(activeStage, { recursive: true, force: true }).catch(() => {})
      await deps.extractArchive(archivePath, activeStage)

      const stagingPlatformRootPath = path.join(activeStage, platformKey)
      await assertNoEscapingSymlinks(stagingPlatformRootPath)
      await verifyStagedFiles(stagingPlatformRootPath, asset)
      const stagingPythonPath = path.join(
        stagingPlatformRootPath,
        ...asset.pythonRelativePath.split('/')
      )
      if (!(await pathExists(stagingPythonPath))) {
        throw runtimeMissingError(`运行时缺少 Python 入口: ${asset.pythonRelativePath}`)
      }
      const pythonProbe = await deps.validatePython(stagingPythonPath)
      if (!pythonProbe.ok) {
        throw runtimeMissingError(`运行时 Python 校验失败: ${pythonProbe.error || 'unknown error'}`)
      }

      const meta: InstalledMeta = {
        schemaVersion: INSTALL_META_SCHEMA_VERSION,
        platform: platformKey,
        version: asset.version,
        pythonRelativePath: asset.pythonRelativePath,
        archiveSha256: asset.archiveSha256,
        installedAt: new Date(deps.now()).toISOString(),
        sentinels: asset.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          size: file.size
        }))
      }
      await fsp.writeFile(
        path.join(stagingPlatformRootPath, INSTALL_META_FILE_NAME),
        `${JSON.stringify(meta, null, 2)}\n`,
        'utf8'
      )

      const backupPath = path.join(rootPath, `.backup-${platformKey}-${deps.now()}`)
      const hadExisting = await pathExists(platformRootPath)
      if (hadExisting) {
        await fsp.rename(platformRootPath, backupPath)
      }
      try {
        await fsp.rename(stagingPlatformRootPath, platformRootPath)
      } catch (error) {
        if (hadExisting) {
          await fsp.rename(backupPath, platformRootPath).catch((restoreError) => {
            log.error('[rekordbox-runtime] 还原旧运行时失败', { error: restoreError })
          })
        }
        throw error
      }
      // 最终位置复核：哨兵 sha + Python import 都通过后才删除旧包。
      const installed = probeInstalled()
      const finalVerified =
        installed !== null &&
        installed.version === asset.version &&
        (await verifyInstalledIntegrity(installed))
      if (!installed || !finalVerified) {
        await fsp.rm(platformRootPath, { recursive: true, force: true }).catch(() => {})
        if (hadExisting) {
          await fsp.rename(backupPath, platformRootPath).catch((restoreError) => {
            log.error('[rekordbox-runtime] 复核失败后还原旧运行时失败', { error: restoreError })
          })
        }
        throw runtimeMissingError('运行时安装后复核失败')
      }
      if (hadExisting) {
        await fsp.rm(backupPath, { recursive: true, force: true }).catch(() => {})
      }
      await fsp.rm(activeStage, { recursive: true, force: true }).catch(() => {})
      activeStage = ''
      await fsp.rm(archivePath, { force: true }).catch(() => {})
      archivePath = ''
      verifiedSignatureByPlatform.set(
        platformKey,
        buildInstalledSignature(installed) ?? `${installed.version}:${installed.archiveSha256}`
      )

      // 先同步通知 helper/detect 清掉旧解释器与旧 probe 缓存，再向 Renderer 宣布 ready，
      // 避免 UI 收到 ready 后立刻 probe 仍撞上旧 helper。
      rekordboxRuntimeEvents.emit('installed', { ...installed })
      publishState({
        status: 'ready',
        percent: 100,
        downloadedBytes: asset.archiveSize,
        totalBytes: asset.archiveSize,
        error: ''
      })
      return installed.pythonPath
    } catch (error) {
      if (activeStage) {
        await fsp.rm(activeStage, { recursive: true, force: true }).catch(() => {})
      }
      if (archivePath) {
        await fsp.rm(archivePath, { force: true }).catch(() => {})
      }
      const message = error instanceof Error ? error.message : String(error || '')
      publishState({
        status: 'failed',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        error: message || 'runtime install failed'
      })
      if (error instanceof Error && (error as { code?: unknown }).code) throw error
      throw runtimeMissingError(message || 'runtime install failed')
    }
  }

  const ensure = async (): Promise<string> => {
    const platformKey = currentPlatformKey()
    if (!platformKey) throw unsupportedPlatformError()
    const installed = probeInstalled()
    if (installed) {
      const signature = buildInstalledSignature(installed)
      // 只有签名未变且此前已通过完整校验（哨兵 sha + Python 可用）才能直接复用。
      if (signature && verifiedSignatureByPlatform.get(platformKey) === signature) {
        return installed.pythonPath
      }
      if (await verifyInstalledIntegrity(installed)) {
        if (signature) verifiedSignatureByPlatform.set(platformKey, signature)
        return installed.pythonPath
      }
    }

    const existing = installPromiseByPlatform.get(platformKey)
    if (existing) return await existing

    const task = install(platformKey).finally(() => {
      if (installPromiseByPlatform.get(platformKey) === task) {
        installPromiseByPlatform.delete(platformKey)
      }
    })
    installPromiseByPlatform.set(platformKey, task)
    return await task
  }

  return {
    resolveInstalledRootPath,
    resolveInstalledPlatformRootPath,
    resolveInstalledPythonPath,
    probeInstalled,
    ensure
  }
}

let defaultInstaller: RekordboxDesktopRuntimeInstaller | null = null
const getDefaultInstaller = (): RekordboxDesktopRuntimeInstaller => {
  if (!defaultInstaller) defaultInstaller = createRekordboxRuntimeInstaller()
  return defaultInstaller
}

export const resolveInstalledRekordboxDesktopRuntimeRootPath = (): string =>
  getDefaultInstaller().resolveInstalledRootPath()

export const resolveInstalledRekordboxDesktopRuntimePlatformRootPath = (): string =>
  getDefaultInstaller().resolveInstalledPlatformRootPath()

/** 纯本地检查：不访问网络、不触发下载。 */
export const probeInstalledRekordboxDesktopRuntime = (): RekordboxRuntimeInstalledInfo | null =>
  getDefaultInstaller().probeInstalled()

export const resolveInstalledRekordboxDesktopRuntimePythonPath = (): string | null =>
  getDefaultInstaller().resolveInstalledPythonPath()

/** 返回验证后的 python 可执行路径；缺失时下载并安装。 */
export const ensureRekordboxDesktopRuntime = async (): Promise<string> =>
  await getDefaultInstaller().ensure()
