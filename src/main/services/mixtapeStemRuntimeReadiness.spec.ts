// Run: pnpm exec vitest run src/main/services/mixtapeStemRuntimeReadiness.spec.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  candidates: vi.fn(),
  probe: vi.fn(),
  bpmSupport: vi.fn(),
  fetch: vi.fn(),
  install: vi.fn(),
  invalidate: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => '1.2.7-rc.1' } }))
vi.mock('undici', () => ({ fetch: mocks.fetch, ProxyAgent: class {} }))
vi.mock('../ffmpeg', () => ({ resolveBundledFfmpegPath: () => 'ffmpeg' }))
vi.mock('../utils', () => ({ getSystemProxy: async () => '' }))
vi.mock('../demucs', () => ({
  resolveBundledDemucsRuntimeCandidates: mocks.candidates,
  resolveBundledDemucsPlatformRootCandidates: () => [],
  resolveDemucsPlatformDir: () => 'win32-x64',
  resolveInstalledDemucsRootPath: () => '',
  resolveInstalledDemucsPlatformRootPath: () => ''
}))
vi.mock('./mixtapeStemSeparationProbe', () => ({
  probeWindowsGpuAdapters: async () => ({ hasNvidia: true, hasIntel: false, hasAmd: false }),
  probeDemucsDevices: mocks.probe,
  invalidateStemDeviceProbeCache: mocks.invalidate
}))
vi.mock('./analysisRuntimeCapabilities', () => ({
  hasAnalysisRuntimeFeatureSupport: mocks.bpmSupport,
  clearAnalysisRuntimeCapabilityCache: vi.fn()
}))
vi.mock('./mixtapeStemRuntimeDownloadInstall', () => ({
  installRuntimeFromManifestEntry: mocks.install
}))

import {
  downloadPreferredStemRuntime,
  getPreferredStemRuntimeDownloadInfo
} from './mixtapeStemRuntimeDownload'

let runtimeDir: string
let pythonPath: string
const manifest = {
  releaseTag: 'demucs-runtime-assets-rc',
  assets: [
    {
      platform: 'win32-x64',
      profile: 'cuda',
      runtimeKey: 'runtime-cuda',
      version: 'new',
      contentHash: 'new-hash',
      bpmFixReady: true,
      archiveSize: 42
    }
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.install.mockReset()
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-runtime-readiness-'))
  pythonPath = path.join(runtimeDir, 'python')
  fs.writeFileSync(pythonPath, '')
  const site =
    process.platform === 'win32'
      ? path.join(runtimeDir, 'Lib', 'site-packages')
      : path.join(runtimeDir, 'lib', 'python3.11', 'site-packages')
  fs.mkdirSync(path.join(site, 'beat_this'), { recursive: true })
  fs.mkdirSync(path.join(runtimeDir, 'beat-this-checkpoints'))
  fs.writeFileSync(path.join(runtimeDir, 'beat-this-checkpoints', 'final0.ckpt'), '')
  fs.writeFileSync(
    path.join(runtimeDir, '.frkb-runtime-meta.json'),
    JSON.stringify({ beatThisInstalled: true })
  )
  fs.writeFileSync(
    path.join(runtimeDir, '.frkb-runtime-download.json'),
    JSON.stringify({ contentHash: 'old-hash', profile: 'cuda', runtimeKey: 'runtime-cuda' })
  )
  mocks.candidates.mockReturnValue([{ key: 'runtime-cuda', pythonPath, runtimeDir }])
  mocks.probe.mockResolvedValue({
    runtimeUsable: true,
    pythonPath,
    runtimeDir,
    runtimeKey: 'runtime-cuda'
  })
  mocks.bpmSupport.mockImplementation(async (feature: string) => feature !== 'bpm-fix')
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => manifest })
})
afterEach(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))

