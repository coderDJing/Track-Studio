import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { validatePortableDarwinRuntime } from './lib/demucs-runtime-portability.mjs'

const runtimeProfilesPath = path.resolve('./scripts/demucs-runtime-profiles.json')
const runtimeProfilesRaw = fs.readFileSync(runtimeProfilesPath, 'utf8')
const runtimeProfiles = JSON.parse(runtimeProfilesRaw)

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

const configuredDemucsRoot = String(process.env.FRKB_DEMUCS_ROOT || '').trim()
const runtimeRootArg = getArgValue('--runtime-root', configuredDemucsRoot || 'vendor/demucs')
const platformArg = getArgValue('--platform', platformDefault)
const profileArg = getArgValue('--profiles', '')
const pipExtraArg = getArgValue('--pip-extra', '')
const pipTimeoutSecArg = Number(
  getArgValue('--pip-timeout-sec', String(process.env.FRKB_DEMUCS_PIP_TIMEOUT_SEC || '1200'))
)
const force = hasFlag('--force')
const install = hasFlag('--install')
const pipTimeoutSec = Number.isFinite(pipTimeoutSecArg)
  ? Math.max(30, Math.trunc(pipTimeoutSecArg))
  : 1200
const pipExtraArgs = pipExtraArg
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const BEAT_THIS_CHECKPOINT_URL =
  'https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt'
const BEAT_THIS_CHECKPOINT_RELATIVE_PATH = 'beat-this-checkpoints/final0.ckpt'

const runtimeRoot = path.resolve(runtimeRootArg)
const platformConfig = runtimeProfiles?.[platformArg]

if (!platformConfig || typeof platformConfig !== 'object') {
  console.error(`[demucs-runtime] Unsupported platform key: ${platformArg}`)
  process.exit(1)
}

const baseRuntimeDir = path.resolve(
  runtimeRoot,
  platformArg,
  String(platformConfig.baseRuntimeDir || 'runtime')
)
const basePipInstallArgs = Array.isArray(platformConfig.basePipInstall)
  ? platformConfig.basePipInstall.map((item) => String(item).trim()).filter(Boolean)
  : []
if (!fs.existsSync(baseRuntimeDir)) {
  console.error(`[demucs-runtime] Base runtime not found: ${baseRuntimeDir}`)
  process.exit(1)
}

const profileConfigEntries = Object.entries(platformConfig.profiles || {})
if (profileConfigEntries.length === 0) {
  console.error(`[demucs-runtime] No profiles configured for platform: ${platformArg}`)
  process.exit(1)
}

const requestedProfiles = profileArg
  ? profileArg
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  : profileConfigEntries.map(([profileName]) => profileName)

const selectedProfiles = requestedProfiles
  .map((profileName) => [profileName, platformConfig.profiles?.[profileName]])
  .filter(([, profileConfig]) => !!profileConfig)

if (selectedProfiles.length === 0) {
  console.error(
    `[demucs-runtime] No valid profiles selected. Available: ${profileConfigEntries
      .map(([name]) => name)
      .join(', ')}`
  )
  process.exit(1)
}

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

const buildPipInstallArgs = (requirements) => [
  '-m',
  'pip',
  'install',
  '--upgrade',
  '--timeout',
  String(pipTimeoutSec),
  ...requirements
]

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

const inspectPythonRuntime = (pythonPath, runtimeDir) => {
  const result = spawnSync(
    pythonPath,
    [
      '-c',
      [
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
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 12_000,
      env: buildRuntimeEnv(runtimeDir)
    }
  )
  if (result.status !== 0) {
    return {
      ok: false,
      payload: null,
      error: String(result.stderr || result.stdout || `inspect exit ${result.status ?? -1}`).trim()
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
      error: error instanceof Error ? error.message : String(error || '')
    }
  }
}

const validatePortableWindowsRuntime = (runtimeDir) => {
  if (process.platform !== 'win32') {
    return {
      ok: true,
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
          error: `python alias symlink present: ${aliasName} -> ${linkTarget}`
        }
      }
      fs.rmSync(aliasPath, { force: true })
      fs.copyFileSync(fallbackSourcePath, aliasPath)
    }
  } catch (error) {
    return {
      ok: false,
      error: `inspect runtime aliases failed: ${
        error instanceof Error ? error.message : String(error || 'unknown')
      }`
    }
  }
  const pythonPath = resolveRuntimePythonPath(runtimeDir)
  if (!fs.existsSync(pythonPath)) {
    return {
      ok: false,
      error: `python missing: ${pythonPath}`
    }
  }
  const identity = inspectPythonRuntime(pythonPath, runtimeDir)
  if (!identity.ok) {
    return {
      ok: false,
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
      error: ''
    }
  }
  return {
    ok: false,
    error: `non-portable runtime: ${relevantPaths.join(' | ')}`
  }
}

