import { app, type WebContents } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BpmFixAnalysis,
  BpmFixOptions,
  BpmFixSnapshot,
  BpmFixStart,
  BpmFixRuntime,
  BpmFixTrackOptions
} from '../../shared/bpmFix'
import { ensureExecutableOnMac, resolveBundledFfmpegPath } from '../ffmpeg'
import { terminateChildProcess } from './childProcessRegistry'
import {
  readBpmFixSourceIdentity,
  assertBpmFixSourceUnchanged,
  publishBpmFixOutput,
  type BpmFixSource
} from './bpmFixFiles'
import { log } from '../log'
import { tryBeginLibraryMaintenanceMutation } from './libraryMerge/mutationGate'
import { resolveBpmFixRuntime, runBpmFixPipeline, type BpmFixProcessJob } from './bpmFixProcess'
import { readBpmFixSummary } from './bpmFixResult'
import { isPackagedRcBuild } from './rcDiagnostics'
import {
  resolveBpmFixPlaylist,
  assertBpmFixPlaylistTrack,
  chooseBpmFixDestination,
  commitBpmFixPlaylist,
  refreshBpmFixPlaylist,
  beginBpmFixPublication,
  type BpmFixPlaylist,
  type BpmFixTimeMap
} from './bpmFixPlaylist'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
type Job = BpmFixProcessJob & {
  owner: WebContents
  snapshot: BpmFixSnapshot
  playlist?: BpmFixPlaylist
  runtime?: BpmFixRuntime
  args?: string[]
  sources: Map<string, BpmFixSource>
  analyses: Map<string, Record<string, unknown>>
  working?: Promise<void>
  destroyed: () => void
}
let activeJob: Job | null = null
export const isBpmFixBusy = () => !!activeJob?.working
const requireJob = (ownerId: number, id?: unknown) => {
  const job = activeJob
  if (!job || job.owner.id !== ownerId || (id !== undefined && id !== job.snapshot.id))
    throw new Error('BPM_FIX_SESSION_EXPIRED')
  return job
}
export const getBpmFixSnapshot = (ownerId: number) =>
  activeJob?.owner.id === ownerId ? activeJob.snapshot : null
