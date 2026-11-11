import child_process from 'node:child_process'
import path from 'node:path'
import fs from 'fs-extra'
import { ensureExecutableOnMac, resolveBundledFfmpegPath } from '../ffmpeg'
import { registerChildProcess, terminateChildProcess } from './childProcessRegistry'

const INVALID_FILENAME_CHARS_REG = /[<>:"/\\|?*\u0000-\u001f]/g
const TIME_PROGRESS_REG = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/g
const MIN_TEMPO_RATIO = 0.25
const MAX_TEMPO_RATIO = 4
const MIN_GAIN = 0.0001
const MAX_GAIN = 4

type MixtapeOutputFormat = 'wav' | 'mp3'

type MixtapeOutputEnvelopePoint = {
  sec?: number
  gain?: number
}

type MixtapeOutputMuteSegment = {
  startSec?: number
  endSec?: number
}

type MixtapeOutputTrackInput = {
  id?: string
  mixOrder?: number
  filePath?: string
  startSec?: number
  bpm?: number
  originalBpm?: number
  duration?: string
  durationSec?: number
  gainEnvelope?: MixtapeOutputEnvelopePoint[]
  volumeEnvelope?: MixtapeOutputEnvelopePoint[]
  volumeMuteSegments?: MixtapeOutputMuteSegment[]
}

export type MixtapeOutputInput = {
  requestId?: string
  outputPath?: string
  outputFormat?: MixtapeOutputFormat
  outputFilename?: string
  wavBytes?: Uint8Array | ArrayBuffer | number[]
  durationSec?: number
  sampleRate?: number
  channels?: number
  tracks?: MixtapeOutputTrackInput[]
}

export type MixtapeOutputProgressPayload = {
  stageKey: string
  done: number
  total: number
  percent: number
}

type MixtapeOutputResult = {
  outputPath: string
  trackCount: number
}

export type MixtapeOutputControl = {
  requestId: string
  cancelled: boolean
  cancelReason?: string
  currentChild: child_process.ChildProcess | null
}

type NormalizedTrack = {
  filePath: string
  startSec: number
  tempoRatio: number
  gain: number
  durationSec: number
}

const clampNumber = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

const normalizePositiveNumber = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return numeric
}

const normalizeNonNegativeNumber = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  return numeric
}

const parseDurationToSeconds = (input: unknown): number => {
  if (typeof input !== 'string') return 0
  const text = input.trim()
  if (!text) return 0
  const parts = text
    .split(':')
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value) && value >= 0)
  if (!parts.length) return 0
  if (parts.length === 1) return parts[0] || 0
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0)
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0)
}

const normalizeEnvelopePoints = (input: unknown): Array<{ sec: number; gain: number }> => {
  if (!Array.isArray(input)) return []
  return input
    .map((point) => ({
      sec: Number((point as MixtapeOutputEnvelopePoint)?.sec),
      gain: Number((point as MixtapeOutputEnvelopePoint)?.gain)
    }))
    .filter((point) => Number.isFinite(point.sec) && point.sec >= 0 && Number.isFinite(point.gain))
    .map((point) => ({
      sec: Number(point.sec),
      gain: clampNumber(Number(point.gain), MIN_GAIN, MAX_GAIN)
    }))
    .sort((left, right) => left.sec - right.sec)
}

const sampleEnvelopeGainAtSec = (
  points: Array<{ sec: number; gain: number }>,
  sec: number,
  fallback = 1
) => {
  if (!points.length) return fallback
  if (points.length === 1) return points[0]?.gain ?? fallback
  if (sec <= points[0].sec) return points[0].gain
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]
    const right = points[index]
    if (sec > right.sec) continue
    const range = right.sec - left.sec
    if (range <= 0.00001) return right.gain
    const ratio = clampNumber((sec - left.sec) / range, 0, 1)
    return left.gain + (right.gain - left.gain) * ratio
  }
  return points[points.length - 1].gain
}

