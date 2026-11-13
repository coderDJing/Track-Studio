import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'vitest'
import {
  createDemucsBaseModelEnsurer,
  verifyDemucsBaseModelRepo,
  type DemucsBaseModelEntry,
  type DemucsBaseModelFetchResponse,
  type DemucsBaseModelManifest
} from './demucsBaseModelDownloadCore'

const temporaryRoots: string[] = []

const createRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-base-model-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

const buildEntry = (params: {
  name: 'htdemucs' | 'mdx_extra_q'
  files: Array<{ name: string; bytes: Buffer }>
}): DemucsBaseModelEntry => ({
  name: params.name,
  yaml: `models: ['${params.name === 'htdemucs' ? '955717e8' : '83fc094f'}']\n`,
  files: params.files.map((file) => ({
    name: file.name,
    url: `https://example.invalid/${params.name}/${file.name}`,
    sha256: sha256(file.bytes)
  }))
})

const buildResponse = (bytes: Buffer): DemucsBaseModelFetchResponse => ({
  ok: true,
  status: 200,
  contentLength: bytes.byteLength,
  body: Readable.from([bytes])
})

const createFetch = (files: Map<string, Buffer>) => {
  const calls: string[] = []
  return {
    calls,
    fetchAsset: async (url: string) => {
      calls.push(url)
      const bytes = files.get(url)
      if (!bytes) throw new Error(`missing fixture url: ${url}`)
      return buildResponse(bytes)
    }
  }
}

const writeEntryToRoot = (
  root: string,
  entry: DemucsBaseModelEntry,
  bytesByUrl: Map<string, Buffer>
) => {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, `${entry.name}.yaml`), entry.yaml)
  for (const file of entry.files) {
    const bytes = bytesByUrl.get(file.url)
    if (!bytes) throw new Error(`missing bytes for ${file.url}`)
    fs.writeFileSync(path.join(root, file.name), bytes)
  }
}

