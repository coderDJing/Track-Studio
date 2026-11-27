import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coverWave } from '../../../../tests/icloudCoverFixture'
import { buildListPreviewFromAudioBuffer, parseWavPcm } from './listPreviewFromAudio'
import { readIcloudWaveformPreview } from './waveformPreview'

const toneWave = () => {
  const wav = coverWave()
  // 2s of 8000Hz mono 16-bit starting at offset 44
  for (let i = 0; i < 16000; i++) {
    wav.writeInt16LE(Math.round(Math.sin((i / 8000) * 2 * Math.PI * 440) * 20000), 44 + i * 2)
  }
  return wav
}

let root: string
let cacheDir: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-wave-root-')))
  cacheDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-wave-cache-')))
  await fs.writeFile(path.join(root, 'resident.wav'), toneWave())
  await fs.writeFile(path.join(root, 'silent.wav'), coverWave())
  await fs.writeFile(path.join(root, 'cloud.wav'), toneWave())
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(cacheDir, { recursive: true, force: true })
})

describe('iCloud list waveform preview from resident audio', () => {
  it('builds a real 512-column preview from a resident WAV fixture and caches only under the local cache dir', async () => {
    const before = await fs.readdir(root)
    const open = vi.spyOn(fs, 'open')
    const data = await readIcloudWaveformPreview(
      root,
      'resident.wav',
      async () => 'local',
      undefined,
      cacheDir
    )
    expect(data?.surfaceKind).toBe('listPreview')
    expect(data?.detailPeakTop.length).toBe(512)
    expect(Math.max(...data!.detailPeakTop)).toBeGreaterThan(0)
    expect(await fs.readdir(root)).toEqual(before)
    const cached = await fs.readdir(cacheDir)
    expect(cached.some((name) => name.endsWith('.json'))).toBe(true)
    expect(open).toHaveBeenCalled()
    open.mockClear()
    const again = await readIcloudWaveformPreview(
      root,
      'resident.wav',
      async () => 'local',
      undefined,
      cacheDir
    )
    expect(again?.detailPeakTop).toEqual(data?.detailPeakTop)
    expect(open).not.toHaveBeenCalled()
  })

  it('does not open or read audio for cloud or unknown files and never writes into the cloud root', async () => {
    const open = vi.spyOn(fs, 'open')
    const before = await fs.readdir(root)
    for (const state of ['cloud', 'unknown'] as const) {
      await expect(
        readIcloudWaveformPreview(root, 'cloud.wav', async () => state, undefined, cacheDir)
      ).rejects.toThrow()
    }
    expect(open).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).toEqual(before)
    expect(await fs.readdir(cacheDir)).toEqual([])
  })

  it('rejects a cache directory inside the cloud root and ignores aborted work', async () => {
    const open = vi.spyOn(fs, 'open')
    await expect(
      readIcloudWaveformPreview(
        root,
        'resident.wav',
        async () => 'local',
        undefined,
        path.join(root, 'nested-cache')
      )
    ).rejects.toThrow('boundary')
    expect(open).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort()
    await expect(
      readIcloudWaveformPreview(
        root,
        'resident.wav',
        async () => 'local',
        undefined,
        cacheDir,
        controller.signal
      )
    ).rejects.toThrow('cancelled')
    expect(open).not.toHaveBeenCalled()
    expect(await fs.readdir(cacheDir)).toEqual([])
  })

  it('parses the silent cover fixture as a valid empty preview rather than leaking a failure', () => {
    const parsed = parseWavPcm(coverWave())
    expect(parsed?.sampleRate).toBe(8000)
    const data = buildListPreviewFromAudioBuffer(coverWave())
    expect(data?.detailPeakTop.length).toBe(512)
    expect(Math.max(...data!.detailPeakTop)).toBe(0)
  })
})
