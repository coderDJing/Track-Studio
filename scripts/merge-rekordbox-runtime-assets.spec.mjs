import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeRuntimeAssets } from './merge-rekordbox-runtime-assets.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-runtime-merge-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const platform of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
    const directory = path.join(root, platform)
    await fs.mkdir(directory)
    const bytes = Buffer.from(platform)
    const name = `runtime-${platform}-1.tar.gz`
    await fs.writeFile(path.join(directory, name), bytes)
    await fs.writeFile(
      path.join(directory, 'rekordbox-runtime-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        releaseTag: 'rekordbox-runtime-assets',
        assets: [
          {
            platform,
            version: '1',
            archiveName: name,
            archiveSize: bytes.length,
            archiveSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            archiveUrl: `https://github.com/coderDJing/Track-Studio/releases/download/rekordbox-runtime-assets/${name}`
          }
        ]
      })
    )
  }
  return { root, output: path.join(root, 'merged') }
}

test('publishes one complete manifest and preserves exact platform archive bytes', async (t) => {
  const { root, output } = await fixture(t)
  const manifest = await mergeRuntimeAssets(root, output)
  assert.equal(manifest.assets.length, 3)
  for (const asset of manifest.assets) {
    assert.equal(
      (await fs.readFile(path.join(output, asset.archiveName))).toString(),
      asset.platform
    )
  }
})

test('missing platform prevents publication of a partial manifest', async (t) => {
  const { root, output } = await fixture(t)
  await fs.rm(path.join(root, 'darwin-x64'), { recursive: true })
  await assert.rejects(mergeRuntimeAssets(root, output), /ENOENT/)
  await assert.rejects(fs.access(path.join(output, 'rekordbox-runtime-manifest.json')))
})

test('corrupted archive prevents publication', async (t) => {
  const { root, output } = await fixture(t)
  await fs.writeFile(path.join(root, 'win32-x64', 'runtime-win32-x64-1.tar.gz'), 'corrupt')
  await assert.rejects(mergeRuntimeAssets(root, output), /Archive identity mismatch/)
  await assert.rejects(fs.access(path.join(output, 'rekordbox-runtime-manifest.json')))
})
