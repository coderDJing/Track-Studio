import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createRemoteRuntimeAssetInstaller,
  probeRuntimeModules,
  readJsonFileIfExists
} from './lib/demucs-runtime-support.mjs'
import { ensureDemucsModels } from './lib/demucs-model-ensure.mjs'
import { bootstrapPortableDarwinPython } from './lib/demucs-standalone-python.mjs'
import { validatePortableDarwinRuntime } from './lib/demucs-runtime-portability.mjs'

const runtimeProfilesPath = path.resolve('./scripts/demucs-runtime-profiles.json')
const runtimeProfilesRaw = fs.readFileSync(runtimeProfilesPath, 'utf8')
const runtimeProfiles = JSON.parse(runtimeProfilesRaw)
const packageJsonPath = path.resolve('./package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const modelManifestPath = path.resolve('./scripts/demucs-model-manifest.json')
const DEFAULT_DEMUCS_RUNTIME_RELEASE_TAG = 'demucs-runtime-assets'
const DEFAULT_DEMUCS_RUNTIME_RC_RELEASE_TAG = 'demucs-runtime-assets-rc'
const BASE_RUNTIME_METADATA_FILE = '.frkb-base-runtime-meta.json'

const platformDefault = (() => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
})()

const args = process.argv.slice(2)

const getArgValue = (flag, fallback = '') => {
  const directPrefix = `${flag}=`
  const direct = args.find((arg) => arg.startsWith(directPrefix))
  if (direct) return direct.slice(directPrefix.length).trim()
  const index = args.findIndex((arg) => arg === flag)
  if (index >= 0) {
    const next = args[index + 1]
    return typeof next === 'string' ? next.trim() : ''
  }
  return fallback
}

const hasFlag = (flag) => args.includes(flag)

const parseCsv = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const toShortText = (value, maxLen = 400) => {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen)
}

const configuredDemucsRoot = String(process.env.FRKB_DEMUCS_ROOT || '').trim()
const runtimeRootArg = getArgValue('--runtime-root', configuredDemucsRoot || 'vendor/demucs')
const platformArg = getArgValue('--platform', platformDefault)
const profileArg = getArgValue('--profiles', '')
const modelsArg = getArgValue('--models', '')
const modelRetriesArg = Number(getArgValue('--model-retries', '3'))
const modelTimeoutSecArg = Number(getArgValue('--model-timeout-sec', '600'))
const pipTimeoutSecArg = Number(
  getArgValue('--pip-timeout-sec', String(process.env.FRKB_DEMUCS_PIP_TIMEOUT_SEC || '1200'))
)
const install = !hasFlag('--no-install')
const strict = hasFlag('--strict') || hasFlag('--ci')
const force = hasFlag('--force')
const modelsOnly = hasFlag('--models-only')
const syncRemoteAssets = hasFlag('--sync-remote-assets')
const preferRemoteAssets =
  syncRemoteAssets ||
  !strict ||
  hasFlag('--prefer-remote-assets') ||
  process.env.FRKB_DEMUCS_RUNTIME_PREFER_REMOTE === '1' ||
  process.env.FRKB_DEMUCS_RUNTIME_PREFER_REMOTE === 'true'
const skip =
  process.env.FRKB_SKIP_DEMUCS_RUNTIME_ENSURE === '1' ||
  process.env.FRKB_SKIP_DEMUCS_RUNTIME_ENSURE === 'true'
const pipTimeoutSec = Number.isFinite(pipTimeoutSecArg)
  ? Math.max(30, Math.trunc(pipTimeoutSecArg))
  : 1200

const runtimeRoot = path.resolve(runtimeRootArg)
const isPrereleaseVersion = (value) => /-/.test(String(value || '').trim())
const buildRuntimeManifestUrl = (releaseTag) =>
  `https://github.com/coderDJing/Track-Studio/releases/download/${releaseTag}/demucs-runtime-manifest.json`