const runProbe = ({ pythonPath, runtimeDir, runtimeKey }) => {
  const env = buildRuntimeEnv(runtimeDir)
  const script = [
    'import json',
    'payload = {"runtime_key": "", "torch_version": "", "cuda": False, "mps": False, "xpu": False, "xpu_backend_installed": False, "directml_installed": False, "onnxruntime_installed": False, "onnxruntime_directml_installed": False, "beat_this": False, "beat_this_version": "", "soxr": False, "rotary_embedding_torch": False}',
    `payload["runtime_key"] = ${JSON.stringify(runtimeKey)}`,
    'try:',
    '  import torch',
    '  payload["torch_version"] = str(getattr(torch, "__version__", ""))',
    '  payload["cuda"] = bool(getattr(torch, "cuda", None) and torch.cuda.is_available())',
    '  mps_backend = getattr(getattr(torch, "backends", None), "mps", None)',
    '  payload["mps"] = bool(mps_backend and mps_backend.is_available())',
    '  xpu_backend = getattr(torch, "xpu", None)',
    '  xpu_backend_installed = bool(xpu_backend) and ("+cpu" not in payload["torch_version"].lower())',
    '  payload["xpu_backend_installed"] = xpu_backend_installed',
    '  payload["xpu"] = bool(xpu_backend_installed and xpu_backend and xpu_backend.is_available())',
    'except Exception as exc:',
    '  payload["torch_error"] = str(exc)',
    'try:',
    '  import torch_directml',
    '  payload["directml_installed"] = True',
    'except Exception:',
    '  payload["directml_installed"] = False',
    'try:',
    '  import onnxruntime',
    '  payload["onnxruntime_installed"] = True',
    'except Exception:',
    '  payload["onnxruntime_installed"] = False',
    'try:',
    '  providers = []',
    '  import onnxruntime as _ort',
    '  providers = list(_ort.get_available_providers())',
    '  payload["onnxruntime_directml_installed"] = "DmlExecutionProvider" in providers',
    'except Exception:',
    '  payload["onnxruntime_directml_installed"] = False',
    'try:',
    '  import importlib.metadata as _metadata',
    '  import beat_this',
    '  payload["beat_this"] = True',
    '  payload["beat_this_version"] = str(_metadata.version("beat-this"))',
    'except Exception as exc:',
    '  payload["beat_this_error"] = str(exc)',
    'try:',
    '  import soxr',
    '  payload["soxr"] = True',
    'except Exception as exc:',
    '  payload["soxr_error"] = str(exc)',
    'try:',
    '  import rotary_embedding_torch',
    '  payload["rotary_embedding_torch"] = True',
    'except Exception as exc:',
    '  payload["rotary_embedding_torch_error"] = str(exc)',
    'print(json.dumps(payload))'
  ].join('\n')
  const result = spawnSync(pythonPath, ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
    env
  })
  if (result.status !== 0) {
    throw new Error(
      `[demucs-runtime] Probe failed for ${runtimeKey}: ${result.stderr || result.stdout}`
    )
  }
  const output = String(result.stdout || '')
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!lastLine) {
    throw new Error(`[demucs-runtime] Probe output empty for ${runtimeKey}`)
  }
  return JSON.parse(lastLine)
}

const validateRuntimePortability = ({ runtimeDir, pythonPath, profileName, stage }) => {
  if (process.platform === 'win32') {
    const portableCheck = validatePortableWindowsRuntime(runtimeDir)
    if (!portableCheck.ok) {
      return {
        ok: false,
        error: `[demucs-runtime] Runtime is not portable for ${profileName} (${stage}): ${portableCheck.error}`
      }
    }
    return {
      ok: true,
      error: ''
    }
  }
  if (process.platform === 'darwin') {
    const portableCheck = validatePortableDarwinRuntime({
      runtimeDir,
      pythonPath,
      env: buildRuntimeEnv(runtimeDir)
    })
    if (!portableCheck.ok) {
      return {
        ok: false,
        error: `[demucs-runtime] Runtime is not portable for ${profileName} (${stage}): ${portableCheck.error}`
      }
    }
  }
  return {
    ok: true,
    error: ''
  }
}

