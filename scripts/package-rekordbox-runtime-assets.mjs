import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SUPPORTED_PLATFORM_KEYS = ['win32-x64', 'darwin-arm64', 'darwin-x64']
const DEFAULT_RELEASE_TAG = 'rekordbox-runtime-assets'
const DEFAULT_RUNTIME_ROOT = 'vendor/rekordbox-desktop-runtime'
const MANIFEST_NAME = 'rekordbox-runtime-manifest.json'
const MAX_RELEASE_ASSET_SIZE = 2_000_000_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export const resolvePlatformKey = (value) => {
  const normalized = String(value || '').trim()
  return SUPPORTED_PLATFORM_KEYS.includes(normalized) ? normalized : ''
}

export const resolveDefaultPlatformKey = () => {
  if (process.platform === 'win32') return process.arch === 'x64' ? 'win32-x64' : ''
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') return 'darwin-arm64'
    if (process.arch === 'x64') return 'darwin-x64'
  }
  return ''
}

export const parseArgs = (argv) => {
  const args = Array.isArray(argv) ? argv.map((item) => String(item || '')) : []
  const read = (flag, fallback) => {
    const prefix = `${flag}=`
    const direct = args.find((arg) => arg.startsWith(prefix))
    if (direct) return direct.slice(prefix.length).trim() || fallback
    const index = args.findIndex((arg) => arg === flag)
    if (index < 0) return fallback
    const next = String(args[index + 1] || '').trim()
    return next || fallback
  }
  const platformKey = read('--platform-key', resolveDefaultPlatformKey())
  return {
    runtimeRoot: path.resolve(read('--runtime-root', DEFAULT_RUNTIME_ROOT)),
    platformKey,
    outputRoot: path.resolve(read('--output-root', `dist/rekordbox-runtime-assets-${platformKey}`)),
    version: read(
      '--version',
      new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, '')
        .replace('T', '')
    ),
    releaseTag: read('--release-tag', DEFAULT_RELEASE_TAG)
  }
}

export const buildArchiveName = (params) => {
  const platformKey = String(params?.platformKey || '').trim()
  const version = String(params?.version || '').trim()
  if (!resolvePlatformKey(platformKey)) throw new Error(`Unsupported platform: ${platformKey}`)
  if (!version) throw new Error('Missing asset version')
  const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, '-')
  return `frkb-rekordbox-runtime-${platformKey}-${safeVersion}.tar.gz`
}

export const resolvePythonRelativePathCandidates = (platformKey) =>
  platformKey === 'win32-x64'
    ? ['python/python.exe', 'python/Scripts/python.exe']
    : ['python/bin/python3', 'python/bin/python']

export const isSafeRelativePath = (value) => {
  const text = String(value || '').trim()
  if (!text || text.length > 300) return false
  if (text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return false
  return text.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

export const buildRuntimeAsset = (params) => {
  const platformKey = resolvePlatformKey(params?.platformKey)
  if (!platformKey) throw new Error(`Unsupported platform: ${params?.platformKey}`)
  const archiveName = String(params?.archiveName || '').trim()
  const archiveSha256 = String(params?.archiveSha256 || '')
    .trim()
    .toLowerCase()
  const archiveSize = Number(params?.archiveSize)
  const pythonRelativePath = String(params?.pythonRelativePath || '').trim()
  const releaseTag = String(params?.releaseTag || '').trim()
  const version = String(params?.version || '').trim()
  if (!archiveName.endsWith('.tar.gz')) throw new Error('archiveName must end with .tar.gz')
  if (!SHA256_PATTERN.test(archiveSha256)) throw new Error('archiveSha256 must be 64 hex chars')
  if (!Number.isInteger(archiveSize) || archiveSize <= 0) throw new Error('invalid archiveSize')
  if (!isSafeRelativePath(pythonRelativePath)) throw new Error('unsafe pythonRelativePath')
  if (!releaseTag) throw new Error('Missing release tag')
  if (!version) throw new Error('Missing asset version')
  const files = Array.isArray(params?.files)
    ? params.files.map((file) => ({
        path: String(file?.path || '').trim(),
        sha256: String(file?.sha256 || '')
          .trim()
          .toLowerCase(),
        size: Number(file?.size)
      }))
    : []
  if (files.length === 0) throw new Error('Missing sentinel files')
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) throw new Error(`unsafe sentinel path: ${file.path}`)
    if (!SHA256_PATTERN.test(file.sha256)) throw new Error(`invalid sentinel sha: ${file.path}`)
    if (!Number.isInteger(file.size) || file.size <= 0) {
      throw new Error(`invalid sentinel size: ${file.path}`)
    }
  }
  if (!files.some((file) => file.path === pythonRelativePath)) {
    throw new Error('pythonRelativePath must be present in sentinel files')
  }
  return {
    platform: platformKey,
    version,
    archiveName,
    archiveUrl: `https://github.com/coderDJing/Track-Studio/releases/download/${releaseTag}/${archiveName}`,
    archiveSha256,
    archiveSize,
    pythonRelativePath,
    files
  }
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  })
  if (result.status === 0) return result
  throw new Error(
    `${command} ${args.join(' ')} -> exit ${String(result.status ?? -1)}: ${String(
      result.stderr || result.error || ''
    ).trim()}`
  )
}