const resolveDefaultRuntimeReleaseTag = () => {
  const configuredReleaseTag =
    getArgValue('--runtime-release-tag', '').trim() ||
    String(process.env.FRKB_DEMUCS_RUNTIME_RELEASE_TAG || '').trim()
  if (configuredReleaseTag) return configuredReleaseTag
  const packageVersion = String(packageJson?.version || '').trim()
  return isPrereleaseVersion(packageVersion)
    ? DEFAULT_DEMUCS_RUNTIME_RC_RELEASE_TAG
    : DEFAULT_DEMUCS_RUNTIME_RELEASE_TAG
}
const runtimeAssetManifestUrl =
  getArgValue('--runtime-manifest-url', '').trim() ||
  String(process.env.FRKB_DEMUCS_RUNTIME_MANIFEST_URL || '').trim() ||
  buildRuntimeManifestUrl(resolveDefaultRuntimeReleaseTag())

const resolveRuntimePythonPath = (runtimeDir) => {
  if (process.platform === 'win32') {
    const rootPython = path.join(runtimeDir, 'python.exe')
    if (fs.existsSync(rootPython)) return rootPython
    const scriptsPython = path.join(runtimeDir, 'Scripts', 'python.exe')
    if (fs.existsSync(scriptsPython)) return scriptsPython
    return rootPython
  }
  const binPython3 = path.join(runtimeDir, 'bin', 'python3')
  if (fs.existsSync(binPython3)) return binPython3
  const binPython = path.join(runtimeDir, 'bin', 'python')
  if (fs.existsSync(binPython)) return binPython
  return binPython3
}

const buildRuntimeEnv = (runtimeDir) => {
  const env = {
    ...process.env
  }
  const pathEntries =
    process.platform === 'win32'
      ? [path.join(runtimeDir, 'Scripts'), path.join(runtimeDir, 'Library', 'bin')]
      : [path.join(runtimeDir, 'bin')]
  env.PATH = [...pathEntries, process.env.PATH || ''].filter(Boolean).join(path.delimiter)
  if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = [path.join(runtimeDir, 'lib'), process.env.LD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(path.delimiter)
  } else if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [path.join(runtimeDir, 'lib'), process.env.DYLD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(path.delimiter)
  }
  return env
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.status === 0) return
  throw new Error(`${command} ${commandArgs.join(' ')} -> exit ${result.status ?? -1}`)
}

const runQuiet = (command, commandArgs, options = {}) =>
  spawnSync(command, commandArgs, {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  })

const normalizeResolvedPath = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    return path.resolve(text)
  } catch {
    return ''
  }
}

const isPathInside = (rootDir, targetPath) => {
  const normalizedRoot = normalizeResolvedPath(rootDir)
  const normalizedTarget = normalizeResolvedPath(targetPath)
  if (!normalizedRoot || !normalizedTarget) return false
  const relativePath = path.relative(normalizedRoot, normalizedTarget)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

const inspectPythonRuntime = (command, commandArgs = [], options = {}) => {
  const script = [
    'import json',
    'import os',
    'import sys',
    'payload = {',
    '  "executable": os.path.abspath(sys.executable),',
    '  "prefix": os.path.abspath(sys.prefix),',
    '  "base_prefix": os.path.abspath(getattr(sys, "base_prefix", sys.prefix))',
    '}',
    'print(json.dumps(payload))'
  ].join('\n')
  const result = runQuiet(command, [...commandArgs, '-c', script], {
    timeout: 12_000,
    ...options
  })
  if (result.status !== 0) {
    return {
      ok: false,
      payload: null,
      error: toShortText(result.stderr || result.stdout || `inspect exit ${result.status ?? -1}`)
    }
  }
  const output = String(result.stdout || '')
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!lastLine) {
    return {
      ok: false,
      payload: null,
      error: 'inspect output empty'
    }
  }
  try {
    return {
      ok: true,
      payload: JSON.parse(lastLine),
      error: ''
    }
  } catch (error) {
    return {
      ok: false,
      payload: null,
      error: toShortText(error instanceof Error ? error.message : String(error || ''))
    }
  }
}

