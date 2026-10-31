import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fetchWithRuntimeProxy, readJsonFileIfExists } from './demucs-runtime-support.mjs'

const CHECKPOINT_PATH = 'beat-this-checkpoints/final0.ckpt'
const CHECKPOINT_URL = 'https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt'
const CHECKPOINT_SHA256 = '8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331'
const CORE_PACKAGES = new Set([
  'torch',
  'torchaudio',
  'demucs',
  'numpy',
  'onnxruntime',
  'onnxruntime-directml',
  'torch-directml'
])

// CPU remains explicitly selectable. Normal development prepares one hardware profile.
export const selectDevRuntimeProfiles = (detectedProfiles) => {
  const accelerator = ['cuda', 'xpu', 'directml', 'mps'].find((name) =>
    detectedProfiles.includes(name)
  )
  return [accelerator || 'cpu']
}

export const collectRuntimeRequirements = (...argumentLists) => {
  const requirements = new Map()
  for (const args of argumentLists) {
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]
      if (argument.startsWith('--')) {
        if (!argument.includes('=')) index += 1
        continue
      }
      const name = argument
        .match(/^([a-zA-Z0-9_.-]+)/)?.[1]
        ?.toLowerCase()
        .replace(/_/g, '-')
      if (!name) throw new Error(`Unsupported runtime requirement: ${argument}`)
      requirements.set(name, argument)
    }
  }
  return [...requirements.values()]
}

const requirementProbeScript = [
  'import json, sys, importlib.metadata as metadata',
  'from pip._vendor.packaging.requirements import Requirement',
  'missing = []',
  'constraints = []',
  'for text in json.loads(sys.argv[1]):',
  '    req = Requirement(text)',
  '    if req.marker and not req.marker.evaluate(): continue',
  '    try:',
  '        version = metadata.version(req.name)',
  '        constraints.append(req.name + "==" + version)',
  '        if version not in req.specifier: missing.append({"name": req.name, "requirement": text})',
  '    except metadata.PackageNotFoundError:',
  '        missing.append({"name": req.name, "requirement": text})',
  'print(json.dumps({"missing": missing, "constraints": constraints}))'
].join('\n')

// pip has no Windows system/PAC integration. Resolve the system route before running it.
export const resolveRuntimePipProxy = (
  runQuiet,
  env = process.env,
  platform = process.platform
) => {
  const configured =
    env.PIP_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
  if (configured) return configured
  if (platform !== 'win32') return ''
  const result = runQuiet(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '$ErrorActionPreference = "Stop"; $target = [Uri]"https://pypi.org/simple/"; ' +
        '$proxy = [System.Net.WebRequest]::GetSystemWebProxy(); ' +
        'if (-not $proxy.IsBypassed($target)) { $proxy.GetProxy($target).AbsoluteUri }'
    ],
    { timeout: 15000 }
  )
  if (result.status !== 0)
    throw new Error('Unable to resolve the system proxy for runtime dependencies')
  return String(result.stdout || '').trim()
}