const normalizeMuteSegments = (input: unknown) => {
  if (!Array.isArray(input)) return [] as Array<{ startSec: number; endSec: number }>
  return input
    .map((segment) => ({
      startSec: Number((segment as MixtapeOutputMuteSegment)?.startSec),
      endSec: Number((segment as MixtapeOutputMuteSegment)?.endSec)
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.startSec) &&
        Number.isFinite(segment.endSec) &&
        segment.startSec >= 0 &&
        segment.endSec > segment.startSec
    )
    .sort((left, right) => left.startSec - right.startSec)
}

const resolveTrackStaticGain = (track: MixtapeOutputTrackInput) => {
  const gainPoints = normalizeEnvelopePoints(track.gainEnvelope)
  const volumePoints = normalizeEnvelopePoints(track.volumeEnvelope)
  const muteSegments = normalizeMuteSegments(track.volumeMuteSegments)
  const gainAtZero = sampleEnvelopeGainAtSec(gainPoints, 0, 1)
  const volumeAtZero = sampleEnvelopeGainAtSec(volumePoints, 0, 1)
  const mutedAtZero = muteSegments.some((segment) => segment.startSec <= 0 && segment.endSec > 0)
  const muteGain = mutedAtZero ? MIN_GAIN : 1
  return clampNumber(gainAtZero * volumeAtZero * muteGain, MIN_GAIN, MAX_GAIN)
}

const normalizeTempoRatio = (track: MixtapeOutputTrackInput) => {
  const bpm = normalizePositiveNumber(track.bpm)
  const originalBpm = normalizePositiveNumber(track.originalBpm)
  if (!bpm || !originalBpm) return 1
  return clampNumber(bpm / originalBpm, MIN_TEMPO_RATIO, MAX_TEMPO_RATIO)
}

const sanitizeFilename = (value: unknown) => {
  const raw = typeof value === 'string' ? value.trim() : ''
  const sanitized = raw.replace(INVALID_FILENAME_CHARS_REG, ' ').replace(/\s+/g, ' ').trim()
  return sanitized
}

const buildDefaultFilename = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `rec-${date}-${time}`
}

const stripKnownAudioExt = (value: string) => value.replace(/\.(wav|mp3)$/i, '')

const resolveOutputFilePath = async (
  outputDir: string,
  outputFilename: string,
  outputFormat: MixtapeOutputFormat
) => {
  await fs.ensureDir(outputDir)
  const ext = outputFormat === 'mp3' ? '.mp3' : '.wav'
  const sanitized = sanitizeFilename(outputFilename) || buildDefaultFilename()
  const baseName = stripKnownAudioExt(sanitized) || buildDefaultFilename()
  let candidate = path.join(outputDir, `${baseName}${ext}`)
  if (!(await fs.pathExists(candidate))) return candidate
  let index = 1
  while (true) {
    const next = path.join(outputDir, `${baseName} (${index})${ext}`)
    if (!(await fs.pathExists(next))) return next
    index += 1
  }
}

const toNodeBuffer = (value: unknown): Buffer => {
  if (!value) return Buffer.alloc(0)
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value)
  }
  if (Array.isArray(value)) {
    return Buffer.from(value)
  }
  return Buffer.alloc(0)
}

export const createMixtapeOutputControl = (requestId: string): MixtapeOutputControl => ({
  requestId,
  cancelled: false,
  currentChild: null
})

export const cancelMixtapeOutputControl = (
  control: MixtapeOutputControl,
  reason = 'mixtape.outputCancelled'
): void => {
  control.cancelled = true
  control.cancelReason = reason
  if (!control.currentChild) return
  terminateChildProcess(control.currentChild, 'mixtape-output:ffmpeg')
  control.currentChild = null
}

const ensureNotCancelled = (control?: MixtapeOutputControl) => {
  if (control?.cancelled) {
    throw new Error(control.cancelReason || 'mixtape.outputCancelled')
  }
}

const spawnMixtapeFfmpeg = (
  ffmpegPath: string,
  args: string[],
  control?: MixtapeOutputControl
): child_process.ChildProcess => {
  ensureNotCancelled(control)
  const child = child_process.spawn(ffmpegPath, args, { windowsHide: true })
  registerChildProcess(child, 'mixtape-output:ffmpeg')
  if (control) {
    control.currentChild = child
    const clearChild = () => {
      if (control.currentChild === child) {
        control.currentChild = null
      }
    }
    child.once('exit', clearChild)
    child.once('error', clearChild)
  }
  return child
}

const transcodeWavToMp3 = async (
  ffmpegPath: string,
  wavPath: string,
  mp3Path: string,
  durationSec: number,
  control?: MixtapeOutputControl,
  onProgress?: (payload: MixtapeOutputProgressPayload) => void
) => {
  const args = [
    '-hide_banner',
    '-y',
    '-i',
    wavPath,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '320k',
    '-id3v2_version',
    '3',
    mp3Path
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawnMixtapeFfmpeg(ffmpegPath, args, control)
    let stderrText = ''
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      if (!text) return
      stderrText += text
      if (stderrText.length > 6000) {
        stderrText = stderrText.slice(-6000)
      }
      const parsedSec = parseFfmpegProgressSec(text)
      if (parsedSec === null || !(durationSec > 0)) return
      const ratio = clampNumber(parsedSec / durationSec, 0, 1)
      const percent = Math.round(96 + ratio * 3)
      onProgress?.({
        stageKey: 'mixtape.outputProgressEncoding',
        done: percent,
        total: 100,
        percent
      })
    })
    child.on('error', (error) => reject(error))
    child.on('exit', (code) => {
      if (control?.cancelled) {
        reject(new Error(control.cancelReason || 'mixtape.outputCancelled'))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`ffmpeg exited with code ${code} ${stderrText.trim()}`.trim()))
    })
  })
}