describe('demucs base model core', () => {
  it('downloads once, verifies yaml/weights, then reuses offline', async () => {
    const root = createRoot()
    const bytes = Buffer.from('htdemucs-weight-fixture')
    const entry = buildEntry({ name: 'htdemucs', files: [{ name: '955717e8-8726e21a.th', bytes }] })
    const files = new Map([[entry.files[0].url, bytes]])
    const fetch = createFetch(files)
    const statuses: string[] = []
    const ensure = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [entry] },
      fetchAsset: fetch.fetchAsset,
      onProgress: (progress) => statuses.push(progress.status)
    })

    const modelPath = await ensure('htdemucs')
    assert.equal(fetch.calls.length, 1)
    assert.equal(modelPath, path.join(root, 'htdemucs'))
    assert.equal(
      fs.readFileSync(path.join(modelPath, '955717e8-8726e21a.th')).toString(),
      bytes.toString()
    )
    assert.equal(fs.readFileSync(path.join(modelPath, 'htdemucs.yaml'), 'utf8'), entry.yaml)
    assert.deepEqual(await verifyDemucsBaseModelRepo(modelPath, entry), { ok: true, reason: 'ok' })
    assert.ok(statuses.includes('downloading'))
    assert.ok(statuses.includes('installing'))

    assert.equal(await ensure('htdemucs'), modelPath)
    assert.equal(fetch.calls.length, 1)
  })

  it('downloads only the selected model', async () => {
    const root = createRoot()
    const htdemucsBytes = Buffer.from('htdemucs-only')
    const mdxBytes = Buffer.from('mdx-only')
    const htdemucs = buildEntry({
      name: 'htdemucs',
      files: [{ name: '955717e8-8726e21a.th', bytes: htdemucsBytes }]
    })
    const mdx = buildEntry({
      name: 'mdx_extra_q',
      files: [{ name: '83fc094f-4a16d450.th', bytes: mdxBytes }]
    })
    const files = new Map([
      [htdemucs.files[0].url, htdemucsBytes],
      [mdx.files[0].url, mdxBytes]
    ])
    const fetch = createFetch(files)
    const ensure = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [htdemucs, mdx] },
      fetchAsset: fetch.fetchAsset
    })

    await ensure('htdemucs')
    assert.deepEqual(fetch.calls, [htdemucs.files[0].url])
    assert.equal(fs.existsSync(path.join(root, 'mdx_extra_q')), false)
  })

  it('rejects corrupted sha, does not enable it, and succeeds on retry', async () => {
    const root = createRoot()
    const bytes = Buffer.from('correct-weight')
    const entry = buildEntry({ name: 'htdemucs', files: [{ name: '955717e8-8726e21a.th', bytes }] })
    let corrupt = true
    let calls = 0
    const ensure = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [entry] },
      fetchAsset: async () => {
        calls += 1
        return buildResponse(corrupt ? Buffer.from('corrupted-weight') : bytes)
      }
    })

    await assert.rejects(ensure('htdemucs'), (error) => {
      assert.equal((error as { code?: string }).code, 'VERIFY_FAILED')
      return true
    })
    assert.equal(fs.existsSync(path.join(root, 'htdemucs')), false)
    assert.equal(calls, 1)

    corrupt = false
    const modelPath = await ensure('htdemucs')
    assert.equal(calls, 2)
    assert.deepEqual(await verifyDemucsBaseModelRepo(modelPath, entry), { ok: true, reason: 'ok' })
  })

  it('rejects a network failure without enabling the model, then retries', async () => {
    const root = createRoot()
    const bytes = Buffer.from('network-retry-weight')
    const entry = buildEntry({ name: 'htdemucs', files: [{ name: '955717e8-8726e21a.th', bytes }] })
    let fail = true
    let calls = 0
    const ensure = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [entry] },
      fetchAsset: async () => {
        calls += 1
        if (fail) throw new Error('network down')
        return buildResponse(bytes)
      }
    })

    await assert.rejects(ensure('htdemucs'), /network down/)
    assert.equal(fs.existsSync(path.join(root, 'htdemucs')), false)
    assert.equal(calls, 1)

    fail = false
    const modelPath = await ensure('htdemucs')
    assert.equal(calls, 2)
    assert.deepEqual(await verifyDemucsBaseModelRepo(modelPath, entry), { ok: true, reason: 'ok' })
  })

  it('keeps the old verified model when a replacement download fails', async () => {
    const root = createRoot()
    const oldBytes = Buffer.from('old-weight')
    const oldEntry = buildEntry({
      name: 'htdemucs',
      files: [{ name: '955717e8-8726e21a.th', bytes: oldBytes }]
    })
    const oldFetch = createFetch(new Map([[oldEntry.files[0].url, oldBytes]]))
    const installOld = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [oldEntry] },
      fetchAsset: oldFetch.fetchAsset
    })
    const oldPath = await installOld('htdemucs')

    const newBytes = Buffer.from('new-weight')
    const newEntry = buildEntry({
      name: 'htdemucs',
      files: [{ name: '955717e8-8726e21a.th', bytes: newBytes }]
    })
    const installNew = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [newEntry] },
      fetchAsset: async () => {
        throw new Error('network down')
      }
    })

    await assert.rejects(installNew('htdemucs'), /network down/)
    assert.deepEqual(await verifyDemucsBaseModelRepo(oldPath, oldEntry), { ok: true, reason: 'ok' })
  })

  it('re-downloads when the installed yaml no longer matches', async () => {
    const root = createRoot()
    const bytes = Buffer.from('yaml-weight')
    const entry = buildEntry({ name: 'htdemucs', files: [{ name: '955717e8-8726e21a.th', bytes }] })
    const fetch = createFetch(new Map([[entry.files[0].url, bytes]]))
    const ensure = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [entry] },
      fetchAsset: fetch.fetchAsset
    })
    const modelPath = await ensure('htdemucs')
    fs.writeFileSync(path.join(modelPath, 'htdemucs.yaml'), 'tampered\n')

    await ensure('htdemucs')
    assert.equal(fetch.calls.length, 2)
    assert.equal(fs.readFileSync(path.join(modelPath, 'htdemucs.yaml'), 'utf8'), entry.yaml)
  })

  it('rejects a real download stream error and cleans staging', async () => {
    const root = createRoot()
    const bytes = Buffer.from('stream-error-weight')
    const entry = buildEntry({ name: 'htdemucs', files: [{ name: '955717e8-8726e21a.th', bytes }] })
    let sentChunk = false
    const ensure = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [entry] },
      fetchAsset: async () => ({
        ok: true,
        status: 200,
        contentLength: bytes.byteLength,
        body: new Readable({
          read() {
            if (sentChunk) {
              this.destroy(new Error('ENOSPC: no space left on device'))
              return
            }
            sentChunk = true
            this.push(Buffer.from('partial-weight'))
          }
        })
      })
    })

    await assert.rejects(ensure('htdemucs'), /ENOSPC/)
    assert.equal(fs.existsSync(path.join(root, 'htdemucs')), false)
    const stagingRoot = path.join(root, '.staging')
    assert.equal(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).length : 0, 0)
  })

  it('single-flights concurrent requests for the same model', async () => {
    const root = createRoot()
    const bytes = Buffer.from('single-flight')
    const entry = buildEntry({ name: 'htdemucs', files: [{ name: '955717e8-8726e21a.th', bytes }] })
    let releaseFetch: ((value: DemucsBaseModelFetchResponse) => void) | undefined
    let markFetchStarted: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    let calls = 0
    const ensure = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [entry] },
      fetchAsset: async () => {
        calls += 1
        markFetchStarted?.()
        return await new Promise<DemucsBaseModelFetchResponse>((resolve) => {
          releaseFetch = resolve
        })
      }
    })

    const first = ensure('htdemucs')
    const second = ensure('htdemucs')
    assert.equal(first, second)
    await fetchStarted
    assert.equal(calls, 1)
    if (!releaseFetch) throw new Error('fetch did not start')
    releaseFetch(buildResponse(bytes))
    const [firstPath, secondPath] = await Promise.all([first, second])
    assert.equal(firstPath, secondPath)
    assert.equal(calls, 1)
  })

  it('keeps two models isolated', async () => {
    const root = createRoot()
    const htdemucsBytes = Buffer.from('htdemucs-parallel')
    const mdxBytes = Buffer.from('mdx-parallel')
    const htdemucs = buildEntry({
      name: 'htdemucs',
      files: [{ name: '955717e8-8726e21a.th', bytes: htdemucsBytes }]
    })
    const mdx = buildEntry({
      name: 'mdx_extra_q',
      files: [{ name: '83fc094f-4a16d450.th', bytes: mdxBytes }]
    })
    const files = new Map([
      [htdemucs.files[0].url, htdemucsBytes],
      [mdx.files[0].url, mdxBytes]
    ])
    const fetch = createFetch(files)
    const ensure = createDemucsBaseModelEnsurer({
      modelsRoot: root,
      manifest: { models: [htdemucs, mdx] },
      fetchAsset: fetch.fetchAsset
    })

    const [htdemucsPath, mdxPath] = await Promise.all([ensure('htdemucs'), ensure('mdx_extra_q')])
    assert.equal(fetch.calls.length, 2)
    assert.equal(htdemucsPath, path.join(root, 'htdemucs'))
    assert.equal(mdxPath, path.join(root, 'mdx_extra_q'))
    assert.deepEqual(await verifyDemucsBaseModelRepo(htdemucsPath, htdemucs), {
      ok: true,
      reason: 'ok'
    })
    assert.deepEqual(await verifyDemucsBaseModelRepo(mdxPath, mdx), { ok: true, reason: 'ok' })
  })

  it('reuses a verified dev vendor model without network', async () => {
    const root = createRoot()
    const vendorRoot = path.join(root, 'vendor')
    const bytes = Buffer.from('vendor-weight')
    const entry = buildEntry({ name: 'htdemucs', files: [{ name: '955717e8-8726e21a.th', bytes }] })
    const bytesByUrl = new Map([[entry.files[0].url, bytes]])
    writeEntryToRoot(vendorRoot, entry, bytesByUrl)
    let calls = 0
    const ensure = createDemucsBaseModelEnsurer({
      modelsRoot: path.join(root, 'installed'),
      vendorRoot,
      manifest: { models: [entry] },
      fetchAsset: async () => {
        calls += 1
        return buildResponse(bytes)
      }
    })

    assert.equal(await ensure('htdemucs'), vendorRoot)
    assert.equal(calls, 0)
  })
})
