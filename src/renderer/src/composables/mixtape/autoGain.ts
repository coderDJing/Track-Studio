import { RendererFilePathMap, RendererFilePathSet } from '@renderer/utils/filePathComparison'
import { resolveTempoRatioByBpm } from '@renderer/composables/mixtape/beatSyncModel'
import {
  buildFlatGainEnvelope,
  dbToLinearGain,
  MIXTAPE_GAIN_KNOB_MAX_DB,
  MIXTAPE_GAIN_KNOB_MIN_DB
} from '@renderer/composables/mixtape/gainEnvelope'
import type { MixtapeGainPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'
import { canPlayHtmlAudio, toPreviewUrl } from '@renderer/pages/modules/songPlayer/webAudioPlayer'

type LoudnessAnalysis = {
  durationSec: number
  integratedDb: number
  peakDb: number
}

type TrackGainPlan = {
  trackId: string
  filePath: string
  title: string
  timelineDurationSec: number
  integratedDb: number
  peakDb: number
  analysis: LoudnessAnalysis | null
}

export type AutoGainAnalysisSnapshot = {
  trackSetKey: string
  uniquePaths: string[]
  analysisMap: Map<string, LoudnessAnalysis | null>
}

type ReferencePickMode = 'loudest' | 'quietest'

type PickReferenceTrackIdResult = {
  trackId: string
  analysisSnapshot: AutoGainAnalysisSnapshot
}

const AUTO_GAIN_MIN_DB = MIXTAPE_GAIN_KNOB_MIN_DB
const AUTO_GAIN_MAX_DB = MIXTAPE_GAIN_KNOB_MAX_DB
const LOUDNESS_FLOOR_DB = -70
const EPSILON = 1e-9

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const parseDurationToSeconds = (input: string) => {
  if (!input) return 0
  const parts = String(input)
    .trim()
    .split(':')
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value))
  if (!parts.length) return 0
  if (parts.length === 1) return Math.max(0, parts[0])
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1])
  return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2])
}

const resolveTrackSetKey = (tracks: MixtapeTrack[]) =>
  Array.from(
    new RendererFilePathSet(
      tracks.map((track) => String(track.filePath || '').trim()).filter(Boolean)
    )
  )
    .sort((a, b) => a.localeCompare(b))
    .join('|')

const normalizePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) return new Float32Array(0)
  if (pcmData instanceof Float32Array) return pcmData
  if (pcmData instanceof ArrayBuffer) return new Float32Array(pcmData)
  if (ArrayBuffer.isView(pcmData)) {
    const view = pcmData as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

const createBufferFromIpcPayload = (
  audioCtx: AudioContext,
  payload: {
    pcmData: unknown
    sampleRate?: number
    channels?: number
    totalFrames?: number
  }
) => {
  const pcm = normalizePcmData(payload?.pcmData)
  const sampleRate = Number(payload?.sampleRate) || 44100
  const channels = Math.max(1, Number(payload?.channels) || 1)
  const totalFrames = Number(payload?.totalFrames) || 0
  const frameCount =
    totalFrames > 0
      ? Math.min(totalFrames, Math.floor(pcm.length / channels))
      : Math.floor(pcm.length / channels)
  if (frameCount <= 0 || pcm.length === 0) return null
  const buffer = audioCtx.createBuffer(channels, frameCount, sampleRate)
  for (let ch = 0; ch < channels; ch += 1) {
    const channelData = buffer.getChannelData(ch)
    let readIndex = ch
    for (let index = 0; index < frameCount; index += 1) {
      channelData[index] = pcm[readIndex] || 0
      readIndex += channels
    }
  }
  return buffer
}

const decodeAudioBuffer = async (
  audioCtx: AudioContext,
  filePath: string
): Promise<AudioBuffer | null> => {
  if (!filePath) return null
  if (canPlayHtmlAudio(filePath)) {
    try {
      const response = await fetch(toPreviewUrl(filePath))
      if (!response.ok) throw new Error(`fetch failed: ${response.status}`)
      const arrayBuffer = await response.arrayBuffer()
      if (!arrayBuffer.byteLength) throw new Error('empty file buffer')
      return await audioCtx.decodeAudioData(arrayBuffer)
    } catch {
      // 回退到 IPC 解码，覆盖浏览器不兼容/解码失败场景
    }
  }
  if (!window?.electron?.ipcRenderer?.invoke) return null
  try {
    const payload = await window.electron.ipcRenderer.invoke(
      'mixtape:decode-for-transport',
      filePath
    )
    return createBufferFromIpcPayload(audioCtx, payload)
  } catch {
    return null
  }
}

const analyzeBufferLoudness = (buffer: AudioBuffer): LoudnessAnalysis => {
  const sampleRate = Math.max(1, Number(buffer.sampleRate) || 44100)
  const frameCount = Math.max(0, Number(buffer.length) || 0)
  const channelCount = Math.max(1, Number(buffer.numberOfChannels) || 1)
  const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index))

  let totalEnergy = 0
  let peak = 0

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sample = 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      sample += channels[channel][frame] || 0
    }
    sample /= channelCount
    const absSample = Math.abs(sample)
    if (absSample > peak) peak = absSample
    totalEnergy += sample * sample
  }

  const integratedMeanSquare = frameCount > 0 ? totalEnergy / frameCount : EPSILON
  const integratedDb = Math.max(
    LOUDNESS_FLOOR_DB,
    10 * Math.log10(Math.max(EPSILON, integratedMeanSquare))
  )
  const peakDb = 20 * Math.log10(Math.max(EPSILON, peak))

  return {
    durationSec: frameCount / sampleRate,
    integratedDb,
    peakDb
  }
}

