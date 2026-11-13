import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeAudioFile } from './audioProbe'

const mocks = vi.hoisted(() => ({ existsSync: vi.fn(), execFile: vi.fn() }))

vi.mock('electron', () => {
  throw new Error('audioProbe must be loadable without Electron in a worker')
})
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.execFile }) }
})

describe('worker-safe audio metadata probe', () => {
  beforeEach(() => {
    vi.stubEnv('FRKB_FFMPEG_PATH', '')
    mocks.existsSync.mockReset()
    mocks.execFile.mockReset()
  })

  afterEach(() => vi.unstubAllEnvs())

  it('uses the bundled tool directory passed by main, including paths with spaces', async () => {
    const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
    const toolDir = path.resolve('test tools', 'ffmpeg')
    vi.stubEnv('FRKB_FFMPEG_PATH', path.join(toolDir, ffmpegName))
    mocks.existsSync.mockReturnValue(true)
    mocks.execFile.mockResolvedValue({
      stdout: JSON.stringify({
        format: { duration: '132.5', bit_rate: '320000' },
        streams: [{ codec_name: 'mp3', sample_rate: '44100', channels: 2 }]
      })
    })
    await expect(probeAudioFile('test track.mp3')).resolves.toEqual({
      durationSec: 132.5,
      bitRate: 320000,
      sampleRate: 44100,
      channels: 2,
      codec: 'mp3'
    })
    expect(mocks.execFile).toHaveBeenCalledWith(
      path.join(toolDir, ffprobeName),
      expect.arrayContaining(['test track.mp3']),
      expect.objectContaining({ windowsHide: true, timeout: expect.any(Number) })
    )
  })

  it('reports missing main-process tool configuration without searching the system', async () => {
    await expect(probeAudioFile('track.mp3')).resolves.toEqual({ error: 'ffprobe-not-found' })
    expect(mocks.existsSync).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('reports a missing bundled ffprobe without running a different executable', async () => {
    vi.stubEnv('FRKB_FFMPEG_PATH', path.resolve('missing-tools', 'ffmpeg.exe'))
    mocks.existsSync.mockReturnValue(false)
    await expect(probeAudioFile('track.mp3')).resolves.toEqual({ error: 'ffprobe-not-found' })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
})
