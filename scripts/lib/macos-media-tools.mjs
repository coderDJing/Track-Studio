import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

// Fixed static release and publisher SHA-256 values, never a Homebrew executable.
// https://ffmpeg.martin-riedl.de/info/detail/macos/arm64/1789931890_9.0.2
export const MACOS_MEDIA_RELEASE = '9.0.2'
export const MACOS_MEDIA_MIN_VERSION = '12.0'
export const MACOS_MEDIA_ASSETS = [
  {
    tool: 'ffmpeg',
    arch: 'arm64',
    build: '1789931890_9.0.2',
    archiveSha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924'
  },
  {
    tool: 'ffprobe',
    arch: 'arm64',
    build: '1789931890_9.0.2',
    archiveSha256: 'fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6'
  },
  {
    tool: 'ffmpeg',
    arch: 'x64',
    build: '1789931006_9.0.2',
    archiveSha256: '7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4'
  },
  {
    tool: 'ffprobe',
    arch: 'x64',
    build: '1789931006_9.0.2',
    archiveSha256: '2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd'
  }
]
const machoArch = (arch) => (arch === 'x64' ? 'x86_64' : arch)
const runTool = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command}: ${result.error?.message || result.stderr || `exit ${result.status}`}`
    )
  }
  return result.stdout
}
const newerThan = (value, limit) => {
  const a = value.split('.').map(Number)
  const b = limit.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

export const inspectMacosLoadCommands = (output, minimumVersion = MACOS_MEDIA_MIN_VERSION) => {
  const failures = []
  let deploymentVersion = ''
  for (const block of output.split(/Load command \d+/).slice(1)) {
    if (
      /\bcmd LC_(?:LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LAZY_LOAD_DYLIB|LOAD_UPWARD_DYLIB)\b/.test(
        block
      )
    ) {
      const dependency = block.match(/^\s*name (.+?) \(offset \d+\)/m)?.[1]
      if (!dependency || !/^\/(?:usr\/lib|System\/Library)\//.test(dependency)) {
        failures.push(`external dynamic library: ${dependency || '<unreadable>'}`)
      }
    }
    if (/\bcmd LC_BUILD_VERSION\b/.test(block)) {
      if (!/^\s*platform (?:1|macos)\s*$/m.test(block)) failures.push('not a macOS binary')
      deploymentVersion = block.match(/^\s*minos ([\d.]+)/m)?.[1] || ''
    } else if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(block)) {
      deploymentVersion = block.match(/^\s*version ([\d.]+)/m)?.[1] || ''
    }
  }
  if (!deploymentVersion) failures.push('missing macOS deployment target')
  else if (newerThan(deploymentVersion, minimumVersion)) {
    failures.push(`requires macOS ${deploymentVersion}, supported minimum is ${minimumVersion}`)
  }
  return failures
}

export const validateMacosMediaTool = (filePath, architectures, run = runTool) => {
  try {
    const actual = run('lipo', ['-archs', filePath]).trim().split(/\s+/)
    const failures = []
    for (const arch of architectures.map(machoArch)) {
      if (!actual.includes(arch)) {
        failures.push(`${filePath}: missing ${arch} slice`)
        continue
      }
      const commands = run('otool', ['-arch', arch, '-l', filePath])
      failures.push(
        ...inspectMacosLoadCommands(commands).map((error) => `${filePath} (${arch}): ${error}`)
      )
    }
    // Execute only the native slice; Intel slices are inspected without requiring Rosetta.
    if (!failures.length && actual.includes(machoArch(process.arch))) {
      run('/usr/bin/arch', [`-${machoArch(process.arch)}`, filePath, '-version'])
    }
    return failures
  } catch (error) {
    return [`${filePath}: ${error.message}`]
  }
}

export const verifyMacosMediaHash = (bytes, expected, label) => {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error(`[media-tools] SHA-256 mismatch: ${label}`)
}

export const ensureMacosFfmpeg = async ({ mode, platformKey, vendorRoot, downloadFile }) => {
  if (process.platform !== 'darwin')
    throw new Error('[media-tools] macOS preparation requires macOS')
  const architectures =
    mode === 'package' || platformKey === 'darwin-universal'
      ? ['arm64', 'x64']
      : [platformKey === 'darwin-arm64' ? 'arm64' : 'x64']
  const cacheDir = path.join(
    vendorRoot,
    '.downloads',
    'media-tools',
    'ffmpeg-macos',
    MACOS_MEDIA_RELEASE
  )
  await fs.promises.mkdir(cacheDir, { recursive: true })
  for (const asset of MACOS_MEDIA_ASSETS.filter((entry) => architectures.includes(entry.arch))) {
    const name = `${asset.tool}-darwin-${asset.arch}`
    const archive = path.join(cacheDir, `${name}.zip`)
    await downloadFile({
      url: `https://ffmpeg.martin-riedl.de/download/macos/${asset.arch === 'x64' ? 'amd64' : 'arm64'}/${asset.build}/${asset.tool}.zip`,
      targetPath: archive,
      label: name
    })
    const compressed = await fs.promises.readFile(archive)
    verifyMacosMediaHash(compressed, asset.archiveSha256, archive)
    const extracted = spawnSync('unzip', ['-p', archive, asset.tool], {
      maxBuffer: 256 * 1024 * 1024
    })
    if (extracted.error || extracted.status !== 0 || !extracted.stdout.length) {
      throw new Error(`[media-tools] Invalid archive: ${archive}`)
    }
    const bytes = extracted.stdout
    await fs.promises.writeFile(path.join(cacheDir, name), bytes, { mode: 0o755 })
    const failures = validateMacosMediaTool(path.join(cacheDir, name), [asset.arch])
    if (failures.length) throw new Error(failures.join('\n'))
  }
  const destination = path.join(
    vendorRoot,
    'ffmpeg',
    architectures.length === 2 ? 'darwin' : platformKey
  )
  await fs.promises.mkdir(destination, { recursive: true })
  const staging = await fs.promises.mkdtemp(path.join(cacheDir, 'staging-'))
  try {
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const output = path.join(staging, tool)
      const inputs = architectures.map((arch) => path.join(cacheDir, `${tool}-darwin-${arch}`))
      if (inputs.length === 2) runTool('lipo', ['-create', ...inputs, '-output', output])
      else await fs.promises.copyFile(inputs[0], output)
      await fs.promises.chmod(output, 0o755)
      runTool('codesign', ['--force', '--sign', '-', output])
      const failures = validateMacosMediaTool(output, architectures)
      if (failures.length) throw new Error(failures.join('\n'))
    }
    for (const tool of ['ffmpeg', 'ffprobe']) {
      await fs.promises.copyFile(path.join(staging, tool), path.join(destination, tool))
      await fs.promises.chmod(path.join(destination, tool), 0o755)
    }
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true })
  }
  return true
}