const notify = (job: Job) => {
  if (job.owner.isDestroyed()) return
  const state = job.snapshot
  job.owner.send('audio:bpm-fix:updated', state)
  job.owner.send('progressSet', {
    id: state.id,
    titleKey: `bpmFix.${state.stage}`,
    now: Math.floor(state.percent),
    total: 100,
    cancelable: state.status === 'analyzing' || state.status === 'repairing',
    cancelChannel: 'audio:bpm-fix:cancel',
    cancelPayload: state.id
  })
}
const progress = (job: Job, stage: string, percent: number) => {
  if (job.cancelled) return
  job.snapshot.stage = stage
  job.snapshot.currentPercent = Math.max(0, Math.min(100, percent))
  const count = job.snapshot.tracks.length
  job.snapshot.percent = Math.min(99, ((job.snapshot.current - 1) * 100 + percent) / count)
  notify(job)
}
export const cancelBpmFix = (ownerId?: number, id?: string) => {
  const job = activeJob
  if (!job || (ownerId !== undefined && job.owner.id !== ownerId) || (id && id !== job.snapshot.id))
    return
  job.cancelled = true
  if (job.child) terminateChildProcess(job.child, 'bpm-fix')
  if (job.worker) void job.worker.terminate()
  if (!job.working) {
    job.snapshot.status = 'cancelled'
    job.snapshot.stage = 'cancelled'
    notify(job)
  }
}
const assertRunning = (job: Job) => {
  if (job.cancelled) throw new Error('BPM_FIX_CANCELLED')
}
const prepare = async (job: Job) => {
  if (job.runtime && job.args) return
  job.runtime = await resolveBpmFixRuntime(job)
  assertRunning(job)
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'demucs/bootstrap/bpm_fix.py')
    : path.resolve('scripts/bpm_fix.py')
  const library = process.env.FRKB_R3_STRETCH_LIBRARY
  if (!library) throw new Error('BPM_FIX_R3_UNAVAILABLE')
  const ffmpeg = resolveBundledFfmpegPath()
  const ffprobe = path.join(
    path.dirname(ffmpeg),
    process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  )
  await Promise.all([fs.access(script), fs.access(library), fs.access(ffmpeg), fs.access(ffprobe)])
  await Promise.all([ensureExecutableOnMac(ffmpeg), ensureExecutableOnMac(ffprobe)])
  job.args = [script, '--ffmpeg', ffmpeg, '--ffprobe', ffprobe, '--rubberband', library]
}
const runTrack = async (
  job: Job,
  filePath: string,
  output: string,
  mode: 'analyze' | 'repair',
  options?: BpmFixTrackOptions,
  analysis?: unknown
) => {
  assertRunning(job)
  if (!job.runtime || !job.args) throw new Error('BPM_FIX_RUNTIME_UNAVAILABLE')
  const args = [...job.args, '--input', filePath, '--output', output, '--mode', mode]
  if (options) {
    args.push('--tempo-factor', String(options.tempoFactor), '--analysis-stdin')
    if (options.targetBpm !== null) args.push('--target-bpm', String(options.targetBpm))
    if (options.allowLowConfidence) args.push('--allow-low-confidence')
  }
  // 每首输出一次 RC 复检摘要；失败原因修复且真实样本回归通过后移除这条采集链路。
  const rcDiagnostics = isPackagedRcBuild()
  if (rcDiagnostics) args.push('--rc-diagnostics')
  return runBpmFixPipeline(
    job,
    job.runtime,
    args,
    (stage, value) => progress(job, stage, value),
    analysis,
    rcDiagnostics
      ? (details) =>
          log.info('[bpm-fix][rc] verification', {
            sessionId: job.snapshot.id,
            filePath,
            mode,
            ...details
          })
      : undefined
  )
}
const analyzeBatch = async (job: Job) => {
  let folder = ''
  let finalStatus: BpmFixSnapshot['status'] = 'ready'
  try {
    await prepare(job)
    folder = await fs.mkdtemp(path.join(app.getPath('temp'), 'frkb-bpm-fix-'))
    for (const [index, track] of job.snapshot.tracks.entries()) {
      assertRunning(job)
      job.snapshot.current = index + 1
      track.status = 'analyzing'
      progress(job, 'analyzing', 0)
      try {
        const source = await readBpmFixSourceIdentity(track.filePath)
        assertBpmFixPlaylistTrack(job.playlist!, source.realPath)
        job.sources.set(track.id, source)
        const result = await runTrack(
          job,
          source.realPath,
          path.join(folder, 'analysis.wav'),
          'analyze'
        )
        if (!isRecord(result) || !isRecord(result.public) || !isRecord(result.analysis))
          throw new Error('BPM_FIX_INVALID_RESULT')
        const publicResult = result.public
        const fields = [
          'sourceBpm',
          'referenceBpm',
          'confidence',
          'agreement',
          'regularity',
          'driftMs',
          'coverage',
          'filledBeats',
          'ignoredDetections',
          'durationSec'
        ]
        if (
          fields.some(
            (key) => typeof publicResult[key] !== 'number' || !Number.isFinite(publicResult[key])
          )
        )
          throw new Error('BPM_FIX_INVALID_RESULT')
        await assertBpmFixSourceUnchanged(source)
        track.analysis = result.public as BpmFixAnalysis
        job.analyses.set(track.id, result.analysis)
        track.status = 'ready'
      } catch (error) {
        if (job.cancelled) throw error
        track.status = 'failed'
        track.error = messageOf(error)
        log.error('[bpm-fix] analysis failed', { filePath: track.filePath, error })
      }
      notify(job)
    }
  } catch (error) {
    finalStatus = job.cancelled ? 'cancelled' : 'failed'
    if (!job.cancelled) {
      job.snapshot.error = messageOf(error)
      log.error('[bpm-fix] batch failed', error)
    }
  } finally {
    if (folder)
      await fs
        .rm(folder, { recursive: true, force: true })
        .catch((error) => log.error('[bpm-fix] cleanup failed', error))
    if (job.cancelled)
      for (const track of job.snapshot.tracks)
        if (['pending', 'analyzing'].includes(track.status)) track.status = 'cancelled'
    job.snapshot.status = job.cancelled ? 'cancelled' : finalStatus
    job.snapshot.stage = job.snapshot.status
    if (!job.cancelled && finalStatus === 'ready') {
      job.snapshot.percent = 100
      job.snapshot.currentPercent = 100
    }
    job.working = undefined
    notify(job)
  }
}
export const prepareBpmFix = async (owner: WebContents, value: unknown) => {
  if (activeJob) {
    if (activeJob.owner.id === owner.id) return activeJob.snapshot
    throw new Error('BPM_FIX_BUSY')
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.filePaths) ||
    !value.filePaths.length ||
    value.filePaths.length > 5000 ||
    value.filePaths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))
  )
    throw new Error('BPM_FIX_INVALID_PATH')
  const input = value as BpmFixStart
  const seen = new Set<string>()
  const paths = input.filePaths.filter((p) => {
    const key = process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const job: Job = {
    owner,
    cancelled: false,
    sources: new Map(),
    analyses: new Map(),
    snapshot: {
      id: `bpm_fix_${randomUUID()}`,
      status: 'pending',
      tracks: paths.map((filePath) => ({ id: randomUUID(), filePath, status: 'pending' })),
      stage: 'pending',
      current: 0,
      currentPercent: 0,
      percent: 0
    },
    destroyed: () => {
      cancelBpmFix(owner.id)
      if (job.working)
        void job.working.finally(() => {
          if (activeJob === job) activeJob = null
        })
      else if (activeJob === job) activeJob = null
    }
  }
  activeJob = job
  try {
    job.playlist = await resolveBpmFixPlaylist(input)
  } catch (error) {
    activeJob = null
    throw error
  }
  owner.once('destroyed', job.destroyed)
  return job.snapshot
}
export const startBpmFixAnalysis = (ownerId: number, id: unknown) => {
  const job = requireJob(ownerId, id)
  if (job.working || job.snapshot.status !== 'pending') throw new Error('BPM_FIX_BUSY')
  job.snapshot.status = 'analyzing'
  job.snapshot.stage = 'loading'
  job.snapshot.current = 1
  job.working = analyzeBatch(job)
  notify(job)
  return job.snapshot
}
const readOptions = (value: unknown, job: Job): BpmFixOptions => {
  if (
    !isRecord(value) ||
    !['copy', 'overwrite'].includes(String(value.saveMode)) ||
    !['original', 'wav'].includes(String(value.format)) ||
    !Array.isArray(value.tracks)
  )
    throw new Error('BPM_FIX_INVALID_OPTIONS')
  const ids = new Set<string>()
  const tracks = value.tracks.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      ids.has(item.id) ||
      typeof item.tempoFactor !== 'number' ||
      ![0.5, 1, 2].includes(item.tempoFactor) ||
      typeof item.enabled !== 'boolean' ||
      typeof item.allowLowConfidence !== 'boolean' ||
      (item.targetBpm !== null &&
        (typeof item.targetBpm !== 'number' ||
          !Number.isFinite(item.targetBpm) ||
          item.targetBpm < 30 ||
          item.targetBpm > 300))
    )
      throw new Error('BPM_FIX_INVALID_OPTIONS')
    ids.add(item.id)
    const track = job.snapshot.tracks.find((track) => track.id === item.id)
    if (!track || (item.enabled && track.status !== 'ready'))
      throw new Error('BPM_FIX_INVALID_OPTIONS')
    if (item.enabled && (track.analysis?.confidence ?? 0) < 0.5 && !item.allowLowConfidence)
      throw new Error('BPM_FIX_LOW_CONFIDENCE')
    return item as BpmFixTrackOptions
  })
  if (!tracks.some((t) => t.enabled)) throw new Error('BPM_FIX_NO_SELECTION')
  return {
    saveMode: value.saveMode as BpmFixOptions['saveMode'],
    format: value.format as BpmFixOptions['format'],
    tracks
  }
}
const repairBatch = async (job: Job, options: BpmFixOptions) => {
  let folder = ''
  let finalStatus: BpmFixSnapshot['status'] = 'completed'
  try {
    const playlist = job.playlist!
    folder = await fs.mkdtemp(path.join(app.getPath('temp'), 'frkb-bpm-fix-'))
    for (const [index, track] of job.snapshot.tracks.entries()) {
      assertRunning(job)
      job.snapshot.current = index + 1
      const settings = options.tracks.find((t) => t.id === track.id)
      if (!settings?.enabled) {
        if (track.status === 'ready') track.status = 'skipped'
        continue
      }
      track.status = 'repairing'
      progress(job, 'planning', 0)
      try {
        const source = job.sources.get(track.id)!
        await assertBpmFixSourceUnchanged(source)
        assertBpmFixPlaylistTrack(playlist, source.realPath)
        const overwrite = options.saveMode === 'overwrite'
        const destination = await chooseBpmFixDestination(
          playlist,
          source.realPath,
          overwrite,
          options.format
        )
        const stagedAudio = path.join(folder, track.id + path.extname(destination))
        const result = await runTrack(
          job,
          source.realPath,
          stagedAudio,
          'repair',
          settings,
          job.analyses.get(track.id)
        )
        const summary = readBpmFixSummary(result)
        if (!isRecord(result) || !isRecord(result.timeMap))
          throw new Error('BPM_FIX_INVALID_RESULT')
        const map = result.timeMap as BpmFixTimeMap
        if (
          !Array.isArray(map.from) ||
          !Array.isArray(map.to) ||
          map.from.length < 2 ||
          map.from.length !== map.to.length ||
          !Number.isFinite(map.sampleRate) ||
          map.sampleRate <= 0 ||
          !Number.isFinite(map.downbeatBeatOffset) ||
          [...map.from, ...map.to].some((n) => !Number.isFinite(n))
        )
          throw new Error('BPM_FIX_INVALID_RESULT')
        assertRunning(job)
        const release = tryBeginLibraryMaintenanceMutation()
        if (!release) throw new Error('LIBRARY_MERGE_IN_PROGRESS')
        let releaseView = () => {}
        let playlistUuids: string[] = []
        try {
          releaseView = beginBpmFixPublication([source.realPath, destination])
          const published = await publishBpmFixOutput({
            source,
            stagedAudio,
            destination,
            overwrite,
            commit: (output) => {
              playlistUuids = commitBpmFixPlaylist(
                playlist,
                source.realPath,
                output,
                overwrite,
                summary,
                map
              )
            }
          })
          track.outputPath = published.outputPath
          track.summary = summary
          track.status = 'completed'
        } finally {
          releaseView()
          release()
        }
        try {
          await refreshBpmFixPlaylist([source.realPath, destination, playlist.root])
        } catch (error) {
          log.error('[bpm-fix] refresh failed', error)
        }
        if (!job.owner.isDestroyed())
          job.owner.send('audio:bpm-fix:files-changed', {
            playlistUuids,
            sourcePath: source.realPath,
            outputPath: destination,
            overwritten: overwrite
          })
        await fs.rm(stagedAudio, { force: true })
      } catch (error) {
        if (job.cancelled) throw error
        track.status = 'failed'
        track.error = messageOf(error)
        log.error('[bpm-fix] repair failed', { filePath: track.filePath, error })
      }
      notify(job)
    }
  } catch (error) {
    finalStatus = job.cancelled ? 'cancelled' : 'failed'
    if (!job.cancelled) {
      job.snapshot.error = messageOf(error)
      log.error('[bpm-fix] repair batch failed', error)
    }
  } finally {
    if (folder)
      await fs
        .rm(folder, { recursive: true, force: true })
        .catch((error) => log.error('[bpm-fix] cleanup failed', error))
    if (job.cancelled)
      for (const track of job.snapshot.tracks)
        if (['ready', 'repairing'].includes(track.status)) track.status = 'cancelled'
    job.analyses.clear()
    job.snapshot.status = job.cancelled ? 'cancelled' : finalStatus
    job.snapshot.stage = job.snapshot.status
    if (!job.cancelled && finalStatus === 'completed') {
      job.snapshot.percent = 100
      job.snapshot.currentPercent = 100
    }
    job.working = undefined
    notify(job)
  }
}
export const startBpmFixRepair = (ownerId: number, id: unknown, value: unknown) => {
  const job = requireJob(ownerId, id)
  if (job.working || job.snapshot.status !== 'ready') throw new Error('BPM_FIX_BUSY')
  const options = readOptions(value, job)
  job.snapshot.status = 'repairing'
  job.snapshot.stage = 'planning'
  job.snapshot.percent = 0
  job.snapshot.currentPercent = 0
  job.working = repairBatch(job, options)
  notify(job)
  return job.snapshot
}
export const closeBpmFix = (ownerId: number, id: unknown) => {
  const job = requireJob(ownerId, id)
  if (job.working) throw new Error('BPM_FIX_BUSY')
  job.owner.removeListener('destroyed', job.destroyed)
  if (!job.owner.isDestroyed())
    job.owner.send('progressSet', { id: job.snapshot.id, dismiss: true })
  activeJob = null
}
