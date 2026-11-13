import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  logError: vi.fn(),
  userDataPath: ''
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataPath, isPackaged: true }
}))

vi.mock('../log', () => ({
  log: { error: mocks.logError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))

vi.mock('./optionalComponentEvents', () => ({
  publishOptionalComponentState: mocks.publish,
  getOptionalComponentStates: vi.fn(() => [])
}))

import {
  createRekordboxRuntimeInstaller,
  rekordboxRuntimeEvents,
  type RekordboxRuntimeInstallerDeps
} from './rekordboxRuntimeDownload'
import type { RekordboxRuntimeArchiveEntry } from './rekordboxRuntimeArchive'
import { resolveRekordboxDesktopInstalledRuntimeRootPath } from './rekordboxDesktopLibrary/helper'
import {
  normalizeRekordboxRuntimeRelativePath,
  parseRekordboxRuntimeManifest,
  resolveRekordboxRuntimePlatformKey
} from '../../shared/rekordboxRuntimeDownload'

const PLATFORM = resolveRekordboxRuntimePlatformKey(process.platform, process.arch)
const PYTHON_REL = PLATFORM === 'win32-x64' ? 'python/python.exe' : 'python/bin/python3'
const PYTHON_PACKAGE_REL =
  PLATFORM === 'win32-x64'
    ? 'python/Lib/site-packages/pyrekordbox/__init__.py'
    : 'python/lib/python3.11/site-packages/pyrekordbox/__init__.py'

const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')

const ARCHIVE_BYTES = Buffer.from('rekordbox-runtime-archive-bytes')
const FILE_CONTENTS: Record<string, string> = {
  [PYTHON_REL]: 'python-binary',
  [PYTHON_PACKAGE_REL]: 'pyrekordbox-package'
}

const buildFiles = () =>
  Object.entries(FILE_CONTENTS).map(([filePath, content]) => ({
    path: filePath,
    sha256: sha256(content),
    size: Buffer.byteLength(content)
  }))

const buildManifest = (
  overrides: Partial<{
    version: string
    platform: string
    archiveBytes: Buffer
    files: Array<{ path: string; sha256: string; size: number }>
    archiveSha256: string
    archiveSize: number
    archiveUrl: string
    releaseTag: string
  }> = {}
) => {
  const platform = overrides.platform ?? PLATFORM ?? 'win32-x64'
  const version = overrides.version ?? '1.0.0'
  const archiveBytes = overrides.archiveBytes ?? ARCHIVE_BYTES
  const archiveName = `frkb-rekordbox-runtime-${platform}-${version}.tar.gz`
  const releaseTag = overrides.releaseTag ?? 'rekordbox-runtime-assets'
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-13T00:00:00.000Z',
    releaseTag,
    assets: [
      {
        platform,
        version,
        archiveName,
        archiveUrl:
          overrides.archiveUrl ??
          `https://github.com/coderDJing/Track-Studio/releases/download/${releaseTag}/${archiveName}`,
        archiveSha256: overrides.archiveSha256 ?? sha256(archiveBytes),
        archiveSize: overrides.archiveSize ?? archiveBytes.length,
        pythonRelativePath: PYTHON_REL,
        files: overrides.files ?? buildFiles()
      }
    ]
  }
}

type Harness = {
  userDataRoot: string
  calls: { fetch: number; download: number; list: number; extract: number; validate: number }
  deps: RekordboxRuntimeInstallerDeps
  installer: ReturnType<typeof createRekordboxRuntimeInstaller>
  rebuildInstaller: () => ReturnType<typeof createRekordboxRuntimeInstaller>
  setManifest: (manifest: unknown) => void
  setValidate: (result: { ok: boolean; error?: string }) => void
  setArchiveContent: (content: Buffer) => void
}

const createHarness = (options: { validateOk?: boolean } = {}): Harness => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-rbx-runtime-'))
  const calls = { fetch: 0, download: 0, list: 0, extract: 0, validate: 0 }
  let manifest: unknown = buildManifest()
  let validateResult = { ok: options.validateOk !== false, error: '' }
  let archiveContent: Buffer = ARCHIVE_BYTES

  const deps: RekordboxRuntimeInstallerDeps = {
    resolveUserDataPath: () => userDataRoot,
    fetchManifestText: async () => {
      calls.fetch += 1
      return JSON.stringify(manifest)
    },
    downloadArchive: async (_asset, archivePath, onProgress) => {
      calls.download += 1
      await fsp.mkdir(path.dirname(archivePath), { recursive: true })
      await fsp.writeFile(archivePath, archiveContent)
      onProgress({
        downloadedBytes: archiveContent.length,
        totalBytes: archiveContent.length,
        percent: 100
      })
    },
    listArchiveEntries: async () => {
      calls.list += 1
      const entries: RekordboxRuntimeArchiveEntry[] = [
        { path: `${PLATFORM}/`, type: 'directory', size: 0 },
        { path: `${PLATFORM}/python/`, type: 'directory', size: 0 }
      ]
      for (const [filePath, content] of Object.entries(FILE_CONTENTS)) {
        entries.push({
          path: `${PLATFORM}/${filePath}`,
          type: 'file',
          size: Buffer.byteLength(content)
        })
      }
      entries.push({
        path: `${PLATFORM}/python/bin/python3.11`,
        type: 'symlink',
        linkPath: 'python3.11',
        size: 0
      })
      return entries
    },
    extractArchive: async (_archivePath, outputDir) => {
      calls.extract += 1
      for (const [filePath, content] of Object.entries(FILE_CONTENTS)) {
        const target = path.join(outputDir, PLATFORM as string, ...filePath.split('/'))
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, content)
      }
    },
    computeFileSha256: async (filePath) => {
      const content = await fsp.readFile(filePath)
      return sha256(content)
    },
    validatePython: async () => {
      calls.validate += 1
      return validateResult
    },
    now: () => 1_700_000_000_000
  }

  const installer = createRekordboxRuntimeInstaller(deps)
  return {
    userDataRoot,
    calls,
    deps,
    installer,
    rebuildInstaller: () => createRekordboxRuntimeInstaller(deps),
    setManifest: (next) => {
      manifest = next
    },
    setValidate: (next) => {
      validateResult = { ok: next.ok, error: next.error ?? '' }
    },
    setArchiveContent: (next) => {
      archiveContent = next
    }
  }
}

