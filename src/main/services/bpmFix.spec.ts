// Run: pnpm exec vitest run src/main/services/bpmFix.spec.ts
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => path.resolve('tmp') }
}))
vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn(),
    mkdtemp: vi.fn(async () => path.resolve('tmp/bpm-test')),
    rm: vi.fn(async () => {})
  }
}))
vi.mock('../ffmpeg', () => ({
  ensureExecutableOnMac: vi.fn(),
  resolveBundledFfmpegPath: () => path.resolve('vendor/ffmpeg.exe')
}))
vi.mock('./childProcessRegistry', () => ({ terminateChildProcess: vi.fn() }))
vi.mock('../log', () => ({ log: { error: vi.fn(), info: vi.fn() } }))
vi.mock('./libraryMerge/mutationGate', () => ({
  tryBeginLibraryMaintenanceMutation: vi.fn(() => vi.fn())
}))
vi.mock('./bpmFixFiles', () => ({
  readBpmFixSourceIdentity: vi.fn(async (filePath: string) => ({ realPath: filePath })),
  assertBpmFixSourceUnchanged: vi.fn(),
  publishBpmFixOutput: vi.fn()
}))
vi.mock('./bpmFixProcess', () => ({
  resolveBpmFixRuntime: vi.fn(async () => ({
    command: 'python',
    args: [],
    env: {},
    device: 'cpu'
  })),
  runBpmFixPipeline: vi.fn(),
  closeBpmFixPipeline: vi.fn(async () => {})
}))
vi.mock('./bpmFixPlaylist', () => ({
  resolveBpmFixPlaylist: vi.fn(async () => ({ root: path.resolve('music'), uuid: 'list' })),
  assertBpmFixPlaylistTrack: vi.fn(),
  chooseBpmFixDestination: vi.fn(async () => path.resolve('music/fixed.wav')),
  commitBpmFixPlaylist: vi.fn(),
  refreshBpmFixPlaylist: vi.fn(),
  beginBpmFixPublication: vi.fn(() => vi.fn())
}))

import {
  closeBpmFix,
  getBpmFixSnapshot,
  isBpmFixBusy,
  prepareBpmFix,
  startBpmFixAnalysis,
  startBpmFixRepair,
  cancelBpmFix
} from './bpmFix'
import { resolveBpmFixRuntime, runBpmFixPipeline } from './bpmFixProcess'
import { publishBpmFixOutput } from './bpmFixFiles'
import { log } from '../log'

const owner = Object.assign(new EventEmitter(), {
  id: 42,
  send: vi.fn(),
  isDestroyed: () => false
})
const input = {
  filePaths: [path.resolve('music/source.wav')],
  songListUUID: 'list',
  songListPath: path.resolve('music')
}
const prepare = () => prepareBpmFix(owner as unknown as WebContents, input)

