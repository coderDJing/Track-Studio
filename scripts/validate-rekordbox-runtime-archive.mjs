import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const assetRoot = path.resolve(process.argv[2] || 'dist/rekordbox-runtime')
const platform = process.argv[3]
if (!['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(platform)) {
  throw new Error('A supported platform key is required')
}
const manifest = JSON.parse(
  fs.readFileSync(path.join(assetRoot, 'rekordbox-runtime-manifest.json'), 'utf8')
)
const asset = manifest.assets.find((item) => item.platform === platform)
if (!asset || path.basename(asset.archiveName) !== asset.archiveName) {
  throw new Error('Missing or unsafe archive entry')
}
const archivePath = path.join(assetRoot, asset.archiveName)
const sha256 = (filePath) =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
if (
  fs.statSync(archivePath).size !== asset.archiveSize ||
  sha256(archivePath) !== asset.archiveSha256
) {
  throw new Error('Archive identity mismatch')
}

const temporaryParent = path.resolve(os.tmpdir())
const extractedRoot = fs.mkdtempSync(path.join(temporaryParent, 'frkb-runtime-roundtrip-'))
if (!path.resolve(extractedRoot).startsWith(`${temporaryParent}${path.sep}`)) {
  throw new Error('Temporary directory escaped its parent')
}
const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
    timeout: 240_000,
    env: { ...process.env, PYTHONHOME: '', PYTHONPATH: '', PYTHONNOUSERSITE: '1' }
  })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.error}`)
}
try {
  run('tar', ['-xzf', archivePath, '-C', extractedRoot])
  for (const file of asset.files) {
    const resolved = path.resolve(extractedRoot, platform, file.path)
    if (!resolved.startsWith(`${path.resolve(extractedRoot, platform)}${path.sep}`)) {
      throw new Error('Sentinel escaped platform root')
    }
    if (fs.statSync(resolved).size !== file.size || sha256(resolved) !== file.sha256) {
      throw new Error(`Extracted sentinel mismatch: ${file.path}`)
    }
  }
  run(process.execPath, [
    'scripts/validate-rekordbox-desktop-runtime.mjs',
    '--runtime-root',
    extractedRoot,
    '--platform-key',
    platform
  ])
  console.log(`Validated relocated runtime archive: ${platform}`)
} finally {
  fs.rmSync(extractedRoot, { recursive: true, force: true })
}