const validatePortableWindowsRuntime = (runtimeDir) => {
  if (process.platform !== 'win32') {
    return {
      ok: true,
      payload: null,
      error: ''
    }
  }
  try {
    const aliasNames = fs
      .readdirSync(runtimeDir)
      .filter((name) => /^python[\w.-]*\.exe$/i.test(String(name || '').trim()))
    for (const aliasName of aliasNames) {
      const aliasPath = path.join(runtimeDir, aliasName)
      const stat = fs.lstatSync(aliasPath)
      const lowerAliasName = aliasName.toLowerCase()
      if (lowerAliasName === 'python.exe' || lowerAliasName === 'pythonw.exe') {
        if (stat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(aliasPath)
          return {
            ok: false,
            payload: null,
            error: `canonical python symlink present: ${aliasName} -> ${linkTarget}`
          }
        }
        continue
      }
      const fallbackSourcePath = lowerAliasName.startsWith('pythonw')
        ? path.join(runtimeDir, 'pythonw.exe')
        : path.join(runtimeDir, 'python.exe')
      if (!fs.existsSync(fallbackSourcePath)) {
        const linkTarget = fs.readlinkSync(aliasPath)
        return {
          ok: false,
          payload: null,
          error: `python alias symlink present: ${aliasName} -> ${linkTarget}`
        }
      }
      fs.rmSync(aliasPath, { force: true })
      fs.copyFileSync(fallbackSourcePath, aliasPath)
    }
  } catch (error) {
    return {
      ok: false,
      payload: null,
      error: `inspect runtime aliases failed: ${toShortText(
        error instanceof Error ? error.message : String(error || 'unknown')
      )}`
    }
  }
  const pythonPath = resolveRuntimePythonPath(runtimeDir)
  if (!fs.existsSync(pythonPath)) {
    return {
      ok: false,
      payload: null,
      error: `python missing: ${pythonPath}`
    }
  }
  const identity = inspectPythonRuntime(pythonPath, [], {
    env: buildRuntimeEnv(runtimeDir)
  })
  if (!identity.ok) {
    return {
      ok: false,
      payload: null,
      error: identity.error || `inspect failed: ${pythonPath}`
    }
  }
  const relevantPaths = [
    identity.payload?.executable,
    identity.payload?.prefix,
    identity.payload?.base_prefix
  ]
    .map((entry) => normalizeResolvedPath(entry))
    .filter(Boolean)
  if (relevantPaths.length > 0 && relevantPaths.every((entry) => isPathInside(runtimeDir, entry))) {
    return {
      ok: true,
      payload: identity.payload,
      error: ''
    }
  }
  return {
    ok: false,
    payload: identity.payload,
    error: `non-portable runtime: ${relevantPaths.join(' | ')}`
  }
}

const bootstrapPortableWindowsRuntime = (pythonCommand, targetRuntimeDir) => {
  const identity = inspectPythonRuntime(pythonCommand.command, pythonCommand.args)
  if (!identity.ok || !identity.payload) {
    throw new Error(
      `[demucs-runtime-ensure] Unable to inspect bootstrap Python: ${
        identity.error || 'unknown error'
      }`
    )
  }
  const candidateDirs = []
  const addCandidateDir = (value) => {
    const normalized = normalizeResolvedPath(value)
    if (!normalized || candidateDirs.includes(normalized)) return
    candidateDirs.push(normalized)
  }
  addCandidateDir(identity.payload.base_prefix)
  addCandidateDir(identity.payload.prefix)
  addCandidateDir(path.dirname(normalizeResolvedPath(identity.payload.executable)))
  const sourceRuntimeDir = candidateDirs.find((candidateDir) =>
    fs.existsSync(path.join(candidateDir, 'python.exe'))
  )
  if (!sourceRuntimeDir) {
    throw new Error(
      `[demucs-runtime-ensure] Unable to locate portable Windows Python root from ${
        identity.payload.executable || pythonCommand.command
      }`
    )
  }
  fs.rmSync(targetRuntimeDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(targetRuntimeDir), { recursive: true })
  fs.cpSync(sourceRuntimeDir, targetRuntimeDir, {
    recursive: true,
    dereference: true
  })
  const pyvenvCfgPath = path.join(targetRuntimeDir, 'pyvenv.cfg')
  if (fs.existsSync(pyvenvCfgPath)) {
    fs.rmSync(pyvenvCfgPath, { force: true })
  }
  const portableCheck = validatePortableWindowsRuntime(targetRuntimeDir)
  if (!portableCheck.ok) {
    throw new Error(
      `[demucs-runtime-ensure] Portable Windows runtime validation failed: ${
        portableCheck.error || 'unknown error'
      }`
    )
  }
  return {
    sourceRuntimeDir,
    payload: portableCheck.payload
  }
}

const probeCommand = (command, commandArgs) => {
  try {
    const result = runQuiet(command, commandArgs)
    return result.status === 0
  } catch {
    return false
  }
}

