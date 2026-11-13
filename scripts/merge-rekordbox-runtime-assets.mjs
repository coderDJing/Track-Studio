import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const manifestName = 'rekordbox-runtime-manifest.json'
const platforms = ['win32-x64', 'darwin-arm64', 'darwin-x64']

export async function mergeRuntimeAssets(inputRoot, outputRoot) {
  const assets = []
  for (const platform of platforms) {
    const directory = path.join(inputRoot, platform)
    const manifest = JSON.parse(await fs.readFile(path.join(directory, manifestName), 'utf8'))
    if (
      manifest.schemaVersion !== 1 ||
      manifest.releaseTag !== 'rekordbox-runtime-assets' ||
      manifest.assets?.length !== 1 ||
      manifest.assets[0].platform !== platform
    ) {
      throw new Error(`Invalid platform manifest: ${platform}`)
    }
    const asset = manifest.assets[0]
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(asset.archiveName)) {
      throw new Error(`Unsafe archive name: ${platform}`)
    }
    if (
      asset.archiveUrl !==
      `https://github.com/coderDJing/Track-Studio/releases/download/rekordbox-runtime-assets/${asset.archiveName}`
    ) {
      throw new Error(`Unexpected archive URL: ${platform}`)
    }
    const bytes = await fs.readFile(path.join(directory, asset.archiveName))
    if (
      bytes.length !== asset.archiveSize ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== asset.archiveSha256
    ) {
      throw new Error(`Archive identity mismatch: ${platform}`)
    }
    assets.push(asset)
  }
  if (new Set(assets.map((asset) => asset.version)).size !== 1) {
    throw new Error('Platform asset versions differ')
  }
  await fs.mkdir(outputRoot, { recursive: true })
  for (const asset of assets) {
    await fs.copyFile(
      path.join(inputRoot, asset.platform, asset.archiveName),
      path.join(outputRoot, asset.archiveName),
      fs.constants.COPYFILE_EXCL
    )
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releaseTag: 'rekordbox-runtime-assets',
    assets
  }
  await fs.writeFile(path.join(outputRoot, manifestName), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mergeRuntimeAssets(
    path.resolve(process.argv[2] || 'artifacts/rekordbox-runtime'),
    path.resolve(process.argv[3] || 'dist/rekordbox-runtime-release')
  ).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