const resolveTempoRatio = (track: MixtapeTrack) => {
  const targetBpm = Number(track.bpm)
  const originalBpm = Number(track.originalBpm)
  return resolveTempoRatioByBpm(targetBpm, originalBpm)
}

const resolveTrackStartAndDurations = (
  tracks: MixtapeTrack[],
  analysisMap: Map<string, LoudnessAnalysis | null>
) => {
  const plan: TrackGainPlan[] = []
  for (const track of tracks) {
    const filePath = String(track.filePath || '').trim()
    if (!filePath) continue
    const analysis = analysisMap.get(filePath) || null
    const sourceDurationSec = Math.max(
      0,
      analysis?.durationSec || parseDurationToSeconds(track.duration || '')
    )
    const tempoRatio = resolveTempoRatio(track)
    const timelineDurationSec =
      sourceDurationSec > 0 ? sourceDurationSec / Math.max(0.01, tempoRatio) : 0
    plan.push({
      trackId: track.id,
      filePath,
      title: track.title || filePath.split(/[\\/]/).pop() || filePath,
      timelineDurationSec,
      integratedDb: analysis?.integratedDb ?? 0,
      peakDb: analysis?.peakDb ?? -6,
      analysis
    })
  }
  return plan
}

const buildTrackTitleByPath = (tracks: MixtapeTrack[]) => {
  const titleByPath = new RendererFilePathMap<string>()
  for (const track of tracks) {
    const filePath = String(track.filePath || '').trim()
    if (!filePath || titleByPath.has(filePath)) continue
    titleByPath.set(filePath, track.title || filePath.split(/[\\/]/).pop() || filePath)
  }
  return titleByPath
}