const addUniqueItem = (target, value) => {
  const normalized = String(value || '').trim()
  if (!normalized) return
  if (target.includes(normalized)) return
  target.push(normalized)
}

const normalizeStringArray = (value) =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : []

const arraysEqual = (left, right) => {
  if (left.length !== right.length) return false
  return left.every((item, index) => item === right[index])
}

const resolveSystemPythonCommand = () => {
  const candidates = []
  const candidateKeys = new Set()

  const addCandidate = (command, args = [], source = '') => {
    const normalizedCommand = String(command || '').trim()
    const normalizedArgs = Array.isArray(args)
      ? args.map((item) => String(item || '').trim()).filter(Boolean)
      : []
    if (!normalizedCommand) return
    const key = JSON.stringify([normalizedCommand, normalizedArgs])
    if (candidateKeys.has(key)) return
    candidateKeys.add(key)
    candidates.push({
      command: normalizedCommand,
      args: normalizedArgs,
      source: String(source || '').trim()
    })
  }

  const addEnvPythonCandidate = (rawValue, source) => {
    const normalized = String(rawValue || '').trim()
    if (!normalized) return
    if (fs.existsSync(normalized)) {
      const stat = fs.statSync(normalized)
      if (stat.isDirectory()) {
        const derivedPaths =
          process.platform === 'win32'
            ? [path.join(normalized, 'python.exe'), path.join(normalized, 'Scripts', 'python.exe')]
            : [path.join(normalized, 'bin', 'python3'), path.join(normalized, 'bin', 'python')]
        for (const derivedPath of derivedPaths) {
          if (fs.existsSync(derivedPath)) {
            addCandidate(derivedPath, [], source)
          }
        }
        return
      }
    }
    addCandidate(normalized, [], source)
  }

  addEnvPythonCandidate(process.env.PYTHON, 'env:PYTHON')
  addEnvPythonCandidate(process.env.npm_config_python, 'env:npm_config_python')
  addEnvPythonCandidate(process.env.pythonLocation, 'env:pythonLocation')

  if (process.platform === 'win32') {
    addCandidate('python', [], 'path:python')
    addCandidate('python3', [], 'path:python3')
    addCandidate('py', ['-3'], 'launcher:py -3')
  } else {
    addCandidate('python3', [], 'path:python3')
    addCandidate('python', [], 'path:python')
  }

  for (const candidate of candidates) {
    const result = runQuiet(candidate.command, [...candidate.args, '--version'])
    if (result.status !== 0) continue
    const version = toShortText(result.stdout || result.stderr || '', 80)
    return {
      ...candidate,
      version
    }
  }
  return null
}

const normalizeList = (input) =>
  Array.isArray(input) ? input.map((item) => String(item).trim()).filter(Boolean) : []

const isBeatThisRequirement = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (!normalized) return false
  return (
    normalized.includes('beat-this') ||
    normalized.includes('beat_this') ||
    normalized.includes('/cpjku/beat_this')
  )
}

const normalizeRelativePath = (value) => {
  const relativePath = String(value || '')
    .trim()
    .replace(/\\/g, '/')
  if (!relativePath) return ''
  if (relativePath.startsWith('/')) return ''
  if (relativePath.includes('..')) return ''
  if (!/^[a-zA-Z0-9._/-]+$/.test(relativePath)) return ''
  return relativePath
}

const normalizeSha256 = (value) => {
  const hash = String(value || '')
    .trim()
    .toLowerCase()
  return /^[0-9a-f]{64}$/.test(hash) ? hash : ''
}