const computeFileSha256 = (filePath) => {
  const hash = crypto.createHash('sha256')
  const data = fs.readFileSync(filePath)
  hash.update(data)
  return hash.digest('hex')
}

const resolvePythonAbsolutePath = (platformDir, platformKey) => {
  for (const relativePath of resolvePythonRelativePathCandidates(platformKey)) {
    const absolutePath = path.join(platformDir, ...relativePath.split('/'))
    if (fs.existsSync(absolutePath)) return { relativePath, absolutePath }
  }
  throw new Error(`Python entry missing in runtime: ${platformDir}`)
}

const readPinnedPyrekordboxVersion = () => {
  const requirementsPath = path.resolve('scripts/rekordbox-desktop-runtime-requirements.txt')
  const match = fs.readFileSync(requirementsPath, 'utf8').match(/^pyrekordbox==([^\s]+)\s*$/m)
  if (!match) throw new Error('Missing pinned pyrekordbox runtime version')
  return match[1]
}

const buildIsolatedPythonEnv = () => ({
  ...process.env,
  PYTHONNOUSERSITE: '1',
  PYTHONPATH: '',
  PYTHONHOME: ''
})

const runRuntimeValidator = (runtimeRoot, platformKey) => {
  run(
    process.execPath,
    [
      'scripts/validate-rekordbox-desktop-runtime.mjs',
      '--runtime-root',
      runtimeRoot,
      '--platform-key',
      platformKey
    ],
    { timeout: 180_000, env: buildIsolatedPythonEnv() }
  )
}

/**
 * 依赖必须全部可导入且版本与 requirements 固定值一致；任何异常都让打包失败，
 * 绝不能生成缺少 pyrekordbox/SQLite 组件的资源。
 */