const installedPlatformRoot = (harness: Harness) =>
  path.join(harness.userDataRoot, 'rekordbox-desktop-runtime', PLATFORM as string)

const expectedPythonPath = (harness: Harness) =>
  path.join(installedPlatformRoot(harness), ...PYTHON_REL.split('/'))

describe.skipIf(!PLATFORM)('rekordbox runtime installer', () => {
  const tempRoots: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  const harness = (options?: { validateOk?: boolean }) => {
    const created = createHarness(options)
    tempRoots.push(created.userDataRoot)
    return created
  }

  it('probe is purely local: a missing runtime never touches the network', () => {
    const h = harness()
    expect(h.installer.probeInstalled()).toBeNull()
    expect(h.installer.resolveInstalledPythonPath()).toBeNull()
    expect(h.calls.fetch).toBe(0)
    expect(h.calls.download).toBe(0)
    expect(h.installer.resolveInstalledRootPath()).toBe(
      path.join(h.userDataRoot, 'rekordbox-desktop-runtime')
    )
  })

  it('downloads, verifies and atomically enables the runtime', async () => {
    const h = harness()
    const pythonPath = await h.installer.ensure()

    expect(pythonPath).toBe(expectedPythonPath(h))
    expect(fs.existsSync(pythonPath)).toBe(true)
    expect(fs.existsSync(path.join(installedPlatformRoot(h), '.frkb-runtime-install.json'))).toBe(
      true
    )
    expect(h.calls).toMatchObject({ fetch: 1, download: 1, list: 1, extract: 1, validate: 2 })
    expect(h.installer.probeInstalled()?.version).toBe('1.0.0')

    const statuses = mocks.publish.mock.calls.map((call) => call[0].status)
    expect(statuses).toEqual(['downloading', 'downloading', 'installing', 'ready'])
    expect(mocks.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'rekordbox-desktop-runtime', percent: 100, error: '' })
    )
    // staging 与备份目录必须清理干净。
    const rootEntries = fs.readdirSync(path.join(h.userDataRoot, 'rekordbox-desktop-runtime'))
    expect(rootEntries.filter((name) => name.startsWith('.staging-'))).toEqual([])
    expect(rootEntries.filter((name) => name.startsWith('.backup-'))).toEqual([])
  })

  it('emits installed (cache invalidation) before publishing ready', async () => {
    const h = harness()
    const publishCountAtInstalled: number[] = []
    const listener = () => {
      publishCountAtInstalled.push(mocks.publish.mock.calls.length)
    }
    rekordboxRuntimeEvents.once('installed', listener)
    try {
      await h.installer.ensure()
    } finally {
      rekordboxRuntimeEvents.off('installed', listener)
    }

    // installed 事件发生时 downloading/installing 已发完，ready 尚未发布。
    expect(publishCountAtInstalled).toEqual([3])
    expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }))
  })

  it('reuses an installed runtime offline without fetching a manifest', async () => {
    const h = harness()
    await h.installer.ensure()

    const offline = createRekordboxRuntimeInstaller({
      ...h.deps,
      fetchManifestText: async () => {
        throw new Error('offline')
      }
    })
    const pythonPath = await offline.ensure()
    expect(pythonPath).toBe(expectedPythonPath(h))
  })

  it('rejects an archive whose sha256 does not match the manifest', async () => {
    const h = harness()
    // 保持长度一致，确保触发的是 checksum 而不是 size 校验。
    const tampered = Buffer.from(ARCHIVE_BYTES)
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff
    h.setArchiveContent(tampered)
    await expect(h.installer.ensure()).rejects.toThrow(/sha256/)
    expect(h.calls.extract).toBe(0)
    expect(fs.existsSync(installedPlatformRoot(h))).toBe(false)
    expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }))
  })

  it('rejects an archive whose size does not match the manifest', async () => {
    const h = harness()
    h.setManifest(buildManifest({ archiveSize: ARCHIVE_BYTES.length + 1024 }))
    await expect(h.installer.ensure()).rejects.toThrow(/尺寸/)
    expect(h.calls.extract).toBe(0)
  })

  it('accepts the platform root directory itself and its descendants', async () => {
    const h = harness()
    const entries: RekordboxRuntimeArchiveEntry[] = [
      { path: PLATFORM as string, type: 'directory', size: 0 },
      { path: `${PLATFORM}/python`, type: 'directory', size: 0 },
      { path: `${PLATFORM}/${PYTHON_REL}`, type: 'file', size: 13 }
    ]
    h.deps.listArchiveEntries = async () => entries
    await expect(h.rebuildInstaller().ensure()).resolves.toBe(expectedPythonPath(h))
  })

  it('rejects archive entries that escape the platform root', async () => {
    const h = harness()
    const entries: RekordboxRuntimeArchiveEntry[] = [
      { path: `${PLATFORM}/python`, type: 'directory', size: 0 },
      { path: '../evil.py', type: 'file', size: 0 },
      { path: '/abs.py', type: 'file', size: 0 }
    ]
    h.deps.listArchiveEntries = async () => entries

    await expect(h.rebuildInstaller().ensure()).rejects.toThrow(/不允许的路径/)
    expect(h.calls.extract).toBe(0)
  })

  it('rejects a symlink entry that escapes and leaves the old install untouched', async () => {
    const h = harness()
    await h.installer.ensure()
    const pythonPath = expectedPythonPath(h)
    const corrupted = fs.readFileSync(pythonPath, 'utf8').replace(/^./, 'X')
    fs.writeFileSync(pythonPath, corrupted)
    const extractCallsBefore = h.calls.extract

    h.setManifest(buildManifest({ version: '2.0.0' }))
    h.deps.listArchiveEntries = async () => [
      { path: `${PLATFORM}/python`, type: 'directory', size: 0 },
      { path: `${PLATFORM}/${PYTHON_REL}`, type: 'file', size: 13 },
      {
        path: `${PLATFORM}/python/link`,
        type: 'symlink',
        linkPath: '../../../../etc/passwd',
        size: 0
      }
    ]

    await expect(h.rebuildInstaller().ensure()).rejects.toThrow(/link-escapes|不允许的路径/)
    // 本次恶意包必须零次解压（首次安装产生的解压不计入）。
    expect(h.calls.extract).toBe(extractCallsBefore)
    expect(fs.readFileSync(pythonPath, 'utf8')).toBe(corrupted)
  })

  it('rejects a manifest entry that points outside the project release', async () => {
    const h = harness()
    h.setManifest(
      buildManifest({
        archiveUrl: 'https://evil.example.com/rekordbox-runtime.tar.gz'
      })
    )
    await expect(h.installer.ensure()).rejects.toThrow(/manifest/)
    expect(h.calls.download).toBe(0)
  })

  it('rejects a manifest without an asset for the current platform', async () => {
    const h = harness()
    const otherPlatform = PLATFORM === 'win32-x64' ? 'darwin-arm64' : 'win32-x64'
    h.setManifest(buildManifest({ platform: otherPlatform }))
    await expect(h.installer.ensure()).rejects.toThrow(/缺少平台资源/)
    expect(h.calls.download).toBe(0)
  })

  it('keeps the previous runtime intact when the new install fails validation', async () => {
    const h = harness()
    await h.installer.ensure()
    const previousPythonPath = expectedPythonPath(h)
    const previousMeta = fs.readFileSync(
      path.join(installedPlatformRoot(h), '.frkb-runtime-install.json'),
      'utf8'
    )

    // 破坏当前安装，使 ensure 走重新安装；新版本校验失败。
    fs.writeFileSync(previousPythonPath, 'corrupted')
    h.setManifest(buildManifest({ version: '2.0.0' }))
    h.setValidate({ ok: false, error: 'import pyrekordbox failed' })

    await expect(h.installer.ensure()).rejects.toThrow(/Python 校验失败/)

    expect(fs.existsSync(previousPythonPath)).toBe(true)
    expect(fs.readFileSync(previousPythonPath, 'utf8')).toBe('corrupted')
    expect(
      fs.readFileSync(path.join(installedPlatformRoot(h), '.frkb-runtime-install.json'), 'utf8')
    ).toBe(previousMeta)
    const rootEntries = fs.readdirSync(path.join(h.userDataRoot, 'rekordbox-desktop-runtime'))
    expect(rootEntries.filter((name) => name.startsWith('.staging-'))).toEqual([])
  })

  it('single-flights concurrent installs for the same platform', async () => {
    const h = harness()
    const releaseGate: { current: () => void } = { current: () => {} }
    const gate = new Promise<void>((resolve) => {
      releaseGate.current = resolve
    })
    const originalDownload = h.deps.downloadArchive
    h.deps.downloadArchive = async (asset, archivePath, onProgress) => {
      await gate
      await originalDownload(asset, archivePath, onProgress)
    }
    const installer = createRekordboxRuntimeInstaller(h.deps)

    const first = installer.ensure()
    const second = installer.ensure()
    releaseGate.current()
    const [firstPath, secondPath] = await Promise.all([first, second])

    expect(firstPath).toBe(secondPath)
    expect(h.calls.download).toBe(1)
  })

  it('allows retry after a failed install', async () => {
    const h = harness()
    const originalFetch = h.deps.fetchManifestText
    let allow = false
    h.deps.fetchManifestText = async (url) => {
      if (!allow) throw new Error('network down')
      return await originalFetch(url)
    }
    const installer = h.rebuildInstaller()

    await expect(installer.ensure()).rejects.toThrow(/network down/)
    allow = true
    await expect(installer.ensure()).resolves.toBe(expectedPythonPath(h))
    expect(h.calls.download).toBe(1)
  })

  it('detects a corrupted installed runtime and reinstalls it', async () => {
    const h = harness()
    await h.installer.ensure()
    const pythonPath = expectedPythonPath(h)
    fs.writeFileSync(pythonPath, 'x')

    expect(h.installer.probeInstalled()).toBeNull()
    const fixedPath = await h.installer.ensure()
    expect(fixedPath).toBe(pythonPath)
    expect(h.calls.download).toBe(2)
  })

  it('detects same-size corruption by sha256 on explicit ensure and repairs it', async () => {
    const h = harness()
    await h.installer.ensure()
    const pythonPath = expectedPythonPath(h)
    const original = fs.readFileSync(pythonPath, 'utf8')
    const corrupted = original.replace(/^./, 'X')
    expect(Buffer.byteLength(corrupted)).toBe(Buffer.byteLength(original))
    fs.writeFileSync(pythonPath, corrupted)

    // 被动探测依旧只看元数据/尺寸，不会误判。
    expect(h.installer.probeInstalled()).not.toBeNull()
    const fixedPath = await h.installer.ensure()
    expect(fixedPath).toBe(pythonPath)
    expect(fs.readFileSync(pythonPath, 'utf8')).toBe(original)
    expect(h.calls.download).toBe(2)
  })

  it('rechecks Python dependencies during explicit repair even when sentinels are unchanged', async () => {
    const h = harness()
    const pythonPath = await h.installer.ensure()
    h.setValidate({ ok: false, error: 'dependency removed after installation' })
    await expect(h.installer.ensure()).rejects.toThrow(/dependency removed/)
    expect(h.calls.download).toBe(2)
    expect(fs.existsSync(pythonPath)).toBe(true)
  })
})