const runCompatibilityProbe = ({ pythonPath, runtimeDir, scriptLines }) => {
  const env = buildRuntimeEnv(runtimeDir)
  const result = spawnSync(pythonPath, ['-c', scriptLines.join('\n')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 12_000,
    env
  })
  return result.status === 0
}

const writeJson = (filePath, data) => {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

const normalizeAssetRelativePath = (value) =>
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')

const resolveRuntimeAssetPath = (runtimeDir, relativePath) =>
  path.join(runtimeDir, ...normalizeAssetRelativePath(relativePath).split('/'))

const computeFileSha256 = (filePath) => {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

const ensureBeatThisCheckpoint = async (params) => {
  const relativePath = normalizeAssetRelativePath(BEAT_THIS_CHECKPOINT_RELATIVE_PATH)
  const checkpointPath = resolveRuntimeAssetPath(params.runtimeDir, relativePath)
  if (!params.install && !fs.existsSync(checkpointPath)) {
    return {
      relativePath: '',
      sha256: '',
      url: BEAT_THIS_CHECKPOINT_URL
    }
  }

  if (!params.force && fs.existsSync(checkpointPath)) {
    return {
      relativePath,
      sha256: computeFileSha256(checkpointPath),
      url: BEAT_THIS_CHECKPOINT_URL
    }
  }

  console.log(`[demucs-runtime] Downloading Beat This checkpoint -> ${relativePath}`)
  const response = await fetch(BEAT_THIS_CHECKPOINT_URL)
  if (!response.ok) {
    throw new Error(
      `[demucs-runtime] Beat This checkpoint download failed: HTTP ${response.status}`
    )
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength <= 0) {
    throw new Error('[demucs-runtime] Beat This checkpoint download empty')
  }
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true })
  fs.writeFileSync(checkpointPath, buffer)
  return {
    relativePath,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    url: BEAT_THIS_CHECKPOINT_URL
  }
}

const buildPortableRuntimeCopyOptions = () => ({
  recursive: true,
  ...(process.platform === 'darwin' ? { verbatimSymlinks: true } : {})
})