describe('analysis runtime readiness', () => {
  it('keeps the old usable runtime for normal features without consulting the manifest', async () => {
    const result = await getPreferredStemRuntimeDownloadInfo()
    expect(result).toMatchObject({
      alreadyAvailable: true,
      downloadable: false,
      runtimeKey: 'runtime-cuda'
    })
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.bpmSupport).toHaveBeenCalledWith('analysis', pythonPath, runtimeDir)
  })

  it('uses the actual capability when old metadata incorrectly reports Beat This as absent', async () => {
    fs.writeFileSync(
      path.join(runtimeDir, '.frkb-runtime-meta.json'),
      JSON.stringify({ beatThisInstalled: false })
    )
    const result = await getPreferredStemRuntimeDownloadInfo('horizontal')
    expect(result).toMatchObject({ alreadyAvailable: true, downloadable: false })
    expect(mocks.bpmSupport).toHaveBeenCalledWith('horizontal', pythonPath, runtimeDir)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('offers the new component only when BPM repair support is missing', async () => {
    const result = await getPreferredStemRuntimeDownloadInfo('bpm-fix')
    expect(result).toMatchObject({
      alreadyAvailable: false,
      downloadable: true,
      runtimeKey: 'runtime-cuda',
      version: 'new'
    })
    expect(mocks.bpmSupport).toHaveBeenCalledWith('bpm-fix', pythonPath, runtimeDir)
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('uses an old component that already supports BPM repair', async () => {
    mocks.bpmSupport.mockResolvedValue(true)
    const result = await getPreferredStemRuntimeDownloadInfo('bpm-fix')
    expect(result).toMatchObject({ alreadyAvailable: true, downloadable: false })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('allows Stem to use a working component without Beat This files', async () => {
    const site =
      process.platform === 'win32'
        ? path.join(runtimeDir, 'Lib', 'site-packages')
        : path.join(runtimeDir, 'lib', 'python3.11', 'site-packages')
    fs.rmSync(path.join(site, 'beat_this'), { recursive: true })
    const stem = await getPreferredStemRuntimeDownloadInfo('stem')
    expect(stem).toMatchObject({ alreadyAvailable: true, downloadable: false })
    expect(mocks.bpmSupport).toHaveBeenCalledWith('stem', pythonPath, runtimeDir)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('offers an update for a missing Stem dependency without blocking horizontal mode', async () => {
    mocks.bpmSupport.mockImplementation(async (feature: string) => feature !== 'stem')
    const horizontal = await getPreferredStemRuntimeDownloadInfo('horizontal')
    const stem = await getPreferredStemRuntimeDownloadInfo('stem')
    expect(horizontal).toMatchObject({ alreadyAvailable: true, downloadable: false })
    expect(stem).toMatchObject({ alreadyAvailable: false, downloadable: true })
    expect(mocks.bpmSupport).toHaveBeenCalledWith('horizontal', pythonPath, runtimeDir)
    expect(mocks.bpmSupport).toHaveBeenCalledWith('stem', pythonPath, runtimeDir)
  })

  it('rechecks the requested capability after a different feature finishes installing', async () => {
    let stemInstalled = false
    let bpmInstalled = false
    let finishStem: () => void = () => {}
    const pendingStem = new Promise<void>((resolve) => {
      finishStem = resolve
    })
    mocks.bpmSupport.mockImplementation(async (feature: string) =>
      feature === 'stem' ? stemInstalled : feature === 'bpm-fix' ? bpmInstalled : true
    )
    mocks.install
      .mockImplementationOnce(async () => {
        await pendingStem
        stemInstalled = true
      })
      .mockImplementationOnce(async () => {
        bpmInstalled = true
      })

    const stem = downloadPreferredStemRuntime('stem')
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1))
    const bpm = downloadPreferredStemRuntime('bpm-fix')
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
    finishStem()
    expect(await stem).toBe(true)
    expect(await bpm).toBe(true)
    expect(mocks.install).toHaveBeenCalledTimes(2)
    expect(bpmInstalled).toBe(true)
  })

  it('does not report a broken component as ready even when its files exist', async () => {
    mocks.probe.mockResolvedValue({
      runtimeUsable: false,
      pythonPath,
      runtimeDir,
      runtimeKey: 'runtime-cuda'
    })
    const result = await getPreferredStemRuntimeDownloadInfo()
    expect(result).toMatchObject({ alreadyAvailable: false, downloadable: true })
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })
})
