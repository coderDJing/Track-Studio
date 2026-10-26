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
vi.mock('./rcDiagnostics', () => ({ isPackagedRcBuild: vi.fn(() => false) }))
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
  runBpmFixPipeline: vi.fn()
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
  startBpmFixRepair
} from './bpmFix'
import { resolveBpmFixRuntime, runBpmFixPipeline } from './bpmFixProcess'
import { publishBpmFixOutput } from './bpmFixFiles'
import { log } from '../log'
import { isPackagedRcBuild } from './rcDiagnostics'

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
    vi.mocked(isPackagedRcBuild).mockReturnValue(false)
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
    'records diagnostics only in RC and never publishes failed output (RC=%s)',
    async (rc) => {
      vi.mocked(isPackagedRcBuild).mockReturnValue(rc)
      vi.mocked(runBpmFixPipeline).mockResolvedValueOnce({
        public: {
          sourceBpm: 128,
          referenceBpm: 128,
          confidence: 0.9,
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
            allowLowConfidence: false
          }
        ]
      })
      await vi.waitFor(() => expect(isBpmFixBusy()).toBe(false))
      expect(snapshot.tracks[0].error).toBe('BPM_FIX_VERIFICATION_FAILED')
      expect(publishBpmFixOutput).not.toHaveBeenCalled()
      expect(snapshot.tracks[0].outputPath).toBeUndefined()
      const repairArgs = vi.mocked(runBpmFixPipeline).mock.calls[1][2]
      expect(repairArgs.includes('--rc-diagnostics')).toBe(rc)
      expect(log.info).toHaveBeenCalledTimes(rc ? 1 : 0)
      if (rc) {
        expect(log.info).toHaveBeenCalledWith(
          '[bpm-fix][rc] verification',
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
})
