import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyOptionalComponentPackaging } from './verify-optional-component-packaging.mjs'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const asar = appBuilderRequire('@electron/asar')

test('accepts application resources and small bundled Python bridges', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-packaging-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'rekordboxDesktopLibrary'), { recursive: true })
  await fs.writeFile(path.join(root, 'rekordboxDesktopLibrary', 'bridge.py'), '# bridge')
  verifyOptionalComponentPackaging(root)
})

for (const payload of [
  'demucs/models',
  'rekordboxDesktopRuntime',
  'vendor/rekordbox-desktop-runtime'
]) {
  test(`rejects loose optional payload ${payload}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-packaging-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    await fs.mkdir(path.join(root, payload), { recursive: true })
    assert.throws(() => verifyOptionalComponentPackaging(root), /Optional payloads were bundled/)
  })
}

test('rejects weights accidentally included inside app.asar', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-packaging-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input')
  const resources = path.join(root, 'resources')
  await fs.mkdir(path.join(input, 'vendor', 'demucs', 'models'), { recursive: true })
  await fs.mkdir(resources)
  await fs.writeFile(path.join(input, 'vendor', 'demucs', 'models', 'model.th'), 'weights')
  await asar.createPackage(input, path.join(resources, 'app.asar'))
  assert.throws(() => verifyOptionalComponentPackaging(resources), /app.asar/)
})