const parseFfmpegProgressSec = (text: string) => {
  TIME_PROGRESS_REG.lastIndex = 0
  const matches = Array.from(String(text || '').matchAll(TIME_PROGRESS_REG))
  const last = matches[matches.length - 1]
  if (!last) return null
  const hh = Number(last[1])
  const mm = Number(last[2])
  const ss = Number(last[3])
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null
  return hh * 3600 + mm * 60 + ss
}

const buildTrackFilterChain = (track: NormalizedTrack, inputIndex: number, outputLabel: string) => {
  const filters: string[] = []
  if (Math.abs(track.tempoRatio - 1) > 0.0001) {
    filters.push(`asetrate=sample_rate*${track.tempoRatio.toFixed(6)}`)
    filters.push('aresample=sample_rate')
  }
  if (Math.abs(track.gain - 1) > 0.0001) {
    filters.push(`volume=${track.gain.toFixed(6)}`)
  }
  if (track.startSec > 0.0001) {
    const delayMs = Math.max(0, Math.round(track.startSec * 1000))
    filters.push(`adelay=${delayMs}|${delayMs}`)
  }
  filters.push('aformat=sample_fmts=fltp')
  return `[${inputIndex}:a]${filters.join(',')}[${outputLabel}]`
}

const buildMixFilterComplex = (tracks: NormalizedTrack[]) => {
  const stageFilters: string[] = []
  const labels: string[] = []
  tracks.forEach((track, index) => {
    const label = `mix${index}`
    labels.push(label)
    stageFilters.push(buildTrackFilterChain(track, index, label))
  })
  if (labels.length === 1) {
    stageFilters.push(`[${labels[0]}]anull[mixout]`)
  } else {
    const inputs = labels.map((label) => `[${label}]`).join('')
    stageFilters.push(
      `${inputs}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,alimiter=limit=0.98[mixout]`
    )
  }
  return stageFilters.join(';')
}

const runFfmpegMix = async (
  ffmpegPath: string,
  tracks: NormalizedTrack[],
  outputFilePath: string,
  outputFormat: MixtapeOutputFormat,
  estimatedDurationSec: number,
  control?: MixtapeOutputControl,
  onProgress?: (payload: MixtapeOutputProgressPayload) => void
) => {
  const args: string[] = ['-hide_banner', '-y']
  for (const track of tracks) {
    args.push('-i', track.filePath)
  }
  args.push('-filter_complex', buildMixFilterComplex(tracks), '-map', '[mixout]')
  if (outputFormat === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3')
  } else {
    args.push('-c:a', 'pcm_s16le')
  }
  args.push(outputFilePath)

  await new Promise<void>((resolve, reject) => {
    const child = spawnMixtapeFfmpeg(ffmpegPath, args, control)
    let stderrText = ''
    let lastPercent = 5
    let lastEmitAt = 0
    const emitRenderProgress = (percent: number) => {
      const nextPercent = clampNumber(Math.round(percent), 5, 95)
      const now = Date.now()
      if (nextPercent <= lastPercent && now - lastEmitAt < 300) return
      lastPercent = Math.max(lastPercent, nextPercent)
      lastEmitAt = now
      onProgress?.({
        stageKey: 'mixtape.outputProgressRendering',
        done: lastPercent,
        total: 100,
        percent: lastPercent
      })
    }

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      if (!text) return
      stderrText += text
      if (stderrText.length > 6000) {
        stderrText = stderrText.slice(-6000)
      }
      if (!(estimatedDurationSec > 0)) return
      const currentSec = parseFfmpegProgressSec(text)
      if (currentSec === null) return
      const ratio = clampNumber(currentSec / estimatedDurationSec, 0, 1)
      emitRenderProgress(5 + ratio * 90)
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('exit', (code) => {
      if (control?.cancelled) {
        reject(new Error(control.cancelReason || 'mixtape.outputCancelled'))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`ffmpeg exited with code ${code} ${stderrText.trim()}`.trim()))
    })
  })
}