const analyzeTrackLoudnessByPath = async (params: {
  tracks: MixtapeTrack[]
  onProgress?: (payload: ProgressPayload) => void
}) => {
  const tracks = Array.isArray(params.tracks) ? params.tracks : []
  const uniquePaths = Array.from(
    new RendererFilePathSet(
      tracks.map((track) => String(track.filePath || '').trim()).filter(Boolean)
    )
  )
  const analysisMap = new RendererFilePathMap<LoudnessAnalysis | null>()
  if (!uniquePaths.length) {
    return { analysisMap, uniquePaths }
  }

  const titleByPath = buildTrackTitleByPath(tracks)
  let audioCtx: AudioContext | null = null
  let doneCount = 0
  try {
    audioCtx = new AudioContext()
    // 注册到全局列表，窗口关闭时可立即挂起所有 AudioContext
    const contexts = (window.__FRKB_AUDIO_CONTEXTS__ ??= [])
    contexts.push(audioCtx)
    await runWithConcurrency(uniquePaths, 2, async (filePath) => {
      const buffer = await decodeAudioBuffer(audioCtx!, filePath)
      if (buffer) {
        analysisMap.set(filePath, analyzeBufferLoudness(buffer))
      } else {
        analysisMap.set(filePath, null)
      }
      doneCount += 1
      params.onProgress?.({
        done: doneCount,
        total: uniquePaths.length,
        currentTitle: titleByPath.get(filePath) || filePath
      })
    })
  } finally {
    if (audioCtx && audioCtx.state !== 'closed') {
      try {
        await audioCtx.close()
      } catch {}
    }
  }

  return { analysisMap, uniquePaths }
}

const resolveLoudnessAnalysisSnapshot = async (params: {
  tracks: MixtapeTrack[]
  onProgress?: (payload: ProgressPayload) => void
  analysisSnapshot?: AutoGainAnalysisSnapshot
}) => {
  const tracks = Array.isArray(params.tracks) ? params.tracks : []
  const trackSetKey = resolveTrackSetKey(tracks)
  const cached = params.analysisSnapshot
  if (cached && cached.trackSetKey === trackSetKey) {
    return {
      analysisMap: cached.analysisMap,
      uniquePaths: cached.uniquePaths,
      analysisSnapshot: cached
    }
  }

  const { analysisMap, uniquePaths } = await analyzeTrackLoudnessByPath({
    tracks,
    onProgress: params.onProgress
  })
  const analysisSnapshot: AutoGainAnalysisSnapshot = {
    trackSetKey,
    uniquePaths,
    analysisMap
  }
  return {
    analysisMap,
    uniquePaths,
    analysisSnapshot
  }
}

const buildTrimEnvelopeForTrack = (params: {
  trackPlan: TrackGainPlan
  referencePlan: TrackGainPlan
}) => {
  const { trackPlan, referencePlan } = params
  const durationSec = trackPlan.timelineDurationSec
  if (durationSec <= 0) {
    return buildFlatGainEnvelope(durationSec, 1)
  }
  if (!trackPlan.analysis || !referencePlan.analysis) {
    return buildFlatGainEnvelope(durationSec, 1)
  }
  if (trackPlan.trackId === referencePlan.trackId) {
    return buildFlatGainEnvelope(durationSec, 1)
  }

  // DJ Trim 方式：参考曲锁定，每首歌只算一次固定增益，只受旋钮范围约束。
  const trimGainDb = referencePlan.integratedDb - trackPlan.integratedDb
  const safeGainDb = clampNumber(trimGainDb, AUTO_GAIN_MIN_DB, AUTO_GAIN_MAX_DB)
  const safeGainLinear = Number(dbToLinearGain(safeGainDb).toFixed(6))
  return buildFlatGainEnvelope(durationSec, safeGainLinear)
}

type ProgressPayload = {
  done: number
  total: number
  currentTitle: string
}

type AutoGainResultItem = {
  trackId: string
  filePath: string
  points: MixtapeGainPoint[] // 两点平直包络
}

const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) => {
  let cursor = 0
  const runner = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index], index)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runner)
  await Promise.all(workers)
}