const computeFileSha256 = async (filePath) => {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

const tryInstallProfileFromRemoteAsset = createRemoteRuntimeAssetInstaller({
  preferRemoteAssets,
  syncRemoteAssets,
  runtimeAssetManifestUrl,
  platformArg,
  runtimeRoot,
  run,
  normalizeSha256,
  normalizeRelativePath,
  computeFileSha256,
  toShortText
})

const validateRuntimePortability = ({ runtimeDir, pythonPath, label }) => {
  if (process.platform === 'win32') {
    const portableCheck = validatePortableWindowsRuntime(runtimeDir)
    if (!portableCheck.ok) {
      throw new Error(`[demucs-runtime-ensure] ${label} is not portable: ${portableCheck.error}`)
    }
    return
  }
  if (process.platform === 'darwin') {
    const portableCheck = validatePortableDarwinRuntime({
      runtimeDir,
      pythonPath,
      env: buildRuntimeEnv(runtimeDir)
    })
    if (!portableCheck.ok) {
      throw new Error(`[demucs-runtime-ensure] ${label} is not portable: ${portableCheck.error}`)
    }
  }
}

const tryRestorePortableProfileFromRemoteAsset = async (profileName, runtimeDir) => {
  const restored = await tryInstallProfileFromRemoteAsset(profileName, runtimeDir)
  if (!restored) return false
  const pythonPath = resolveRuntimePythonPath(runtimeDir)
  validateRuntimePortability({
    runtimeDir,
    pythonPath,
    label: `Runtime asset (${profileName})`
  })
  return true
}

const probeWindowsGpuAdapters = () => {
  if (process.platform !== 'win32') {
    return {
      names: [],
      hasNvidia: false,
      hasIntel: false,
      hasAmd: false
    }
  }
  const script =
    'Get-CimInstance Win32_VideoController | ForEach-Object { ($_.Name | Out-String).Trim() }'
  const result = runQuiet('powershell', ['-NoProfile', '-Command', script], {
    timeout: 8_000
  })
  if (result.status !== 0) {
    return {
      names: [],
      hasNvidia: false,
      hasIntel: false,
      hasAmd: false
    }
  }
  const names = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const effectiveNames = names.filter((name) => {
    const lowered = name.toLowerCase()
    if (lowered.includes('microsoft basic render')) return false
    if (lowered.includes('microsoft remote display')) return false
    return true
  })
  const joined = effectiveNames.join(' ').toLowerCase()
  return {
    names: effectiveNames,
    hasNvidia: joined.includes('nvidia') || joined.includes('geforce') || joined.includes('quadro'),
    hasIntel: joined.includes('intel') || joined.includes('arc'),
    hasAmd:
      joined.includes('amd') ||
      joined.includes('radeon') ||
      joined.includes('advanced micro devices')
  }
}

const resolveAutoProfiles = (platformKey, platformConfig) => {
  const profileSet = new Set(['cpu'])
  if (platformKey === 'win32-x64') {
    const adapters = probeWindowsGpuAdapters()
    if (adapters.hasNvidia) profileSet.add('cuda')
    if (adapters.hasIntel) profileSet.add('xpu')
    if (adapters.hasAmd) profileSet.add('directml')
  } else if (platformKey === 'darwin-arm64') {
    profileSet.add('mps')
  } else if (platformKey.startsWith('linux')) {
    if (probeCommand('nvidia-smi', ['-L'])) profileSet.add('cuda')
    if (probeCommand('rocminfo', []) || probeCommand('rocm-smi', ['--showproductname'])) {
      profileSet.add('rocm')
    }
  }
  return Array.from(profileSet).filter((item) => !!platformConfig?.profiles?.[item])
}

const ensureBaseRuntime = async (platformKey, platformConfig) => {
  const baseRuntimeDirName = String(platformConfig?.baseRuntimeDir || 'runtime')
  const baseRuntimeDir = path.resolve(runtimeRoot, platformKey, baseRuntimeDirName)
  const basePipInstallArgs = normalizeList(platformConfig?.basePipInstall)
  const basePythonPath = resolveRuntimePythonPath(baseRuntimeDir)
  const baseEnv = buildRuntimeEnv(baseRuntimeDir)
  const baseMetadataPath = path.join(baseRuntimeDir, BASE_RUNTIME_METADATA_FILE)
  const baseMetadata = readJsonFileIfExists(baseMetadataPath)
  let bootstrapMetadata = {}

  let needsBootstrap = !fs.existsSync(basePythonPath)
  if (!needsBootstrap) {
    try {
      validateRuntimePortability({
        runtimeDir: baseRuntimeDir,
        pythonPath: basePythonPath,
        label: 'Base runtime'
      })
    } catch (error) {
      console.warn(
        `[demucs-runtime-ensure] Rebuilding non-portable base runtime: ${toShortText(
          error instanceof Error ? error.message : String(error || 'unknown')
        )}`
      )
      fs.rmSync(baseRuntimeDir, { recursive: true, force: true })
      needsBootstrap = true
    }
  }
  if (
    !needsBootstrap &&
    install &&
    !arraysEqual(normalizeStringArray(baseMetadata?.pipInstallArgs), basePipInstallArgs)
  ) {
    console.warn(
      `[demucs-runtime-ensure] Rebuilding base runtime due to dependency change: ${baseRuntimeDir}`
    )
    fs.rmSync(baseRuntimeDir, { recursive: true, force: true })
    needsBootstrap = true
  }

  if (needsBootstrap) {
    fs.mkdirSync(path.dirname(baseRuntimeDir), { recursive: true })
    if (process.platform === 'darwin') {
      console.log(
        `[demucs-runtime-ensure] Creating portable Darwin base runtime: ${baseRuntimeDir}`
      )
      const bootstrapResult = await bootstrapPortableDarwinPython({
        platformKey,
        runtimeRoot,
        targetRuntimeDir: baseRuntimeDir,
        run
      })
      console.log(
        `[demucs-runtime-ensure] Installed standalone Darwin runtime from ${bootstrapResult.assetName}`
      )
      bootstrapMetadata = {
        bootstrapProvider: 'python-build-standalone',
        bootstrapReleaseTag: bootstrapResult.releaseTag,
        bootstrapPythonVersion: bootstrapResult.pythonVersion,
        bootstrapTargetTriple: bootstrapResult.targetTriple,
        bootstrapAssetName: bootstrapResult.assetName
      }
    } else {
      const pythonCommand = resolveSystemPythonCommand()
      if (!pythonCommand) {
        throw new Error('[demucs-runtime-ensure] No system Python found for bootstrap')
      }
      const bootstrapCommandText = [pythonCommand.command, ...pythonCommand.args].join(' ')
      const bootstrapVersionText = pythonCommand.version ? ` (${pythonCommand.version})` : ''
      const bootstrapSourceText = pythonCommand.source ? ` via ${pythonCommand.source}` : ''
      const venvArgs = [...pythonCommand.args, '-m', 'venv', baseRuntimeDir]
      console.log(`[demucs-runtime-ensure] Creating base runtime: ${baseRuntimeDir}`)
      console.log(
        `[demucs-runtime-ensure] Bootstrap Python${bootstrapSourceText}: ${bootstrapCommandText}${bootstrapVersionText}`
      )
      if (process.platform === 'win32') {
        const bootstrapResult = bootstrapPortableWindowsRuntime(pythonCommand, baseRuntimeDir)
        console.log(
          `[demucs-runtime-ensure] Copied portable Windows runtime from ${bootstrapResult.sourceRuntimeDir}`
        )
        bootstrapMetadata = {
          bootstrapProvider: 'system-python-copy',
          bootstrapCommand: bootstrapCommandText,
          bootstrapSource: pythonCommand.source || '',
          bootstrapVersion: pythonCommand.version || ''
        }
      } else {
        run(pythonCommand.command, venvArgs)
        bootstrapMetadata = {
          bootstrapProvider: 'system-python-venv',
          bootstrapCommand: bootstrapCommandText,
          bootstrapSource: pythonCommand.source || '',
          bootstrapVersion: pythonCommand.version || ''
        }
      }
    }
  }

  const resolvedBasePython = resolveRuntimePythonPath(baseRuntimeDir)
  if (!fs.existsSync(resolvedBasePython)) {
    throw new Error(`[demucs-runtime-ensure] Base runtime python missing: ${resolvedBasePython}`)
  }
  validateRuntimePortability({
    runtimeDir: baseRuntimeDir,
    pythonPath: resolvedBasePython,
    label: 'Base runtime'
  })

  if (install) {
    const baseProbe = runQuiet(
      resolvedBasePython,
      ['-c', 'import demucs, torch, torchaudio, onnxruntime'],
      { env: baseEnv }
    )
    if (baseProbe.status !== 0 && basePipInstallArgs.length > 0) {
      console.log(
        `[demucs-runtime-ensure] Installing base runtime deps: ${basePipInstallArgs.join(' ')}`
      )
      run(resolvedBasePython, buildPipInstallArgs(basePipInstallArgs), { env: baseEnv })
    }
    fs.writeFileSync(
      baseMetadataPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          platform: platformKey,
          baseRuntimeDir: baseRuntimeDirName,
          pipInstallArgs: basePipInstallArgs,
          ...bootstrapMetadata
        },
        null,
        2
      )}\n`,
      'utf8'
    )
  }

  fs.mkdirSync(path.resolve(runtimeRoot, 'models'), { recursive: true })

  return {
    baseRuntimeDir,
    basePythonPath: resolvedBasePython,
    basePipInstallArgs
  }
}

const buildPrepareCommand = (params) => {
  const commandArgs = [
    path.resolve('./scripts/prepare-demucs-runtimes.mjs'),
    '--runtime-root',
    runtimeRoot,
    '--platform',
    platformArg,
    '--profiles',
    params.profiles.join(',')
  ]
  if (install) commandArgs.push('--install')
  if (params.force) commandArgs.push('--force')
  commandArgs.push('--pip-timeout-sec', String(pipTimeoutSec))
  return commandArgs
}

const runPrepare = (profiles, options = {}) => {
  const uniqueProfiles = Array.from(
    new Set(profiles.map((item) => String(item).trim()).filter(Boolean))
  )
  if (uniqueProfiles.length === 0) return
  const commandArgs = buildPrepareCommand({
    profiles: uniqueProfiles,
    force: !!options.force
  })
  run(process.execPath, commandArgs)
}

const buildPipInstallArgs = (requirements) => [
  '-m',
  'pip',
  'install',
  '--upgrade',
  '--timeout',
  String(pipTimeoutSec),
  ...requirements
]

const main = async () => {
  if (skip) {
    console.log('[demucs-runtime-ensure] Skip requested via FRKB_SKIP_DEMUCS_RUNTIME_ENSURE')
    return
  }

  const platformConfig = runtimeProfiles?.[platformArg]
  if (!platformConfig || typeof platformConfig !== 'object') {
    throw new Error(`[demucs-runtime-ensure] Unsupported platform key: ${platformArg}`)
  }

  if (modelsOnly) {
    await ensureDemucsModels({
      runtimeRoot,
      modelManifestPath,
      modelsArg,
      modelRetriesArg,
      modelTimeoutSecArg,
      toShortText
    })
    console.log('[demucs-runtime-ensure] Completed (models only)')
    return
  }

  const baseRuntimeInfo = syncRemoteAssets
    ? {
        basePipInstallArgs: []
      }
    : await ensureBaseRuntime(platformArg, platformConfig)

  const explicitProfiles = parseCsv(profileArg)
  const selectedProfiles =
    explicitProfiles.length > 0
      ? explicitProfiles.filter((profileName) => !!platformConfig.profiles?.[profileName])
      : resolveAutoProfiles(platformArg, platformConfig)

  if (selectedProfiles.length === 0) {
    console.log('[demucs-runtime-ensure] No matching profiles selected, skip')
    return
  }

  const rebuildProfiles = []
  const missingProfiles = []
  const brokenProfiles = []

  for (const profileName of selectedProfiles) {
    const profileConfig = platformConfig.profiles?.[profileName]
    if (!profileConfig) continue
    const runtimeDir = path.resolve(
      runtimeRoot,
      platformArg,
      String(profileConfig.targetDir || `runtime-${profileName}`)
    )
    const pythonPath = resolveRuntimePythonPath(runtimeDir)
    const metadataPath = path.join(runtimeDir, '.frkb-runtime-meta.json')
    const pipInstallArgs = normalizeList(profileConfig.pipInstall)
    const metadata = readJsonFileIfExists(metadataPath)
    const checkpointRelativePath = normalizeRelativePath(metadata?.beatThisCheckpointRelativePath)
    const checkpointPath = checkpointRelativePath
      ? path.join(runtimeDir, ...checkpointRelativePath.split('/'))
      : ''
    const beatThisExpected = pipInstallArgs.some((item) => isBeatThisRequirement(item))

    if (syncRemoteAssets) {
      const synced = await tryRestorePortableProfileFromRemoteAsset(profileName, runtimeDir)
      if (!synced) {
        throw new Error(`[demucs-runtime-ensure] Runtime asset sync failed (${profileName})`)
      }
      continue
    }

    if (!fs.existsSync(pythonPath)) {
      const restored = await tryRestorePortableProfileFromRemoteAsset(profileName, runtimeDir)
      if (restored) continue
      missingProfiles.push(profileName)
      continue
    }

    if (install && !fs.existsSync(metadataPath)) {
      const restored = await tryRestorePortableProfileFromRemoteAsset(profileName, runtimeDir)
      if (restored) continue
      addUniqueItem(rebuildProfiles, profileName)
      continue
    }

    if (
      install &&
      metadata &&
      (!arraysEqual(normalizeStringArray(metadata?.pipInstallArgs), pipInstallArgs) ||
        !arraysEqual(
          normalizeStringArray(metadata?.basePipInstallArgs),
          baseRuntimeInfo.basePipInstallArgs
        ))
    ) {
      const restored = await tryRestorePortableProfileFromRemoteAsset(profileName, runtimeDir)
      if (restored) continue
      addUniqueItem(rebuildProfiles, profileName)
      console.warn(
        `[demucs-runtime-ensure] Runtime metadata changed (${profileName}), will rebuild`
      )
      continue
    }

    if (!install) continue
    try {
      validateRuntimePortability({
        runtimeDir,
        pythonPath,
        label: `Runtime (${profileName})`
      })
    } catch (error) {
      const restored = await tryRestorePortableProfileFromRemoteAsset(profileName, runtimeDir)
      if (restored) continue
      addUniqueItem(brokenProfiles, profileName)
      addUniqueItem(rebuildProfiles, profileName)
      console.warn(
        `[demucs-runtime-ensure] Runtime portability check failed (${profileName}), will rebuild: ${toShortText(
          error instanceof Error ? error.message : String(error || 'unknown')
        )}`
      )
      continue
    }
    const probe = probeRuntimeModules({
      pythonPath,
      runtimeDir,
      buildRuntimeEnv,
      runQuiet,
      toShortText
    })
    if (!probe.ok || !probe.payload) {
      const restored = await tryRestorePortableProfileFromRemoteAsset(profileName, runtimeDir)
      if (restored) continue
      addUniqueItem(brokenProfiles, profileName)
      addUniqueItem(rebuildProfiles, profileName)
      console.warn(
        `[demucs-runtime-ensure] Runtime probe failed (${profileName}), will rebuild: ${
          probe.error || 'unknown'
        }`
      )
      continue
    }
    const payload = probe.payload
    const baseReady = !!payload.demucs && !!payload.torch && !!payload.torchaudio
    const requiresDirectml = profileName === 'directml'
    const requiresXpu = profileName === 'xpu'
    const directmlReady = !requiresDirectml ? true : !!payload.torch_directml
    const xpuReady = !requiresXpu ? true : !!payload.xpu_backend
    const beatThisReady = !beatThisExpected
      ? true
      : !!payload.beat_this && !!payload.soxr && !!payload.rotary_embedding_torch
    const checkpointReady = !beatThisExpected || (!!checkpointPath && fs.existsSync(checkpointPath))
    if (!baseReady || !directmlReady || !xpuReady || !beatThisReady || !checkpointReady) {
      const restored = await tryRestorePortableProfileFromRemoteAsset(profileName, runtimeDir)
      if (restored) continue
      addUniqueItem(brokenProfiles, profileName)
      addUniqueItem(rebuildProfiles, profileName)
      console.warn(
        `[demucs-runtime-ensure] Runtime deps incomplete (${profileName}), will rebuild: demucs=${payload.demucs} torch=${payload.torch} torchaudio=${payload.torchaudio} torch_version=${payload.torch_version || ''} xpu_backend=${payload.xpu_backend} torch_directml=${payload.torch_directml} beat_this=${payload.beat_this} soxr=${payload.soxr} rotary=${payload.rotary_embedding_torch} checkpoint=${checkpointReady}`
      )
    }
  }

  console.log(
    `[demucs-runtime-ensure] Selected profiles: ${selectedProfiles.join(', ')} (missing=${missingProfiles.length}, rebuild=${rebuildProfiles.length}, broken=${brokenProfiles.length})`
  )

  if (rebuildProfiles.length > 0) {
    runPrepare(rebuildProfiles, { force: true })
  }
  if (missingProfiles.length > 0) {
    runPrepare(missingProfiles, { force })
  }

  await ensureDemucsModels({
    runtimeRoot,
    modelManifestPath,
    modelsArg,
    modelRetriesArg,
    modelTimeoutSecArg,
    toShortText
  })

  console.log('[demucs-runtime-ensure] Completed')
}

void (async () => {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (strict) {
      console.error(`[demucs-runtime-ensure] Failed: ${message}`)
      process.exit(1)
    }
    console.warn(`[demucs-runtime-ensure] Warning: ${message}`)
    process.exit(0)
  }
})()
