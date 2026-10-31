import 'dotenv/config'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

const sanitizeInstanceId = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

const resolveDefaultRendererPort = (instanceId) => {
  if (!instanceId) return ''
  if (/^\d+$/.test(instanceId)) {
    return String(5173 + Number(instanceId))
  }
  if (instanceId === 'a') return '5173'
  if (instanceId === 'b') return '5174'
  const hash = [...instanceId].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return String(5200 + (hash % 200))
}

const probePortOnHost = (port, host) =>
  new Promise((resolve) => {
    const server = net.createServer()
    server.unref()

    server.once('error', (error) => {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
      if (code === 'EADDRINUSE') {
        resolve(false)
        return
      }
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
        resolve(true)
        return
      }
      resolve(false)
    })

    server.once('listening', () => {
      server.close(() => resolve(true))
    })

    server.listen({
      port,
      host,
      exclusive: true
    })
  })

const isRendererPortAvailable = async (port) => {
  const parsedPort = Number.parseInt(String(port || '').trim(), 10)
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) return true

  const [ipv4Available, ipv6Available] = await Promise.all([
    probePortOnHost(parsedPort, '127.0.0.1'),
    probePortOnHost(parsedPort, '::1')
  ])

  return ipv4Available && ipv6Available
}

const exitWithRendererPortConflict = (port, env) => {
  void env
  console.error(
    `[frkb-dev] Development port ${port} is already in use. Stop the process using it, or change FRKB_DEV_SERVER_PORT in .env and try again.`
  )
  process.exit(1)
}

const printRendererPortConflictHint = (port, env) => {
  void env
  console.error(
    `\n[frkb-dev] Development port ${port} is already in use. Stop the process using it, or change FRKB_DEV_SERVER_PORT in .env and try again.`
  )
}

const args = process.argv.slice(2)
const releaseRuntime = args.includes('--release-runtime')
const noRuntime = args.includes('--no-runtime')
const preflightOnly = args.includes('--preflight-only')
const forwardedArgs = args.filter(
  (arg) => arg !== '--release-runtime' && arg !== '--no-runtime' && arg !== '--preflight-only'
)

const releaseRuntimeRoot = 'vendor/demucs-release'
const env = {
  ...process.env
}
const devInstanceId = sanitizeInstanceId(env.FRKB_DEV_INSTANCE || '')
const rendererPort = String(
  env.FRKB_DEV_SERVER_PORT || resolveDefaultRendererPort(devInstanceId)
).trim()

if (devInstanceId) {
  env.FRKB_DEV_INSTANCE = devInstanceId
}
if (rendererPort) {
  env.FRKB_DEV_SERVER_PORT = rendererPort
}
if (noRuntime) {
  env.FRKB_SKIP_DEMUCS_RUNTIME_ENSURE = '1'
  env.FRKB_IGNORE_BUNDLED_DEMUCS_RUNTIME = '1'
  env.FRKB_IGNORE_DEV_BEAT_THIS_RUNTIME = '1'
}
if (rendererPort && !(await isRendererPortAvailable(rendererPort))) {
  exitWithRendererPortConflict(rendererPort, env)
}

const rustPackageEnsureArgs = [
  path.resolve('./scripts/ensure-rust-package-native.mjs'),
  '--mode',
  'dev'
]
const rustPackageEnsureResult = spawnSync(process.execPath, rustPackageEnsureArgs, {
  stdio: 'inherit',
  windowsHide: false,
  env
})

if ((rustPackageEnsureResult.status ?? 1) !== 0) {
  process.exit(rustPackageEnsureResult.status ?? 1)
}

const mediaToolsEnsureArgs = [
  path.resolve('./scripts/ensure-bundled-media-tools.mjs'),
  '--mode',
  'dev'
]
const mediaToolsEnsureResult = spawnSync(process.execPath, mediaToolsEnsureArgs, {
  stdio: 'inherit',
  windowsHide: false,
  env
})

if ((mediaToolsEnsureResult.status ?? 1) !== 0) {
  process.exit(mediaToolsEnsureResult.status ?? 1)
}

const rekordboxEnsureArgs = [path.resolve('./scripts/ensure-rekordbox-desktop-runtime.mjs')]
const rekordboxEnsureResult = spawnSync(process.execPath, rekordboxEnsureArgs, {
  stdio: 'inherit',
  windowsHide: false,
  env
})

if ((rekordboxEnsureResult.status ?? 1) !== 0) {
  process.exit(rekordboxEnsureResult.status ?? 1)
}

const ensureArgs = [path.resolve('./scripts/ensure-demucs-runtime.mjs')]
if (!releaseRuntime) ensureArgs.push('--dev')
if (releaseRuntime) {
  env.FRKB_DEMUCS_ROOT = releaseRuntimeRoot
  ensureArgs.push(
    '--runtime-root',
    releaseRuntimeRoot,
    '--prefer-remote-assets',
    '--sync-remote-assets',
    '--strict'
  )
}

const ensureResult = spawnSync(process.execPath, ensureArgs, {
  stdio: 'inherit',
  windowsHide: false,
  env
})

if ((ensureResult.status ?? 1) !== 0) {
  process.exit(ensureResult.status ?? 1)
}

const electronBuilderCliPath = path.resolve('./node_modules/electron-builder/out/cli/cli.js')
const nativeDepsResult = spawnSync(process.execPath, [electronBuilderCliPath, 'install-app-deps'], {
  stdio: 'inherit',
  windowsHide: false,
  env
})

if ((nativeDepsResult.status ?? 1) !== 0) {
  process.exit(nativeDepsResult.status ?? 1)
}

if (preflightOnly) {
  console.log('[frkb-dev] preflight complete')
  process.exit(0)
}

const electronViteCliPath = path.resolve('./node_modules/electron-vite/bin/electron-vite.js')
if (devInstanceId || env.FRKB_DEV_USER_DATA_DIR || env.FRKB_DEV_DATABASE_URL || rendererPort) {
  const segments = ['[frkb-dev]']
  if (devInstanceId) segments.push(`instance=${devInstanceId}`)
  if (env.FRKB_DEV_USER_DATA_DIR) segments.push(`userData=${env.FRKB_DEV_USER_DATA_DIR}`)
  if (env.FRKB_DEV_DATABASE_URL) segments.push(`database=${env.FRKB_DEV_DATABASE_URL}`)
  if (rendererPort) segments.push(`rendererPort=${rendererPort}`)
  if (noRuntime) segments.push('analysisRuntime=not-installed-simulation')
  console.log(segments.join(' '))
}
const child = spawn(process.execPath, [electronViteCliPath, 'dev', ...forwardedArgs], {
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: false,
  env
})

let childStderr = ''
child.stdout?.on('data', (chunk) => {
  process.stdout.write(chunk)
})
child.stderr?.on('data', (chunk) => {
  const text = typeof chunk === 'string' ? chunk : chunk.toString()
  childStderr += text
  process.stderr.write(chunk)
})

child.once('error', (error) => {
  console.error(
    `[frkb-dev] Failed to start electron-vite dev: ${
      error instanceof Error ? error.message : String(error || 'unknown')
    }`
  )
  process.exit(1)
})

child.once('exit', (code, signal) => {
  const portConflictMatch = childStderr.match(/Port (\d+) is already in use/i)
  if (portConflictMatch) {
    printRendererPortConflictHint(portConflictMatch[1], env)
  }
  if (typeof code === 'number') {
    process.exit(code)
  }
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(0)
})
