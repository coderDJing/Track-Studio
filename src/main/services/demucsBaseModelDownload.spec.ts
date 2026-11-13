import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => ''
  }
}))

vi.mock('./mixtapeStemRuntimeDownload', () => ({
  fetchDemucsAsset: vi.fn()
}))

import {
  createDemucsBaseModelService,
  resolveDemucsBaseModelComponentId
} from './demucsBaseModelDownload'
import type {
  DemucsBaseModelEntry,
  DemucsBaseModelFetchResponse
} from './demucsBaseModelDownloadCore'

const temporaryRoots: string[] = []

const createRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-base-model-service-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

const buildEntry = (
  name: 'htdemucs' | 'mdx_extra_q',
  fileName: string,
  bytes: Buffer
): DemucsBaseModelEntry => ({
  name,
  yaml: `models: ['${name === 'htdemucs' ? '955717e8' : '83fc094f'}']\n`,
  files: [
    {
      name: fileName,
      url: `https://example.invalid/${name}/${fileName}`,
      sha256: sha256(bytes)
    }
  ]
})

const response = (bytes: Buffer): DemucsBaseModelFetchResponse => ({
  ok: true,
  status: 200,
  contentLength: bytes.byteLength,
  body: Readable.from([bytes])
})

describe('demucs base model service', () => {
  it('publishes downloading/installing/ready only after the verified install', async () => {
    const root = createRoot()
    const bytes = Buffer.from('service-weight')
    const entry = buildEntry('htdemucs', '955717e8-8726e21a.th', bytes)
    const states: Array<{ id: string; status: string; error: string }> = []
    const service = createDemucsBaseModelService({
      modelsRoot: root,
      manifest: { models: [entry] },
      fetchAsset: async () => response(bytes),
      publish: (state) => {
        states.push({ id: state.id, status: state.status, error: state.error })
        if (state.status === 'ready') {
          assert.equal(fs.existsSync(path.join(root, 'htdemucs', '955717e8-8726e21a.th')), true)
          assert.equal(
            fs.readFileSync(path.join(root, 'htdemucs', 'htdemucs.yaml'), 'utf8'),
            entry.yaml
          )
        }
      }
    })

    const modelPath = await service.ensure('htdemucs')
    assert.equal(modelPath, path.join(root, 'htdemucs'))
    assert.deepEqual(
      [...new Set(states.map((state) => state.status))],
      ['downloading', 'installing', 'ready']
    )
    assert.equal(states.at(-1)?.id, 'stem-model-htdemucs')
    assert.equal(states.at(-1)?.error, '')
    const installedStateCount = states.length
    await service.ensure('htdemucs')
    assert.equal(states.length, installedStateCount, 'offline reuse must not reopen download UI')
  })

  it('publishes failed and does not enable a corrupted model; retry succeeds', async () => {
    const root = createRoot()
    const bytes = Buffer.from('service-correct')
    const entry = buildEntry('htdemucs', '955717e8-8726e21a.th', bytes)
    let corrupt = true
    const states: Array<{ status: string; error: string }> = []
    const service = createDemucsBaseModelService({
      modelsRoot: root,
      manifest: { models: [entry] },
      fetchAsset: async () => response(corrupt ? Buffer.from('service-corrupt') : bytes),
      publish: (state) => states.push({ status: state.status, error: state.error })
    })

    await assert.rejects(service.ensure('htdemucs'))
    assert.equal(fs.existsSync(path.join(root, 'htdemucs')), false)
    assert.equal(states.at(-1)?.status, 'failed')
    assert.match(states.at(-1)?.error || '', /verification failed/i)

    corrupt = false
    const modelPath = await service.ensure('htdemucs')
    assert.equal(modelPath, path.join(root, 'htdemucs'))
    assert.equal(states.at(-1)?.status, 'ready')
  })

  it('inspects installed state without any network', async () => {
    const root = createRoot()
    const bytes = Buffer.from('inspect-weight')
    const entry = buildEntry('htdemucs', '955717e8-8726e21a.th', bytes)
    let calls = 0
    const service = createDemucsBaseModelService({
      modelsRoot: root,
      manifest: { models: [entry] },
      fetchAsset: async () => {
        calls += 1
        return response(bytes)
      }
    })

    assert.deepEqual(await service.inspect('htdemucs'), {
      available: false,
      path: path.join(root, 'htdemucs'),
      source: 'none',
      reason: 'yaml-missing'
    })
    assert.equal(calls, 0)

    await service.ensure('htdemucs')
    calls = 0
    const inspected = await service.inspect('htdemucs')
    assert.equal(inspected.available, true)
    assert.equal(inspected.source, 'installed')
    assert.equal(calls, 0)
  })

  it('publishes the selected model component only', async () => {
    const root = createRoot()
    const htdemucsBytes = Buffer.from('htdemucs-service')
    const mdxBytes = Buffer.from('mdx-service')
    const htdemucs = buildEntry('htdemucs', '955717e8-8726e21a.th', htdemucsBytes)
    const mdx = buildEntry('mdx_extra_q', '83fc094f-4a16d450.th', mdxBytes)
    const fetchAsset = vi.fn(async (url: string) => {
      if (url === htdemucs.files[0].url) return response(htdemucsBytes)
      if (url === mdx.files[0].url) return response(mdxBytes)
      throw new Error(`unexpected url: ${url}`)
    })
    const ids: string[] = []
    const service = createDemucsBaseModelService({
      modelsRoot: root,
      manifest: { models: [htdemucs, mdx] },
      fetchAsset,
      publish: (state) => ids.push(state.id)
    })

    await service.ensure('mdx_extra_q')
    assert.equal(fetchAsset.mock.calls.length, 1)
    assert.equal(fetchAsset.mock.calls[0][0], mdx.files[0].url)
    assert.deepEqual([...new Set(ids)], ['stem-model-mdx_extra_q'])
    assert.equal(fs.existsSync(path.join(root, 'htdemucs')), false)
    assert.equal(resolveDemucsBaseModelComponentId('htdemucs'), 'stem-model-htdemucs')
  })
})