const pickReferenceTrackId = async (params: {
  tracks: MixtapeTrack[]
  mode: ReferencePickMode
  analysisSnapshot?: AutoGainAnalysisSnapshot
  onProgress?: (payload: ProgressPayload) => void
}) => {
  const tracks = Array.isArray(params.tracks) ? params.tracks : []
  if (!tracks.length) {
    return {
      trackId: '',
      analysisSnapshot: {
        trackSetKey: '',
        uniquePaths: [],
        analysisMap: new RendererFilePathMap<LoudnessAnalysis | null>()
      }
    } as PickReferenceTrackIdResult
  }

  const { analysisMap, analysisSnapshot } = await resolveLoudnessAnalysisSnapshot({
    tracks,
    analysisSnapshot: params.analysisSnapshot,
    onProgress: params.onProgress
  })

  let bestTrackId = ''
  let bestIntegratedDb = params.mode === 'loudest' ? -Infinity : Infinity
  let bestPeakDb = params.mode === 'loudest' ? -Infinity : Infinity

  for (const track of tracks) {
    const trackId = String(track.id || '').trim()
    const filePath = String(track.filePath || '').trim()
    if (!trackId || !filePath) continue
    const analysis = analysisMap.get(filePath)
    if (!analysis) continue
    const integratedDb = Number(analysis.integratedDb)
    const peakDb = Number(analysis.peakDb)
    if (!Number.isFinite(integratedDb)) continue
    const isBetterIntegrated =
      params.mode === 'loudest'
        ? integratedDb > bestIntegratedDb + 0.0001
        : integratedDb < bestIntegratedDb - 0.0001
    const isTieButPeakBetter =
      Math.abs(integratedDb - bestIntegratedDb) <= 0.0001 &&
      (params.mode === 'loudest' ? peakDb > bestPeakDb + 0.0001 : peakDb < bestPeakDb - 0.0001)
    if (isBetterIntegrated || isTieButPeakBetter || !bestTrackId) {
      bestTrackId = trackId
      bestIntegratedDb = integratedDb
      bestPeakDb = Number.isFinite(peakDb)
        ? peakDb
        : params.mode === 'loudest'
          ? -Infinity
          : Infinity
    }
  }

  return {
    trackId: bestTrackId || String(tracks[0]?.id || ''),
    analysisSnapshot
  } as PickReferenceTrackIdResult
}

export const pickLoudestReferenceTrackId = async (params: {
  tracks: MixtapeTrack[]
  analysisSnapshot?: AutoGainAnalysisSnapshot
  onProgress?: (payload: ProgressPayload) => void
}) => {
  return pickReferenceTrackId({
    tracks: params.tracks,
    mode: 'loudest',
    analysisSnapshot: params.analysisSnapshot,
    onProgress: params.onProgress
  })
}

export const pickQuietestReferenceTrackId = async (params: {
  tracks: MixtapeTrack[]
  analysisSnapshot?: AutoGainAnalysisSnapshot
  onProgress?: (payload: ProgressPayload) => void
}) => {
  return pickReferenceTrackId({
    tracks: params.tracks,
    mode: 'quietest',
    analysisSnapshot: params.analysisSnapshot,
    onProgress: params.onProgress
  })
}

export const buildAutoGainEnvelopes = async (params: {
  tracks: MixtapeTrack[]
  referenceTrackId: string
  analysisSnapshot?: AutoGainAnalysisSnapshot
  onProgress?: (payload: ProgressPayload) => void
}) => {
  const tracks = Array.isArray(params.tracks) ? params.tracks : []
  if (!tracks.length || !params.referenceTrackId) {
    return [] as AutoGainResultItem[]
  }
  const { analysisMap, uniquePaths } = await resolveLoudnessAnalysisSnapshot({
    tracks,
    analysisSnapshot: params.analysisSnapshot,
    onProgress: params.onProgress
  })
  if (!uniquePaths.length) {
    return tracks.map((track) => ({
      trackId: track.id,
      filePath: track.filePath,
      points: buildFlatGainEnvelope(0, 1)
    }))
  }

  const trackPlan = resolveTrackStartAndDurations(tracks, analysisMap)
  const referencePlan = trackPlan.find((item) => item.trackId === params.referenceTrackId)
  if (!referencePlan) {
    return trackPlan.map((item) => ({
      trackId: item.trackId,
      filePath: item.filePath,
      points: buildFlatGainEnvelope(item.timelineDurationSec, 1)
    }))
  }

  return trackPlan.map((item) => ({
    trackId: item.trackId,
    filePath: item.filePath,
    points: buildTrimEnvelopeForTrack({
      trackPlan: item,
      referencePlan
    })
  }))
}