const normalizeTracks = async (tracks: MixtapeOutputTrackInput[]) => {
  const normalized: NormalizedTrack[] = []
  for (const track of tracks) {
    const filePath = typeof track.filePath === 'string' ? track.filePath.trim() : ''
    if (!filePath) continue
    if (!(await fs.pathExists(filePath))) continue
    const startSec = normalizeNonNegativeNumber(track.startSec) ?? 0
    const tempoRatio = normalizeTempoRatio(track)
    const gain = resolveTrackStaticGain(track)
    const durationFromSec = normalizePositiveNumber(track.durationSec) ?? 0
    const durationFromLabel = parseDurationToSeconds(track.duration)
    const durationSec = Math.max(durationFromSec, durationFromLabel, 0)
    normalized.push({
      filePath,
      startSec,
      tempoRatio,
      gain,
      durationSec
    })
  }
  normalized.sort((left, right) => left.startSec - right.startSec)
  return normalized
}

const resolveEstimatedDurationSec = (tracks: NormalizedTrack[]) => {
  let maxSec = 0
  for (const track of tracks) {
    const effectiveDuration =
      track.durationSec > 0
        ? track.durationSec / Math.max(MIN_TEMPO_RATIO, Math.abs(track.tempoRatio))
        : 0
    const trackEnd = track.startSec + Math.max(0, effectiveDuration)
    if (trackEnd > maxSec) {
      maxSec = trackEnd
    }
  }
  return maxSec
}

export const runMixtapeOutput = async (params: {
  payload: MixtapeOutputInput
  control?: MixtapeOutputControl
  onProgress?: (payload: MixtapeOutputProgressPayload) => void
}): Promise<MixtapeOutputResult> => {
  const payload = params.payload || {}
  ensureNotCancelled(params.control)
  const outputDir = typeof payload.outputPath === 'string' ? payload.outputPath.trim() : ''
  if (!outputDir) {
    throw new Error('mixtape.outputPathRequired')
  }
  const outputFormat: MixtapeOutputFormat = payload.outputFormat === 'mp3' ? 'mp3' : 'wav'
  const outputFilePath = await resolveOutputFilePath(
    outputDir,
    typeof payload.outputFilename === 'string' ? payload.outputFilename : '',
    outputFormat
  )

  const renderedWavBuffer = toNodeBuffer(payload.wavBytes)
  if (renderedWavBuffer.length > 0) {
    const ffmpegPath = resolveBundledFfmpegPath()
    await ensureExecutableOnMac(ffmpegPath)
    const declaredDuration = Number(payload.durationSec)
    const durationSec =
      Number.isFinite(declaredDuration) && declaredDuration > 0 ? declaredDuration : 0
    params.onProgress?.({
      stageKey: 'mixtape.outputProgressFinalizing',
      done: 98,
      total: 100,
      percent: 98
    })
    ensureNotCancelled(params.control)
    if (outputFormat === 'wav') {
      await fs.writeFile(outputFilePath, renderedWavBuffer)
    } else {
      const tempWavPath = path.join(
        outputDir,
        `.frkb-mixtape-output-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`
      )
      try {
        await fs.writeFile(tempWavPath, renderedWavBuffer)
        await transcodeWavToMp3(
          ffmpegPath,
          tempWavPath,
          outputFilePath,
          durationSec,
          params.control,
          params.onProgress
        )
      } finally {
        await fs.remove(tempWavPath).catch(() => {})
      }
    }

    return {
      outputPath: outputFilePath,
      trackCount: 0
    }
  }

  const tracks = Array.isArray(payload.tracks) ? payload.tracks : []
  const normalizedTracks = await normalizeTracks(tracks)
  if (!normalizedTracks.length) {
    throw new Error('mixtape.outputNoTracks')
  }

  const estimatedDurationSec = resolveEstimatedDurationSec(normalizedTracks)
  ensureNotCancelled(params.control)
  params.onProgress?.({
    stageKey: 'mixtape.outputProgressPreparing',
    done: 2,
    total: 100,
    percent: 2
  })

  const ffmpegPath = resolveBundledFfmpegPath()
  await ensureExecutableOnMac(ffmpegPath)
  params.onProgress?.({
    stageKey: 'mixtape.outputProgressRendering',
    done: 5,
    total: 100,
    percent: 5
  })

  await runFfmpegMix(
    ffmpegPath,
    normalizedTracks,
    outputFilePath,
    outputFormat,
    estimatedDurationSec,
    params.control,
    params.onProgress
  )

  params.onProgress?.({
    stageKey: 'mixtape.outputProgressFinalizing',
    done: 98,
    total: 100,
    percent: 98
  })

  return {
    outputPath: outputFilePath,
    trackCount: normalizedTracks.length
  }
}
