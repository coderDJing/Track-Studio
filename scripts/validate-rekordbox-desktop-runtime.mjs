import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)

const getArgValues = (flag) => {
  const values = []
  const directPrefix = `${flag}=`
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '').trim()
    if (!arg) continue
    if (arg.startsWith(directPrefix)) {
      const value = arg.slice(directPrefix.length).trim()
      if (value) values.push(value)
      continue
    }
    if (arg !== flag) continue
    const next = String(args[index + 1] || '').trim()
    if (next) values.push(next)
  }
  return values
}

const CURRENT_PLATFORM_KEY = (() => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return ''
})()

const runtimeRootValues = getArgValues('--runtime-root')
const runtimeRoot = path.resolve(runtimeRootValues[0] || 'vendor/rekordbox-desktop-runtime')
const requiredPyrekordboxVersion = fs
  .readFileSync(path.resolve('scripts/rekordbox-desktop-runtime-requirements.txt'), 'utf8')
  .match(/^pyrekordbox==([^\s]+)\s*$/m)?.[1]
if (!requiredPyrekordboxVersion) throw new Error('Missing pinned pyrekordbox runtime version')
const requestedPlatformKeys = Array.from(new Set(getArgValues('--platform-key').filter(Boolean)))
const platformKeys =
  requestedPlatformKeys.length > 0 ? requestedPlatformKeys : [CURRENT_PLATFORM_KEY]

const supportedPlatformKeySet = new Set(['win32-x64', 'darwin-arm64', 'darwin-x64'])

const resolveRuntimePythonPath = (platformKey) => {
  const runtimeDir = path.join(runtimeRoot, platformKey, 'python')
  if (platformKey === 'win32-x64') {
    return {
      runtimeDir,
      pythonPath: path.join(runtimeDir, 'python.exe')
    }
  }
  return {
    runtimeDir,
    pythonPath: path.join(runtimeDir, 'bin', 'python3')
  }
}

const resolveBridgePath = () =>
  path.resolve(path.join('resources', 'rekordboxDesktopLibrary', 'bridge.py'))

const runQuiet = (command, commandArgs, options = {}) =>
  spawnSync(command, commandArgs, {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  })

const validateRuntime = (platformKey) => {
  if (!supportedPlatformKeySet.has(platformKey)) {
    throw new Error(`[rekordbox-runtime] Unsupported platform key: ${platformKey}`)
  }

  const { runtimeDir, pythonPath } = resolveRuntimePythonPath(platformKey)
  if (!fs.existsSync(runtimeDir)) {
    throw new Error(`[rekordbox-runtime] Runtime directory missing: ${runtimeDir}`)
  }
  if (!fs.existsSync(pythonPath)) {
    throw new Error(`[rekordbox-runtime] Runtime python missing: ${pythonPath}`)
  }

  const probe = runQuiet(
    pythonPath,
    [
      '-c',
      [
        'import json',
        'import sys',
        'import pyrekordbox',
        'from pyrekordbox import MasterDatabase',
        'from pyrekordbox.masterdb import models',
        'import sqlalchemy',
        'import sqlcipher3',
        'print(json.dumps({',
        '  "executable": sys.executable,',
        '  "prefix": sys.prefix,',
        '  "base_prefix": sys.base_prefix,',
        '  "pyrekordbox": getattr(pyrekordbox, "__version__", ""),',
        '  "sqlcipher3": hasattr(sqlcipher3, "connect")',
        '}))'
      ].join('\n')
    ],
    {
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONNOUSERSITE: '1'
      }
    }
  )

  if ((probe.status ?? 1) !== 0) {
    throw new Error(
      `[rekordbox-runtime] Runtime import probe failed for ${platformKey}: ${String(
        probe.stderr || probe.stdout || ''
      ).trim()}`
    )
  }

  let parsed = {}
  try {
    parsed = JSON.parse(String(probe.stdout || '{}'))
  } catch (error) {
    throw new Error(
      `[rekordbox-runtime] Runtime probe returned invalid JSON for ${platformKey}: ${
        error instanceof Error ? error.message : String(error || '')
      }`
    )
  }

  const normalizedRuntimeDir = fs.realpathSync(runtimeDir)
  if (parsed.pyrekordbox !== requiredPyrekordboxVersion) {
    throw new Error(
      `[rekordbox-runtime] Version mismatch for ${platformKey}: ${parsed.pyrekordbox} expected=${requiredPyrekordboxVersion}`
    )
  }
  const prefix = fs.realpathSync(String(parsed.prefix || '').trim())
  const basePrefix = fs.realpathSync(String(parsed.base_prefix || '').trim())
  if (prefix !== normalizedRuntimeDir || basePrefix !== normalizedRuntimeDir) {
    throw new Error(
      `[rekordbox-runtime] Runtime prefix is not portable for ${platformKey}: prefix=${prefix} base_prefix=${basePrefix} expected=${normalizedRuntimeDir}`
    )
  }

  console.log(
    `[rekordbox-runtime] Validated ${platformKey}: ${String(parsed.pyrekordbox || '')} @ ${String(
      parsed.executable || ''
    ).trim()}`
  )
}

if (!CURRENT_PLATFORM_KEY && platformKeys.length === 1 && !platformKeys[0]) {
  console.log('[rekordbox-runtime] Skip unsupported platform')
  process.exit(0)
}

const bridgePath = resolveBridgePath()
if (!fs.existsSync(bridgePath)) {
  throw new Error(`[rekordbox-runtime] Bridge script missing: ${bridgePath}`)
}

for (const platformKey of platformKeys.filter(Boolean)) {
  validateRuntime(platformKey)
}

console.log('[rekordbox-runtime] Validation complete')