const ensureCheckpoint = async (runtimeDir, install) => {
  const checkpointPath = path.join(runtimeDir, CHECKPOINT_PATH)
  if (fs.existsSync(checkpointPath)) {
    const hash = createHash('sha256').update(fs.readFileSync(checkpointPath)).digest('hex')
    if (hash === CHECKPOINT_SHA256) return
  }
  if (!install) throw new Error('Beat This checkpoint is missing or invalid')
  console.log('[demucs-runtime-ensure] Downloading missing/invalid Beat This checkpoint')
  const response = await fetchWithRuntimeProxy(CHECKPOINT_URL, {
    signal: AbortSignal.timeout(120000)
  })
  if (!response.ok) throw new Error(`Checkpoint download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== CHECKPOINT_SHA256) {
    throw new Error('Beat This checkpoint SHA-256 mismatch')
  }
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true })
  fs.writeFileSync(checkpointPath, bytes)
}

export const tryReuseDemucsDevRuntime = async ({
  profileName,
  runtimeDir,
  pythonPath,
  platform,
  basePipInstallArgs,
  pipInstallArgs,
  install,
  pipTimeoutSec,
  validateRuntimePortability,
  probeModules,
  buildRuntimeEnv,
  runQuiet,
  run,
  resolvePipProxy = () => resolveRuntimePipProxy(runQuiet),
  prepareCheckpoint = ensureCheckpoint
}) => {
  if (!fs.existsSync(pythonPath)) return false
  validateRuntimePortability({
    runtimeDir,
    pythonPath,
    label: `Development runtime (${profileName})`
  })
  let probe = probeModules()
  if (!probe.ok) throw new Error(`Runtime module inspection failed: ${probe.error || 'unknown'}`)
  if (!probe.payload?.torch || !probe.payload?.torchaudio || !probe.payload?.demucs) {
    return false
  }
  if (
    (profileName === 'cuda' && !/\+cu\d+/i.test(probe.payload.torch_version || '')) ||
    (profileName === 'xpu' && !probe.payload.xpu_backend) ||
    (profileName === 'directml' && !probe.payload.torch_directml)
  ) {
    return false
  }
  const requirements = collectRuntimeRequirements(basePipInstallArgs, pipInstallArgs)
  const result = runQuiet(
    pythonPath,
    ['-c', requirementProbeScript, JSON.stringify(requirements)],
    {
      env: buildRuntimeEnv(runtimeDir),
      timeout: 60000
    }
  )
  if (result.status !== 0) {
    throw new Error(
      `Runtime dependency inspection failed: ${String(result.stderr || result.stdout)}`
    )
  }
  const { missing, constraints } = JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1))
  // A core version change needs the full preparation path, never a CPU torch wheel over CUDA.
  if (missing.some(({ name }) => CORE_PACKAGES.has(name.toLowerCase().replace(/_/g, '-')))) {
    return false
  }
  const packages = new Set(missing.map(({ requirement }) => requirement))
  for (const [key, requirement] of [
    [
      'beat_this',
      pipInstallArgs.find((item) => item.startsWith('beat-this')) || 'beat-this==1.1.0'
    ],
    ['librosa', pipInstallArgs.find((item) => item.startsWith('librosa')) || 'librosa==0.11.0'],
    ['soxr', 'soxr'],
    ['rotary_embedding_torch', 'rotary-embedding-torch']
  ]) {
    if (!probe.payload[key]) packages.add(requirement)
  }
  if (packages.size > 0) {
    if (!install) throw new Error(`Missing runtime dependencies: ${[...packages].join(', ')}`)
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-runtime-deps-'))
    const constraintsPath = path.join(tempDir, 'constraints.txt')
    // Preserve the installed core (including +cu121), while allowing auxiliary packages to update.
    const repairedNames = new Set(
      [...packages].map((item) => item.match(/^[\w.-]+/)[0].toLowerCase())
    )
    fs.writeFileSync(
      constraintsPath,
      constraints
        .filter((item) => !repairedNames.has(item.split('==')[0].toLowerCase()))
        .join('\n') + '\n'
    )
    try {
      const proxy = resolvePipProxy()
      console.log(
        `[demucs-runtime-ensure] Updating ${profileName} dependencies in place: ${[...packages].join(', ')}`
      )
      run(
        pythonPath,
        [
          '-m',
          'pip',
          'install',
          '--timeout',
          String(pipTimeoutSec),
          '--constraint',
          constraintsPath,
          ...packages
        ],
        { env: { ...buildRuntimeEnv(runtimeDir), ...(proxy ? { PIP_PROXY: proxy } : {}) } }
      )
    } finally {
      fs.unlinkSync(constraintsPath)
      fs.rmdirSync(tempDir)
    }
    probe = probeModules()
  }
  if (
    !probe.ok ||
    ![
      'torch',
      'torchaudio',
      'demucs',
      'beat_this',
      'librosa',
      'soxr',
      'rotary_embedding_torch'
    ].every((key) => probe.payload?.[key])
  ) {
    throw new Error(
      `Runtime dependencies still unavailable after repair (${profileName}): ${JSON.stringify(probe)}`
    )
  }
  await prepareCheckpoint(runtimeDir, install)
  const metadataPath = path.join(runtimeDir, '.frkb-runtime-meta.json')
  const metadata = readJsonFileIfExists(metadataPath) || {}
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        ...metadata,
        runtimeKey: profileName,
        platform,
        generatedAt: new Date().toISOString(),
        installExecuted: install,
        basePipInstallArgs,
        pipInstallArgs,
        torchVersion: probe.payload.torch_version,
        beatThisInstalled: true,
        beatThisVersion: probe.payload.beat_this_version,
        librosaInstalled: true,
        soxrInstalled: true,
        rotaryEmbeddingTorchInstalled: true,
        beatThisCheckpointRelativePath: CHECKPOINT_PATH,
        beatThisCheckpointUrl: CHECKPOINT_URL,
        beatThisCheckpointSha256: CHECKPOINT_SHA256,
        probe: { ...metadata.probe, ...probe.payload }
      },
      null,
      2
    ) + '\n'
  )
  console.log(`[demucs-runtime-ensure] Reusing ${profileName}: ${runtimeDir}`)
  return true
}