describe('BPM drift repair session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runBpmFixPipeline).mockReset()
    vi.stubEnv('FRKB_R3_STRETCH_LIBRARY', path.resolve('vendor/stretch.dll'))
  })
  afterEach(async () => {
    await vi.waitFor(() => expect(isBpmFixBusy()).toBe(false))
    const snapshot = getBpmFixSnapshot(owner.id)
    if (snapshot) closeBpmFix(owner.id, snapshot.id)
    vi.unstubAllEnvs()
  })

  it('opening and closing do not initialize the runtime or process audio', async () => {
    const snapshot = await prepare()
    expect(snapshot.status).toBe('pending')
    expect(isBpmFixBusy()).toBe(false)
    expect(resolveBpmFixRuntime).not.toHaveBeenCalled()
    expect(runBpmFixPipeline).not.toHaveBeenCalled()
    expect(owner.send).not.toHaveBeenCalled()
    closeBpmFix(owner.id, snapshot.id)
    expect(getBpmFixSnapshot(owner.id)).toBeNull()
  })

  it('requires the session owner to explicitly start analysis', async () => {
    const snapshot = await prepare()
    expect(() => startBpmFixAnalysis(99, snapshot.id)).toThrow('BPM_FIX_SESSION_EXPIRED')
    expect(resolveBpmFixRuntime).not.toHaveBeenCalled()
    vi.mocked(runBpmFixPipeline).mockRejectedValue(new Error('BPM_FIX_UNRELIABLE_BEATS'))
    expect(startBpmFixAnalysis(owner.id, snapshot.id).status).toBe('analyzing')
    expect(resolveBpmFixRuntime).toHaveBeenCalledOnce()
    expect(() => startBpmFixAnalysis(owner.id, snapshot.id)).toThrow('BPM_FIX_BUSY')
    await vi.waitFor(() => expect(isBpmFixBusy()).toBe(false))
    expect(getBpmFixSnapshot(owner.id)?.tracks[0].status).toBe('failed')
  })

  it.each([false, true])(
    'automatic repair proceeds without a second click and respects cancellation (%s)',
    async (cancel) => {
      vi.mocked(runBpmFixPipeline)
        .mockImplementationOnce(async () => {
          if (cancel) cancelBpmFix(owner.id)
          return {
            public: {
              sourceBpm: 128,
              referenceBpm: 64,
              confidence: 0.4,
              agreement: 0,
              regularity: 1,
              driftMs: 150,
              coverage: 1,
              filledBeats: 0,
              ignoredDetections: 0,
              durationSec: 120,
              tempoAmbiguous: true
            },
            analysis: { beats: [0, 0.5, 1] }
          }
        })
        .mockRejectedValueOnce(new Error('BPM_FIX_VERIFICATION_FAILED'))
      const snapshot = await prepare()
      expect(() =>
        startBpmFixAnalysis(owner.id, snapshot.id, { saveMode: 'invalid', format: 'wav' })
      ).toThrow('BPM_FIX_INVALID_OPTIONS')
      startBpmFixAnalysis(owner.id, snapshot.id, { saveMode: 'copy', format: 'wav' })
      await vi.waitFor(() => expect(isBpmFixBusy()).toBe(false))
      expect(runBpmFixPipeline).toHaveBeenCalledTimes(cancel ? 1 : 2)
      if (cancel) expect(snapshot.status).toBe('cancelled')
      else {
        expect(vi.mocked(runBpmFixPipeline).mock.calls[1][2]).toContain('--automatic')
        expect(snapshot.status).toBe('completed')
        expect(snapshot.tracks[0].error).toBe('BPM_FIX_VERIFICATION_FAILED')
      }
      expect(publishBpmFixOutput).not.toHaveBeenCalled()
    }
  )

  it.each([0.4, 0.9])(
    'logs rejected verification and never publishes failed output (confidence=%s)',
    async (confidence) => {
      vi.mocked(runBpmFixPipeline).mockResolvedValueOnce({
        public: {
          sourceBpm: 128,
          referenceBpm: 128,
          confidence,
          agreement: 0.9,
          regularity: 0.9,
          driftMs: 150,
          coverage: 1,
          filledBeats: 0,
          ignoredDetections: 0,
          durationSec: 120,
          tempoAmbiguous: false
        },
        analysis: { beats: [0, 0.5, 1] }
      })
      const snapshot = await prepare()
      startBpmFixAnalysis(owner.id, snapshot.id)
      await vi.waitFor(() => expect(isBpmFixBusy()).toBe(false))
      expect(snapshot.tracks[0].status).toBe('ready')
      vi.mocked(runBpmFixPipeline).mockImplementationOnce(
        async (_job, _runtime, _args, _progress, _analysis, diagnostic) => {
          diagnostic?.({ passed: false, reasons: ['grid_rms'], metrics: { gridRmsMs: 20 } })
          throw new Error('BPM_FIX_VERIFICATION_FAILED')
        }
      )
      startBpmFixRepair(owner.id, snapshot.id, {
        saveMode: 'overwrite',
        format: 'wav',
        tracks: [
          {
            id: snapshot.tracks[0].id,
            enabled: true,
            tempoFactor: 1,
            targetBpm: 128,
            allowLowConfidence: confidence < 0.5
          }
        ]
      })
      await vi.waitFor(() => expect(isBpmFixBusy()).toBe(false))
      expect(snapshot.tracks[0].error).toBe('BPM_FIX_VERIFICATION_FAILED')
      expect(publishBpmFixOutput).not.toHaveBeenCalled()
      expect(snapshot.tracks[0].outputPath).toBeUndefined()
      const repairArgs = vi.mocked(runBpmFixPipeline).mock.calls[1][2]
      expect(repairArgs.includes('--diagnostics')).toBe(true)
      expect(log.info).not.toHaveBeenCalled()
      {
        expect(log.error).toHaveBeenCalledWith(
          '[bpm-fix] verification rejected',
          expect.objectContaining({
            sessionId: snapshot.id,
            filePath: input.filePaths[0],
            mode: 'repair',
            passed: false,
            reasons: ['grid_rms'],
            metrics: { gridRmsMs: 20 }
          })
        )
      }
    }
  )

  it('publishes a verified automatic result without stopping for low confidence or tempo ambiguity', async () => {
    vi.mocked(runBpmFixPipeline)
      .mockResolvedValueOnce({
        public: {
          sourceBpm: 128,
          referenceBpm: 64,
          confidence: 0.4,
          agreement: 0,
          regularity: 1,
          driftMs: 150,
          coverage: 1,
          filledBeats: 0,
          ignoredDetections: 0,
          durationSec: 120,
          tempoAmbiguous: true
        },
        analysis: { beats: [0, 0.5, 1] }
      })
      .mockResolvedValueOnce({
        sourceBpm: 128,
        targetBpm: 128,
        gridOffsetSec: 0,
        confidence: 0.4,
        durationInSec: 120,
        durationOutSec: 120,
        noticeableSegments: 0,
        peakGain: 1,
        verification: {
          passed: true,
          detectedBpm: 128,
          bpmError: 0,
          gridRmsMs: 6,
          offGridBeats: 0
        },
        timeMap: { from: [0, 100], to: [0, 100], sampleRate: 44100, downbeatBeatOffset: 0 }
      })
    vi.mocked(publishBpmFixOutput).mockResolvedValueOnce({
      outputPath: path.resolve('music/fixed.wav')
    })
    const snapshot = await prepare()
    startBpmFixAnalysis(owner.id, snapshot.id, { saveMode: 'copy', format: 'wav' })
    await vi.waitFor(() => expect(isBpmFixBusy()).toBe(false))
    expect(snapshot.status).toBe('completed')
    expect(snapshot.tracks[0].status).toBe('completed')
    expect(snapshot.tracks[0].summary?.verification.passed).toBe(true)
    expect(publishBpmFixOutput).toHaveBeenCalledWith(expect.objectContaining({ overwrite: false }))
  })
})