const probeRuntimeModules = ({ pythonPath, pinnedPyrekordboxVersion }) => {
  const script = [
    'import json',
    'import os',
    'import sys',
    'import pyrekordbox',
    'import sqlalchemy',
    'import sqlcipher3',
    'from pyrekordbox import MasterDatabase',
    'from pyrekordbox.masterdb import models',
    'assert hasattr(sqlcipher3, "connect"), "sqlcipher3.connect missing"',
    'files = [',
    '  os.path.abspath(sys.executable),',
    '  os.path.abspath(pyrekordbox.__file__),',
    '  os.path.abspath(sqlcipher3.__file__),',
    '  os.path.abspath(sqlalchemy.__file__),',
    ']',
    'print(json.dumps({',
    '  "pyrekordbox": getattr(pyrekordbox, "__version__", ""),',
    '  "files": files',
    '}))'
  ].join('\n')
  const result = run(pythonPath, ['-c', script], {
    timeout: 90_000,
    env: buildIsolatedPythonEnv()
  })
  const lastLine =
    String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) || ''
  let parsed
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    throw new Error(`runtime module probe returned invalid JSON: ${lastLine.slice(0, 300)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('runtime module probe payload is not an object')
  }
  const version = String(parsed?.pyrekordbox || '').trim()
  if (version !== pinnedPyrekordboxVersion) {
    throw new Error(
      `pyrekordbox version mismatch: installed=${version || '<empty>'} pinned=${pinnedPyrekordboxVersion}`
    )
  }
  const files = Array.isArray(parsed?.files) ? parsed.files.map((item) => String(item || '')) : []
  if (files.length < 4 || files.some((item) => !item)) {
    throw new Error('runtime module probe did not report all module files')
  }
  return { files, pyrekordboxVersion: version }
}

const toPlatformRelativePath = (absolutePath, platformDir) => {
  const relativePath = path.relative(platformDir, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`sentinel outside runtime: ${absolutePath}`)
  }
  return relativePath.split(path.sep).join('/')
}

const collectSentinelFiles = ({ absolutePaths, platformDir }) => {
  const files = []
  const seen = new Set()
  for (const absolutePath of absolutePaths) {
    const resolvedPath = path.resolve(absolutePath)
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`sentinel file missing: ${resolvedPath}`)
    }
    const relativePath = toPlatformRelativePath(resolvedPath, platformDir)
    if (seen.has(relativePath)) continue
    seen.add(relativePath)
    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) continue
    files.push({
      path: relativePath,
      sha256: computeFileSha256(resolvedPath),
      size: stat.size
    })
  }
  return files
}

const createArchive = ({ runtimeRoot, platformKey, archivePath }) => {
  if (fs.existsSync(archivePath)) {
    throw new Error(`Refusing to overwrite existing archive: ${archivePath}`)
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  run('tar', ['-czf', archivePath, '-C', runtimeRoot, platformKey])
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  if (!args.platformKey) {
    throw new Error('Unsupported or missing platform (--platform-key)')
  }
  const runtimeRoot = args.runtimeRoot
  const platformDir = path.join(runtimeRoot, args.platformKey)
  if (!fs.existsSync(platformDir)) {
    throw new Error(`Runtime directory missing: ${platformDir}`)
  }
  const { relativePath: pythonRelativePath, absolutePath: pythonAbsolutePath } =
    resolvePythonAbsolutePath(platformDir, args.platformKey)

  // 先用现有 validator 检查 python 可移植性与 pyrekordbox 版本，再收紧依赖探测。
  runRuntimeValidator(runtimeRoot, args.platformKey)
  const pinnedPyrekordboxVersion = readPinnedPyrekordboxVersion()
  const runtimeModules = probeRuntimeModules({
    pythonPath: pythonAbsolutePath,
    pinnedPyrekordboxVersion
  })

  const files = collectSentinelFiles({
    absolutePaths: [pythonAbsolutePath, ...runtimeModules.files],
    platformDir
  })
  const archiveName = buildArchiveName({
    platformKey: args.platformKey,
    version: args.version
  })
  const archivePath = path.join(args.outputRoot, archiveName)
  createArchive({ runtimeRoot, platformKey: args.platformKey, archivePath })
  const archiveStat = fs.statSync(archivePath)
  if (archiveStat.size > MAX_RELEASE_ASSET_SIZE) {
    throw new Error(
      `Archive exceeds GitHub release asset limit: ${archiveStat.size} > ${MAX_RELEASE_ASSET_SIZE}`
    )
  }

  const asset = buildRuntimeAsset({
    platformKey: args.platformKey,
    version: args.version,
    archiveName,
    archiveSha256: computeFileSha256(archivePath),
    archiveSize: archiveStat.size,
    pythonRelativePath,
    releaseTag: args.releaseTag,
    files
  })

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releaseTag: args.releaseTag,
    assets: [asset]
  }
  fs.mkdirSync(args.outputRoot, { recursive: true })
  fs.writeFileSync(
    path.join(args.outputRoot, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  console.log(
    `[rekordbox-runtime-package] ${archiveName} (${Math.round(archiveStat.size / 1024 / 1024)} MB)`
  )
  console.log(`[rekordbox-runtime-package] Manifest: ${path.join(args.outputRoot, MANIFEST_NAME)}`)
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMainModule) {
  main().catch((error) => {
    console.error(`[rekordbox-runtime-package] ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  })
}