const main = async () => {
  for (const [profileName, profileConfig] of selectedProfiles) {
    const targetDirName = String(profileConfig.targetDir || `runtime-${profileName}`)
    const targetRuntimeDir = path.resolve(runtimeRoot, platformArg, targetDirName)
    const pipInstallArgs = [
      ...(Array.isArray(profileConfig.pipInstall)
        ? profileConfig.pipInstall.map((item) => String(item).trim()).filter(Boolean)
        : []),
      ...pipExtraArgs
    ]
      .map((item) => String(item).trim())
      .filter(Boolean)

    if (fs.existsSync(targetRuntimeDir)) {
      const existingPythonPath = resolveRuntimePythonPath(targetRuntimeDir)
      const portabilityCheck = validateRuntimePortability({
        runtimeDir: targetRuntimeDir,
        pythonPath: existingPythonPath,
        profileName,
        stage: 'existing'
      })
      if (!portabilityCheck.ok) {
        fs.rmSync(targetRuntimeDir, { recursive: true, force: true })
        console.log(
          `[demucs-runtime] Removed non-portable runtime (${profileName}): ${portabilityCheck.error}`
        )
      }
    }

    if (fs.existsSync(targetRuntimeDir)) {
      if (!force) {
        console.log(`[demucs-runtime] Skip existing runtime (${profileName}): ${targetRuntimeDir}`)
      } else {
        fs.rmSync(targetRuntimeDir, { recursive: true, force: true })
        console.log(`[demucs-runtime] Removed existing runtime (${profileName})`)
      }
    }

    if (!fs.existsSync(targetRuntimeDir)) {
      fs.cpSync(baseRuntimeDir, targetRuntimeDir, buildPortableRuntimeCopyOptions())
      console.log(`[demucs-runtime] Copied base runtime -> ${targetDirName}`)
    }

    const pythonPath = resolveRuntimePythonPath(targetRuntimeDir)
    if (!fs.existsSync(pythonPath)) {
      throw new Error(`[demucs-runtime] Python not found for ${profileName}: ${pythonPath}`)
    }
    const runtimePortabilityCheck = validateRuntimePortability({
      runtimeDir: targetRuntimeDir,
      pythonPath,
      profileName,
      stage: 'prepared'
    })
    if (!runtimePortabilityCheck.ok) {
      throw new Error(runtimePortabilityCheck.error)
    }
    const runtimeEnv = buildRuntimeEnv(targetRuntimeDir)

    if (install && pipInstallArgs.length > 0) {
      console.log(
        `[demucs-runtime] Installing pip deps for ${profileName}: ${pipInstallArgs.join(' ')}`
      )
      run(pythonPath, buildPipInstallArgs(pipInstallArgs), {
        cwd: targetRuntimeDir,
        env: runtimeEnv
      })
    } else if (pipInstallArgs.length > 0) {
      console.log(
        `[demucs-runtime] ${profileName} has pip deps configured but --install not set, skipped install`
      )
    }

    const beatThisCheckpoint = await ensureBeatThisCheckpoint({
      runtimeDir: targetRuntimeDir,
      install,
      force
    })
    const probe = runProbe({
      pythonPath,
      runtimeDir: targetRuntimeDir,
      runtimeKey: profileName
    })
    if (probe?.directml_installed) {
      probe.directml_demucs_compatible = runCompatibilityProbe({
        pythonPath,
        runtimeDir: targetRuntimeDir,
        scriptLines: [
          'import torch',
          'import torch_directml',
          'x = torch.randn(2048, device="privateuseone:0")',
          '_ = torch.fft.rfft(x)',
          'print("ok")'
        ]
      })
    } else {
      probe.directml_demucs_compatible = false
    }
    if (probe?.xpu) {
      probe.xpu_demucs_compatible = runCompatibilityProbe({
        pythonPath,
        runtimeDir: targetRuntimeDir,
        scriptLines: [
          'import torch',
          'xpu_backend = getattr(torch, "xpu", None)',
          'assert xpu_backend and xpu_backend.is_available()',
          'x = torch.randn(2048, device="xpu")',
          '_ = torch.fft.rfft(x)',
          'print("ok")'
        ]
      })
    } else {
      probe.xpu_demucs_compatible = false
    }
    const metadata = {
      runtimeKey: profileName,
      platform: platformArg,
      generatedAt: new Date().toISOString(),
      installExecuted: install,
      basePipInstallArgs,
      pipInstallArgs,
      torchVersion: String(probe?.torch_version || ''),
      xpuAvailable: !!probe?.xpu,
      xpuBackendInstalled: !!probe?.xpu_backend_installed,
      xpuDemucsCompatible: !!probe?.xpu_demucs_compatible,
      directmlInstalled: !!probe?.directml_installed,
      directmlDemucsCompatible: !!probe?.directml_demucs_compatible,
      beatThisInstalled: !!probe?.beat_this,
      beatThisVersion: String(probe?.beat_this_version || ''),
      beatThisCheckpointRelativePath: beatThisCheckpoint.relativePath || '',
      beatThisCheckpointUrl: beatThisCheckpoint.url || '',
      beatThisCheckpointSha256: beatThisCheckpoint.sha256 || '',
      soxrInstalled: !!probe?.soxr,
      rotaryEmbeddingTorchInstalled: !!probe?.rotary_embedding_torch,
      probe
    }
    writeJson(path.join(targetRuntimeDir, '.frkb-runtime-meta.json'), metadata)
    console.log(
      `[demucs-runtime] Ready ${profileName} -> cuda=${probe.cuda} mps=${probe.mps} xpu=${probe.xpu} xpu-backend=${probe.xpu_backend_installed} directml=${probe.directml_installed} directml-demucs=${probe.directml_demucs_compatible} beat-this=${probe.beat_this} soxr=${probe.soxr} rotary=${probe.rotary_embedding_torch} onnxruntime=${probe.onnxruntime_installed} onnxruntime-directml=${probe.onnxruntime_directml_installed}`
    )
  }

  console.log('[demucs-runtime] Completed')
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error || 'unknown'))
  process.exit(1)
})