describe('rekordbox helper runtime resolution', () => {
  it('reads the installed runtime root from userData (no bundled/system python)', () => {
    const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-rbx-helper-'))
    mocks.userDataPath = userDataRoot
    try {
      expect(resolveRekordboxDesktopInstalledRuntimeRootPath()).toBe(
        path.join(userDataRoot, 'rekordbox-desktop-runtime')
      )
    } finally {
      mocks.userDataPath = ''
      fs.rmSync(userDataRoot, { recursive: true, force: true })
    }
  })
})

describe('rekordbox runtime manifest validation', () => {
  it('maps only the three shipped binary platforms', () => {
    expect(resolveRekordboxRuntimePlatformKey('win32', 'x64')).toBe('win32-x64')
    expect(resolveRekordboxRuntimePlatformKey('win32', 'arm64')).toBeNull()
    expect(resolveRekordboxRuntimePlatformKey('win32', 'ia32')).toBeNull()
    expect(resolveRekordboxRuntimePlatformKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(resolveRekordboxRuntimePlatformKey('darwin', 'x64')).toBe('darwin-x64')
    expect(resolveRekordboxRuntimePlatformKey('darwin', 'ia32')).toBeNull()
    expect(resolveRekordboxRuntimePlatformKey('linux', 'x64')).toBeNull()
  })

  it('accepts the packaged manifest shape', () => {
    const result = parseRekordboxRuntimeManifest(buildManifest())
    expect(result.ok).toBe(true)
  })

  it('rejects unsafe relative paths', () => {
    expect(normalizeRekordboxRuntimeRelativePath('../python.exe')).toBeNull()
    expect(normalizeRekordboxRuntimeRelativePath('/usr/bin/python')).toBeNull()
    expect(normalizeRekordboxRuntimeRelativePath('C:/python.exe')).toBeNull()
    expect(normalizeRekordboxRuntimeRelativePath('python\\python.exe')).toBeNull()
    expect(normalizeRekordboxRuntimeRelativePath('python/./python.exe')).toBeNull()
    expect(normalizeRekordboxRuntimeRelativePath('python/python.exe')).toBe('python/python.exe')
  })

  it('rejects a manifest whose sentinel list omits the python entry', () => {
    const manifest = buildManifest()
    manifest.assets[0].files = manifest.assets[0].files.filter((file) => file.path !== PYTHON_REL)
    expect(parseRekordboxRuntimeManifest(manifest).ok).toBe(false)
  })

  it('rejects duplicate platform assets and wrong schema versions', () => {
    const manifest = buildManifest()
    const duplicated = { ...manifest, assets: [...manifest.assets, ...manifest.assets] }
    expect(parseRekordboxRuntimeManifest(duplicated).ok).toBe(false)
    expect(parseRekordboxRuntimeManifest({ ...manifest, schemaVersion: 2 }).ok).toBe(false)
  })
})
