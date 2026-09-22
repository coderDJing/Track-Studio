import { existsSync } from 'node:fs'
import path from 'node:path'
import * as ort from 'onnxruntime-node'
import {
  buildSongEnergyScoreFromArousal,
  normalizeSongEnergyScore,
  type SongEnergyAnalysisV5,
  type SongEnergyCurvePoint,
  type SongEnergyCurveRole,
  type SongEnergyScorePayload
} from '../../shared/songEnergy'

export const SONG_ENERGY_MODEL_SAMPLE_RATE = 16000
export const SONG_ENERGY_MODEL_CHANNELS = 1

const FFT_SIZE = 512
const FFT_HALF_SIZE = FFT_SIZE / 2
const SPECTRUM_SIZE = FFT_HALF_SIZE + 1
const FRAME_HOP_SIZE = 256
const MEL_BAND_COUNT = 96
const PATCH_FRAME_COUNT = 187
const PATCH_HOP_FRAMES = 93
const SUSTAINED_WINDOW_SECONDS = 24
const SUSTAINED_WINDOW_PATCHES = Math.max(
  1,
  Math.round(
    SUSTAINED_WINDOW_SECONDS / ((PATCH_HOP_FRAMES * FRAME_HOP_SIZE) / SONG_ENERGY_MODEL_SAMPLE_RATE)
  )
)
const MODEL_BATCH_SIZE = 16
const MIN_ACTIVE_PATCH_RMS = 0.001
const SEGMENT_SECONDS = 12
const MIN_SEGMENT_SECONDS = 8
const MAX_SEGMENT_SECONDS = 16
const SEGMENT_EDGE_RATIO = 0.08
const RHYTHMIC_FLUX_REFERENCE = 0.1
const MODEL_DIRECTORY_PARTS = ['resources', 'models', 'song-energy'] as const
const EMBEDDING_MODEL_FILE = 'msd-musicnn-1.onnx'
const DEAM_MODEL_FILE = 'deam-msd-musicnn-2.onnx'
const EMOMUSIC_MODEL_FILE = 'emomusic-msd-musicnn-2.onnx'
const EMBEDDING_INPUT = 'melspectrogram'
const EMBEDDING_OUTPUT = 'embeddings'
const AROUSAL_INPUT = 'model/Placeholder:0'
const AROUSAL_OUTPUT = 'model/Identity:0'

type MelFilter = {
  startBin: number
  coefficients: Float64Array
}

type SongEnergyModelSessions = {
  embedding: ort.InferenceSession
  deam: ort.InferenceSession
  emomusic: ort.InferenceSession
}

export type SongEnergyModelResult = SongEnergyScorePayload & {
  analysis: SongEnergyAnalysisV5
}

let modelSessionsPromise: Promise<SongEnergyModelSessions> | null = null

const hannWindow = Float64Array.from(
  { length: FFT_SIZE },
  (_, index) => 0.5 * (1 - Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1)))
)

const bitReversedIndices = (() => {
  const result = new Uint16Array(FFT_SIZE)
  const bitCount = Math.log2(FFT_SIZE)
  for (let index = 0; index < FFT_SIZE; index += 1) {
    let source = index
    let reversed = 0
    for (let bit = 0; bit < bitCount; bit += 1) {
      reversed = (reversed << 1) | (source & 1)
      source >>= 1
    }
    result[index] = reversed
  }
  return result
})()

const hzToSlaneyMel = (frequency: number) => {
  const linearStep = 200 / 3
  if (frequency < 1000) return frequency / linearStep
  const minimumLogMel = 1000 / linearStep
  const logStep = Math.log(6.4) / 27
  return minimumLogMel + Math.log(frequency / 1000) / logStep
}

const slaneyMelToHz = (mel: number) => {
  const linearStep = 200 / 3
  const minimumLogMel = 1000 / linearStep
  if (mel < minimumLogMel) return mel * linearStep
  const logStep = Math.log(6.4) / 27
  return 1000 * Math.exp(logStep * (mel - minimumLogMel))
}

const melFilters = (() => {
  const pointCount = MEL_BAND_COUNT + 2
  const maximumMel = hzToSlaneyMel(SONG_ENERGY_MODEL_SAMPLE_RATE / 2)
  const frequencies = Float64Array.from({ length: pointCount }, (_, index) =>
    slaneyMelToHz((index * maximumMel) / (pointCount - 1))
  )

  const filters: MelFilter[] = []
  for (let bandIndex = 0; bandIndex < MEL_BAND_COUNT; bandIndex += 1) {
    const left = frequencies[bandIndex]
    const center = frequencies[bandIndex + 1]
    const right = frequencies[bandIndex + 2]
    const startBin = Math.max(0, Math.ceil((left * FFT_SIZE) / SONG_ENERGY_MODEL_SAMPLE_RATE))
    const endBin = Math.min(
      SPECTRUM_SIZE - 1,
      Math.floor((right * FFT_SIZE) / SONG_ENERGY_MODEL_SAMPLE_RATE)
    )
    const coefficients = new Float64Array(Math.max(0, endBin - startBin + 1))
    const slaneyNormalization = 2 / (right - left)
    for (let bin = startBin; bin <= endBin; bin += 1) {
      const frequency = (bin * SONG_ENERGY_MODEL_SAMPLE_RATE) / FFT_SIZE
      const triangle =
        frequency <= center
          ? (frequency - left) / (center - left)
          : (right - frequency) / (right - center)
      coefficients[bin - startBin] = Math.max(0, triangle) * slaneyNormalization
    }
    filters.push({ startBin, coefficients })
  }
  return filters
})()

const toFloat32Samples = (value: ArrayBuffer | ArrayBufferView): Float32Array => {
  if (value instanceof Float32Array) return value
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  const usableBytes = Math.floor(value.byteLength / 4) * 4
  if (usableBytes <= 0) return new Float32Array()
  if (value.byteOffset % 4 === 0 && usableBytes === value.byteLength) {
    return new Float32Array(value.buffer, value.byteOffset, usableBytes / 4)
  }
  const copy = new Uint8Array(usableBytes)
  copy.set(new Uint8Array(value.buffer, value.byteOffset, usableBytes))
  return new Float32Array(copy.buffer)
}

const normalizeEnergyInputLevel = (samples: Float32Array) => {
  const blockSize = Math.max(1, Math.round(0.4 * SONG_ENERGY_MODEL_SAMPLE_RATE))
  const blockHop = Math.max(1, Math.round(0.1 * SONG_ENERGY_MODEL_SAMPLE_RATE))
  const blockRms: number[] = []
  let truePeak = 0
  for (let index = 0; index < samples.length; index += 1) {
    truePeak = Math.max(truePeak, Math.abs(Number(samples[index]) || 0))
  }
  for (let start = 0; start + blockSize <= samples.length; start += blockHop) {
    let sumSquares = 0
    for (let index = start; index < start + blockSize; index += 1) {
      const sample = Number(samples[index]) || 0
      sumSquares += sample * sample
    }
    const rms = Math.sqrt(sumSquares / blockSize)
    if (rms > 1e-5) blockRms.push(rms)
  }
  if (blockRms.length <= 0) return { samples, loudnessDb: -100, truePeakDb: -100 }
  const ungatedPower = mean(blockRms.map((value) => value * value))
  const gatePower = ungatedPower * 0.1
  const gated = blockRms.filter((value) => value * value >= gatePower)
  const integratedPower = mean((gated.length > 0 ? gated : blockRms).map((value) => value * value))
  const loudnessDb = 20 * Math.log10(Math.max(1e-5, Math.sqrt(integratedPower)))
  const truePeakDb = 20 * Math.log10(Math.max(1e-5, truePeak))
  const targetDb = -18
  const unclampedGain = 10 ** ((targetDb - loudnessDb) / 20)
  const gain = Math.max(0.5, Math.min(2.5, unclampedGain))
  const safeGain = truePeak > 0 ? Math.min(gain, 0.98 / truePeak) : gain
  if (Math.abs(safeGain - 1) < 0.01) return { samples, loudnessDb, truePeakDb }
  const normalized = Float32Array.from(samples, (sample) => sample * safeGain)
  return { samples: normalized, loudnessDb, truePeakDb }
}

const transformRealFft = (real: Float64Array, imaginary: Float64Array) => {
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const reversedIndex = bitReversedIndices[index]
    if (reversedIndex <= index) continue
    const realValue = real[index]
    real[index] = real[reversedIndex]
    real[reversedIndex] = realValue
  }

  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const halfSize = size / 2
    const angle = (-2 * Math.PI) / size
    const phaseStepReal = Math.cos(angle)
    const phaseStepImaginary = Math.sin(angle)
    for (let start = 0; start < FFT_SIZE; start += size) {
      let phaseReal = 1
      let phaseImaginary = 0
      for (let offset = 0; offset < halfSize; offset += 1) {
        const evenIndex = start + offset
        const oddIndex = evenIndex + halfSize
        const oddReal = real[oddIndex] * phaseReal - imaginary[oddIndex] * phaseImaginary
        const oddImaginary = real[oddIndex] * phaseImaginary + imaginary[oddIndex] * phaseReal
        const evenReal = real[evenIndex]
        const evenImaginary = imaginary[evenIndex]
        real[evenIndex] = evenReal + oddReal
        imaginary[evenIndex] = evenImaginary + oddImaginary
        real[oddIndex] = evenReal - oddReal
        imaginary[oddIndex] = evenImaginary - oddImaginary
        const nextPhaseReal = phaseReal * phaseStepReal - phaseImaginary * phaseStepImaginary
        phaseImaginary = phaseReal * phaseStepImaginary + phaseImaginary * phaseStepReal
        phaseReal = nextPhaseReal
      }
    }
  }
}

export const buildSongEnergyMelFrames = (samples: Float32Array) => {
  const frameCount = Math.floor(samples.length / FRAME_HOP_SIZE) + 1
  const frames = new Float32Array(frameCount * MEL_BAND_COUNT)
  const real = new Float64Array(FFT_SIZE)
  const imaginary = new Float64Array(FFT_SIZE)
  const powerSpectrum = new Float64Array(SPECTRUM_SIZE)

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const sampleStart = frameIndex * FRAME_HOP_SIZE - FFT_HALF_SIZE
    for (let index = 0; index < FFT_SIZE; index += 1) {
      const sample = samples[sampleStart + index] ?? 0
      real[index] = (Number.isFinite(sample) ? sample : 0) * hannWindow[index]
      imaginary[index] = 0
    }
    transformRealFft(real, imaginary)
    for (let bin = 0; bin < SPECTRUM_SIZE; bin += 1) {
      powerSpectrum[bin] = real[bin] * real[bin] + imaginary[bin] * imaginary[bin]
    }

    const outputOffset = frameIndex * MEL_BAND_COUNT
    for (let bandIndex = 0; bandIndex < MEL_BAND_COUNT; bandIndex += 1) {
      const filter = melFilters[bandIndex]
      let melPower = 0
      for (let index = 0; index < filter.coefficients.length; index += 1) {
        melPower += powerSpectrum[filter.startBin + index] * filter.coefficients[index]
      }
      frames[outputOffset + bandIndex] = Math.log10(1 + 10000 * Math.max(0, melPower))
    }
  }
  return { frames, frameCount }
}

const calculatePatchRms = (samples: Float32Array, patchStartFrame: number) => {
  const startSample = Math.max(0, patchStartFrame * FRAME_HOP_SIZE - FFT_HALF_SIZE)
  const endSample = Math.min(
    samples.length,
    patchStartFrame * FRAME_HOP_SIZE + (PATCH_FRAME_COUNT - 1) * FRAME_HOP_SIZE + FFT_HALF_SIZE
  )
  let sumSquares = 0
  let count = 0
  for (let index = startSample; index < endSample; index += 1) {
    const sample = samples[index]
    if (!Number.isFinite(sample)) continue
    sumSquares += sample * sample
    count += 1
  }
  return count > 0 ? Math.sqrt(sumSquares / count) : 0
}

const collectActivePatchStarts = (samples: Float32Array, frameCount: number): number[] => {
  const starts: number[] = []
  for (
    let startFrame = 0;
    startFrame + PATCH_FRAME_COUNT <= frameCount;
    startFrame += PATCH_HOP_FRAMES
  ) {
    if (calculatePatchRms(samples, startFrame) >= MIN_ACTIVE_PATCH_RMS) {
      starts.push(startFrame)
    }
  }
  return starts
}

export const aggregateSongArousal = (values: readonly number[]): number | null => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length <= 0) return null
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

const mean = (values: readonly number[]) =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

const percentile = (values: readonly number[], ratio: number) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length <= 0) return 0
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

const calculateSustainedArousal = (values: readonly number[], starts: readonly number[]) => {
  if (values.length <= 0 || values.length !== starts.length) return null
  let best = Number.NEGATIVE_INFINITY
  let runStart = 0

  const inspectRun = (start: number, end: number) => {
    const runLength = end - start
    if (runLength <= 0) return
    const windowSize = Math.min(SUSTAINED_WINDOW_PATCHES, runLength)
    let windowSum = 0
    for (let index = start; index < start + windowSize; index += 1) {
      windowSum += values[index]
    }
    best = Math.max(best, windowSum / windowSize)
    for (let index = start + windowSize; index < end; index += 1) {
      windowSum += values[index] - values[index - windowSize]
      best = Math.max(best, windowSum / windowSize)
    }
  }

  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] - starts[index - 1] === PATCH_HOP_FRAMES) continue
    inspectRun(runStart, index)
    runStart = index
  }
  inspectRun(runStart, starts.length)
  return Number.isFinite(best) ? best : null
}

const arousalToScore = (value: number) => buildSongEnergyScoreFromArousal(value)?.energyScore ?? 0

export const summarizeSongEnergyPredictions = (params: {
  deam: readonly number[]
  emomusic: readonly number[]
  patchStarts: readonly number[]
}): SongEnergyAnalysisV5 | null => {
  if (
    params.deam.length <= 0 ||
    params.deam.length !== params.emomusic.length ||
    params.deam.length !== params.patchStarts.length
  ) {
    return null
  }
  const ensemble = params.deam.map((value, index) => (value + params.emomusic[index]) / 2)
  if (!ensemble.every(Number.isFinite)) return null
  const sustainedArousal = calculateSustainedArousal(ensemble, params.patchStarts)
  const medianArousal = aggregateSongArousal(ensemble)
  if (sustainedArousal === null || medianArousal === null) return null

  const disagreements = params.deam.map((value, index) => Math.abs(value - params.emomusic[index]))
  const adjacentChanges = ensemble.slice(1).map((value, index) => Math.abs(value - ensemble[index]))
  const disagreementPenalty = Math.min(40, mean(disagreements) * 20)
  const instabilityPenalty = Math.min(25, (aggregateSongArousal(adjacentChanges) ?? 0) * 20)
  const lowEvidencePenalty = Math.max(0, SUSTAINED_WINDOW_PATCHES - ensemble.length) * 1.5
  const confidence = normalizeSongEnergyScore(
    100 - disagreementPenalty - instabilityPenalty - lowEvidencePenalty
  )
  const lowArousal = percentile(ensemble, 0.1)
  const highArousal = percentile(ensemble, 0.9)

  return {
    version: 5,
    model: 'musicnn-deam-emomusic',
    sustainedScore: arousalToScore(sustainedArousal),
    averageScore: arousalToScore(mean(ensemble)),
    medianScore: arousalToScore(medianArousal),
    peakScore: arousalToScore(highArousal),
    rangeScore: normalizeSongEnergyScore(((highArousal - lowArousal) / 8) * 100) ?? 0,
    confidence: confidence ?? 0,
    patchCount: ensemble.length
  }
}

const resolveModelDirectory = () => {
  const resourceRoot = process.resourcesPath || ''
  const candidates = [
    path.resolve(process.cwd(), ...MODEL_DIRECTORY_PARTS),
    path.resolve(resourceRoot, 'app.asar.unpacked', ...MODEL_DIRECTORY_PARTS),
    path.resolve(resourceRoot, ...MODEL_DIRECTORY_PARTS)
  ]
  const resolved = candidates.find(
    (candidate) =>
      existsSync(path.join(candidate, EMBEDDING_MODEL_FILE)) &&
      existsSync(path.join(candidate, DEAM_MODEL_FILE)) &&
      existsSync(path.join(candidate, EMOMUSIC_MODEL_FILE))
  )
  if (!resolved) {
    throw new Error(`song energy models missing: ${candidates.join(', ')}`)
  }
  return resolved
}

const loadModelSessions = async (): Promise<SongEnergyModelSessions> => {
  const modelDirectory = resolveModelDirectory()
  const sessionOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all'
  }
  const [embedding, deam, emomusic] = await Promise.all([
    ort.InferenceSession.create(path.join(modelDirectory, EMBEDDING_MODEL_FILE), sessionOptions),
    ort.InferenceSession.create(path.join(modelDirectory, DEAM_MODEL_FILE), sessionOptions),
    ort.InferenceSession.create(path.join(modelDirectory, EMOMUSIC_MODEL_FILE), sessionOptions)
  ])
  return { embedding, deam, emomusic }
}

const getModelSessions = () => {
  if (!modelSessionsPromise) {
    modelSessionsPromise = loadModelSessions().catch((error) => {
      modelSessionsPromise = null
      throw error
    })
  }
  return modelSessionsPromise
}

const readFloatTensorData = (tensor: ort.Tensor): Float32Array | Float64Array => {
  if (tensor.data instanceof Float32Array || tensor.data instanceof Float64Array) {
    return tensor.data
  }
  throw new Error(`unexpected song energy model tensor type: ${tensor.type}`)
}

const runArousalInference = async (frames: Float32Array, patchStarts: readonly number[]) => {
  const sessions = await getModelSessions()
  const deamPredictions: number[] = []
  const emomusicPredictions: number[] = []
  const valuesPerPatch = PATCH_FRAME_COUNT * MEL_BAND_COUNT

  for (let batchStart = 0; batchStart < patchStarts.length; batchStart += MODEL_BATCH_SIZE) {
    const batchStarts = patchStarts.slice(batchStart, batchStart + MODEL_BATCH_SIZE)
    const inputData = new Float32Array(batchStarts.length * valuesPerPatch)
    for (let patchIndex = 0; patchIndex < batchStarts.length; patchIndex += 1) {
      const sourceStart = batchStarts[patchIndex] * MEL_BAND_COUNT
      inputData.set(
        frames.subarray(sourceStart, sourceStart + valuesPerPatch),
        patchIndex * valuesPerPatch
      )
    }
    const embeddingOutputs = await sessions.embedding.run({
      [EMBEDDING_INPUT]: new ort.Tensor('float32', inputData, [
        batchStarts.length,
        PATCH_FRAME_COUNT,
        MEL_BAND_COUNT
      ])
    })
    const embeddings = embeddingOutputs[EMBEDDING_OUTPUT]
    if (!embeddings) throw new Error('MusiCNN embedding output missing')
    const [deamOutputs, emomusicOutputs] = await Promise.all([
      sessions.deam.run({ [AROUSAL_INPUT]: embeddings }),
      sessions.emomusic.run({ [AROUSAL_INPUT]: embeddings })
    ])
    const deamTensor = deamOutputs[AROUSAL_OUTPUT]
    const emomusicTensor = emomusicOutputs[AROUSAL_OUTPUT]
    if (!deamTensor || !emomusicTensor) throw new Error('song energy arousal output missing')
    const deamData = readFloatTensorData(deamTensor)
    const emomusicData = readFloatTensorData(emomusicTensor)
    if (deamData.length !== batchStarts.length * 2 || emomusicData.length !== deamData.length) {
      throw new Error(
        `unexpected song energy output lengths: ${deamData.length}, ${emomusicData.length}`
      )
    }
    for (let patchIndex = 0; patchIndex < batchStarts.length; patchIndex += 1) {
      deamPredictions.push(Number(deamData[patchIndex * 2 + 1]))
      emomusicPredictions.push(Number(emomusicData[patchIndex * 2 + 1]))
    }
  }
  return { deam: deamPredictions, emomusic: emomusicPredictions }
}

const percentileNumber = (values: readonly number[], ratio: number) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(ratio * sorted.length)))]
}

const clampScore = (value: number) => normalizeSongEnergyScore(value) ?? 0

export const normalizeSongEnergyBeatGrid = (
  bpmValue: unknown,
  firstBeatMsValue: unknown
): { bpm: number; firstBeatMs: number } | null => {
  const bpm = Number(bpmValue)
  const firstBeatMs = Number(firstBeatMsValue)
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(firstBeatMs)) return null
  const beatIntervalMs = 60_000 / bpm
  if (!Number.isFinite(beatIntervalMs) || beatIntervalMs <= 0) return null
  const projectedFirstBeatMs =
    firstBeatMs < 0
      ? firstBeatMs + Math.ceil(-firstBeatMs / beatIntervalMs) * beatIntervalMs
      : firstBeatMs
  return {
    bpm: Number(bpm.toFixed(6)),
    firstBeatMs: Number(Math.max(0, projectedFirstBeatMs).toFixed(3))
  }
}

export const normalizeRhythmicFluxScore = (value: unknown) => {
  const flux = Number(value)
  if (!Number.isFinite(flux) || flux <= 0) return 0
  return clampScore((1 - Math.exp(-flux / RHYTHMIC_FLUX_REFERENCE)) * 100)
}

type SongEnergyBeatValue = {
  beatIndex: number
  rms: number
  low: number
}

const buildSongEnergyBeatValues = (params: {
  frameRms: readonly number[]
  lowBandRatios: readonly number[]
  bpm?: number
  firstBeatMs?: number
}): SongEnergyBeatValue[] | null => {
  const bpm = Number(params.bpm)
  if (!Number.isFinite(bpm) || bpm <= 0 || params.frameRms.length <= 0) return null
  const beatSeconds = 60 / bpm
  const firstBeatSeconds = Math.max(0, Number(params.firstBeatMs || 0) / 1000)
  const beatBuckets = new Map<number, { rms: number; low: number; count: number }>()
  for (let frameIndex = 0; frameIndex < params.frameRms.length; frameIndex += 1) {
    const frameSeconds = (frameIndex * FRAME_HOP_SIZE) / SONG_ENERGY_MODEL_SAMPLE_RATE
    const beatIndex = Math.floor((frameSeconds - firstBeatSeconds) / beatSeconds)
    if (beatIndex < 0) continue
    const bucket = beatBuckets.get(beatIndex) || { rms: 0, low: 0, count: 0 }
    bucket.rms += params.frameRms[frameIndex]
    bucket.low += params.lowBandRatios[frameIndex]
    bucket.count += 1
    beatBuckets.set(beatIndex, bucket)
  }
  const beatValues = Array.from(beatBuckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([beatIndex, bucket]) => ({
      beatIndex,
      rms: bucket.rms / Math.max(1, bucket.count),
      low: bucket.low / Math.max(1, bucket.count)
    }))
  return beatValues.length >= 32 ? beatValues : null
}

const summarizeBeatPhraseTransitions = (params: {
  beatValues: readonly SongEnergyBeatValue[]
  phraseSize?: number
}) => {
  const beatValues = params.beatValues
  if (beatValues.length < 32) return null

  const phraseSize = Math.max(4, Math.round(params.phraseSize ?? 16))
  const phrases: Array<{ rms: number; low: number }> = []
  for (let index = 0; index + phraseSize <= beatValues.length; index += phraseSize) {
    const phrase = beatValues.slice(index, index + phraseSize)
    phrases.push({
      rms: mean(phrase.map((value) => value.rms)),
      low: mean(phrase.map((value) => value.low))
    })
  }
  if (phrases.length < 2) return null

  const phraseRms = phrases.map((phrase) => phrase.rms)
  const typicalRms = Math.max(1e-5, percentileNumber(phraseRms, 0.5))
  const lowBoundary = percentileNumber(phraseRms, 0.35)
  const highBoundary = percentileNumber(phraseRms, 0.65)
  let strongestDrop = 0
  let strongestBreakdown = 0
  for (let index = 1; index < phrases.length; index += 1) {
    const before = phrases[index - 1]
    const after = phrases[index]
    const rmsRise = (after.rms - before.rms) / typicalRms
    const lowRise = after.low - before.low
    const rmsFall = (before.rms - after.rms) / typicalRms
    if (before.rms <= lowBoundary && after.rms >= highBoundary) {
      strongestDrop = Math.max(strongestDrop, rmsRise * 62 + Math.max(0, lowRise) * 90)
    }
    if (before.rms >= highBoundary && after.rms <= lowBoundary) {
      strongestBreakdown = Math.max(strongestBreakdown, rmsFall * 62 + Math.max(0, -lowRise) * 90)
    }
  }
  const phraseDeviation = Math.sqrt(mean(phraseRms.map((value) => (value - typicalRms) ** 2)))
  const phraseStability = clampScore(100 - (phraseDeviation / typicalRms) * 85)
  return {
    dropScore: clampScore(strongestDrop),
    breakdownScore: clampScore(strongestBreakdown),
    phraseStability
  }
}

export type SongEnergyTemporalSegment = {
  startSeconds: number
  endSeconds: number
  modelScore: number
  activityScore: number
  rhythmicScore: number
  lowFrequencyScore: number
}

export type SongEnergyTemporalSummary = {
  representativeScore: number
  sustainedScore: number
  peakScore: number
  rangeScore: number
  dropScore: number
  breakdownScore: number
  mainSectionScore: number
  highEnergyCoverageScore: number
  drivingScore: number
  structureEvidenceScore: number
  dropCount: number
  breakdownCount: number
  confidence: number
  energyCurve: SongEnergyCurvePoint[]
}

const summarizeSegmentRole = (params: {
  index: number
  segmentCount: number
  score: number
  previousScore: number
  lowBoundary: number
  highBoundary: number
}) => {
  const edgeCount =
    params.segmentCount >= 4 ? Math.max(1, Math.floor(params.segmentCount * SEGMENT_EDGE_RATIO)) : 0
  if (edgeCount > 0 && params.index < edgeCount) return 'intro' as const
  if (edgeCount > 0 && params.index >= params.segmentCount - edgeCount) return 'outro' as const
  const rise = params.score - params.previousScore
  const fall = params.previousScore - params.score
  if (rise >= 10 && params.score >= params.highBoundary) return 'drop' as const
  if (fall >= 10 && params.score <= params.lowBoundary) return 'breakdown' as const
  if (params.score >= params.highBoundary) return 'high' as const
  if (params.score <= params.lowBoundary) return 'build' as const
  return 'steady' as const
}

export const summarizeSongEnergyTemporalSegments = (
  segments: readonly SongEnergyTemporalSegment[]
): SongEnergyTemporalSummary | null => {
  const validSegments = segments.filter(
    (segment) =>
      Number.isFinite(segment.startSeconds) &&
      Number.isFinite(segment.endSeconds) &&
      segment.endSeconds > segment.startSeconds &&
      [
        segment.modelScore,
        segment.activityScore,
        segment.rhythmicScore,
        segment.lowFrequencyScore
      ].every(Number.isFinite)
  )
  if (validSegments.length <= 0) return null

  const scores = validSegments.map((segment) =>
    clampScore(
      segment.modelScore * 0.68 +
        segment.activityScore * 0.2 +
        segment.rhythmicScore * 0.08 +
        segment.lowFrequencyScore * 0.04
    )
  )
  const lowBoundary = Math.min(100, percentileNumber(scores, 0.35) + 4)
  const highBoundary = Math.max(0, percentileNumber(scores, 0.65) - 4)
  const edgeCount =
    validSegments.length >= 4
      ? Math.max(1, Math.floor(validSegments.length * SEGMENT_EDGE_RATIO))
      : 0
  const coreStart = edgeCount
  const coreEnd = Math.max(coreStart + 1, validSegments.length - edgeCount)
  const coreScores = scores.slice(coreStart, coreEnd)
  const coreMedian = percentileNumber(coreScores, 0.5)
  const upperScores = coreScores.filter((score) => score >= percentileNumber(coreScores, 0.55))
  const upperMean = mean(upperScores.length > 0 ? upperScores : coreScores)
  const sustainedWindow = Math.min(3, coreScores.length)
  let sustainedScore = 0
  for (let index = 0; index <= coreScores.length - sustainedWindow; index += 1) {
    sustainedScore = Math.max(
      sustainedScore,
      mean(coreScores.slice(index, index + sustainedWindow))
    )
  }
  const peakScore = percentileNumber(coreScores, 0.9)
  const rangeScore = clampScore(
    ((percentileNumber(coreScores, 0.9) - percentileNumber(coreScores, 0.1)) / 65) * 100
  )
  const highEnergyThreshold = Math.max(55, coreMedian + 5)
  const highEnergyCoverageScore = clampScore(
    (coreScores.filter((score) => score >= highEnergyThreshold).length /
      Math.max(1, coreScores.length)) *
      220
  )

  const curve: SongEnergyCurvePoint[] = validSegments.map((segment, index) => {
    const previousScore = scores[Math.max(0, index - 1)]
    const nextScore = scores[Math.min(scores.length - 1, index + 1)]
    const smoothedScore = clampScore(previousScore * 0.2 + scores[index] * 0.6 + nextScore * 0.2)
    const role = summarizeSegmentRole({
      index,
      segmentCount: validSegments.length,
      score: smoothedScore,
      previousScore,
      lowBoundary,
      highBoundary
    })
    return {
      timeMs: Math.round((segment.startSeconds + segment.endSeconds) * 500),
      score: smoothedScore,
      role
    }
  })

  const dropStrengths: number[] = []
  const breakdownStrengths: number[] = []
  const evidenceStrengths: number[] = []
  for (let index = Math.max(1, coreStart); index < coreEnd; index += 1) {
    const previousScore = scores[index - 1]
    const currentScore = scores[index]
    const transition = currentScore - previousScore
    const previous = validSegments[index - 1]
    const current = validSegments[index]
    const evidenceRise =
      (current.activityScore - previous.activityScore) * 0.45 +
      (current.rhythmicScore - previous.rhythmicScore) * 0.35 +
      (current.lowFrequencyScore - previous.lowFrequencyScore) * 0.2
    const evidenceFall = -evidenceRise
    if (Math.abs(evidenceRise) >= 5) evidenceStrengths.push(Math.abs(evidenceRise))
    if (
      previousScore <= lowBoundary &&
      currentScore >= highBoundary &&
      transition >= 8 &&
      (evidenceRise >= 5 || transition >= 18)
    ) {
      dropStrengths.push(transition + Math.max(0, evidenceRise) * 0.5)
    }
    if (
      previousScore >= highBoundary &&
      currentScore <= lowBoundary &&
      transition <= -8 &&
      (evidenceFall >= 5 || transition <= -18)
    ) {
      breakdownStrengths.push(-transition + Math.max(0, evidenceFall) * 0.5)
    }
  }
  const strongestDrop = dropStrengths.length > 0 ? Math.max(...dropStrengths) : 0
  const strongestBreakdown = breakdownStrengths.length > 0 ? Math.max(...breakdownStrengths) : 0
  const topDrops = [...dropStrengths].sort((left, right) => right - left).slice(0, 3)
  const topBreakdowns = [...breakdownStrengths].sort((left, right) => right - left).slice(0, 3)
  const dropScore = clampScore(strongestDrop * 2.4 + mean(topDrops) * 0.8)
  const breakdownScore = clampScore(strongestBreakdown * 2.4 + mean(topBreakdowns) * 0.8)
  const dynamicWeight = Math.min(1, rangeScore / 70)
  const positiveSlopes = scores
    .slice(1)
    .map((score, index) => score - scores[index])
    .filter((slope) => slope > 0)
  const drivingScore = clampScore(
    sustainedScore * 0.35 +
      highEnergyCoverageScore * 0.35 +
      mean([...positiveSlopes].sort((left, right) => right - left).slice(0, 3)) * 1.8
  )
  const structureEvidenceScore = clampScore(mean(evidenceStrengths) * 2.5)
  const representativeScore = clampScore(
    coreMedian * (0.42 - dynamicWeight * 0.12) +
      upperMean * (0.34 + dynamicWeight * 0.18) +
      sustainedScore * 0.24 +
      Math.min(12, highEnergyCoverageScore * 0.08)
  )
  const confidence = clampScore(
    Math.min(100, validSegments.length * 8) -
      (validSegments.length < 3 ? 18 : 0) -
      Math.max(0, 25 - highEnergyCoverageScore) * 0.2
  )

  return {
    representativeScore,
    sustainedScore,
    peakScore,
    rangeScore,
    dropScore,
    breakdownScore,
    mainSectionScore: upperMean,
    highEnergyCoverageScore,
    drivingScore,
    structureEvidenceScore,
    dropCount: dropStrengths.length,
    breakdownCount: breakdownStrengths.length,
    confidence,
    energyCurve: curve
  }
}

const buildSongEnergyTemporalSegments = (params: {
  modelScores: readonly number[]
  patchStarts: readonly number[]
  frameRms: readonly number[]
  frameFlux: readonly number[]
  lowBandRatios: readonly number[]
  bpm?: number
  firstBeatMs?: number
}) => {
  if (params.modelScores.length <= 0 || params.modelScores.length !== params.patchStarts.length) {
    return []
  }
  const durationSeconds = (params.frameRms.length * FRAME_HOP_SIZE) / SONG_ENERGY_MODEL_SAMPLE_RATE
  const bpm = Number(params.bpm)
  const segmentSeconds =
    Number.isFinite(bpm) && bpm > 0
      ? Math.max(MIN_SEGMENT_SECONDS, Math.min(MAX_SEGMENT_SECONDS, (16 * 60) / bpm))
      : SEGMENT_SECONDS
  const firstBeatSeconds = Math.max(0, Number(params.firstBeatMs || 0) / 1000)
  const segmentStart = firstBeatSeconds > 0.5 ? 0 : firstBeatSeconds
  const rmsLow = percentileNumber(params.frameRms, 0.1)
  const rmsHigh = Math.max(rmsLow + 1e-5, percentileNumber(params.frameRms, 0.9))
  const fluxLow = percentileNumber(params.frameFlux, 0.2)
  const fluxHigh = Math.max(fluxLow + 1e-5, percentileNumber(params.frameFlux, 0.9))
  const lowBandLow = percentileNumber(params.lowBandRatios, 0.2)
  const lowBandHigh = Math.max(lowBandLow + 1e-5, percentileNumber(params.lowBandRatios, 0.85))
  const segments: SongEnergyTemporalSegment[] = []
  for (
    let startSeconds = segmentStart;
    startSeconds < durationSeconds;
    startSeconds += segmentSeconds
  ) {
    const endSeconds = Math.min(durationSeconds, startSeconds + segmentSeconds)
    const modelValues: number[] = []
    for (let index = 0; index < params.patchStarts.length; index += 1) {
      const patchCenterSeconds =
        (params.patchStarts[index] * FRAME_HOP_SIZE) / SONG_ENERGY_MODEL_SAMPLE_RATE +
        (PATCH_FRAME_COUNT * FRAME_HOP_SIZE) / SONG_ENERGY_MODEL_SAMPLE_RATE / 2
      if (patchCenterSeconds >= startSeconds && patchCenterSeconds < endSeconds) {
        modelValues.push(params.modelScores[index])
      }
    }
    const firstFrame = Math.max(
      0,
      Math.floor((startSeconds * SONG_ENERGY_MODEL_SAMPLE_RATE) / FRAME_HOP_SIZE)
    )
    const lastFrame = Math.min(
      params.frameRms.length,
      Math.max(
        firstFrame + 1,
        Math.ceil((endSeconds * SONG_ENERGY_MODEL_SAMPLE_RATE) / FRAME_HOP_SIZE)
      )
    )
    const rmsValues = params.frameRms.slice(firstFrame, lastFrame)
    const fluxValues = params.frameFlux.slice(firstFrame, lastFrame)
    const lowBandValues = params.lowBandRatios.slice(firstFrame, lastFrame)
    if (modelValues.length <= 0 || rmsValues.length <= 0) continue
    const localRms = mean(rmsValues)
    const localFlux = percentileNumber(fluxValues, 0.8)
    const localLowBand = mean(lowBandValues)
    segments.push({
      startSeconds,
      endSeconds,
      modelScore: mean(modelValues),
      activityScore: clampScore(((localRms - rmsLow) / (rmsHigh - rmsLow)) * 100),
      rhythmicScore: clampScore(((localFlux - fluxLow) / (fluxHigh - fluxLow)) * 100),
      lowFrequencyScore: clampScore(
        ((localLowBand - lowBandLow) / (lowBandHigh - lowBandLow)) * 100
      )
    })
  }
  return segments
}

const summarizeAcousticEnergy = (params: {
  samples: Float32Array
  frames: Float32Array
  frameCount: number
  bpm?: number
  firstBeatMs?: number
}) => {
  const frameRms: number[] = []
  const frameFlux: number[] = []
  const lowBandRatios: number[] = []
  const previousMelBands = new Float64Array(MEL_BAND_COUNT)
  for (let frameIndex = 0; frameIndex < params.frameCount; frameIndex += 1) {
    const sampleStart = Math.max(0, frameIndex * FRAME_HOP_SIZE - FFT_HALF_SIZE)
    const sampleEnd = Math.min(params.samples.length, sampleStart + FFT_SIZE)
    let squareSum = 0
    for (let sampleIndex = sampleStart; sampleIndex < sampleEnd; sampleIndex += 1) {
      const value = Number(params.samples[sampleIndex] || 0)
      squareSum += value * value
    }
    frameRms.push(sampleEnd > sampleStart ? Math.sqrt(squareSum / (sampleEnd - sampleStart)) : 0)
    let totalMelEnergy = 0
    let lowMelEnergy = 0
    let melFlux = 0
    const melOffset = frameIndex * MEL_BAND_COUNT
    for (let bandIndex = 0; bandIndex < MEL_BAND_COUNT; bandIndex += 1) {
      const value = Math.max(0, Number(params.frames[melOffset + bandIndex] || 0))
      totalMelEnergy += value
      if (bandIndex < 14) lowMelEnergy += value
      if (value > previousMelBands[bandIndex]) melFlux += value - previousMelBands[bandIndex]
      previousMelBands[bandIndex] = value
    }
    frameFlux.push(melFlux / Math.max(1, totalMelEnergy))
    lowBandRatios.push(lowMelEnergy / Math.max(1, totalMelEnergy))
  }
  const rmsFloor = percentileNumber(frameRms, 0.2)
  const rmsCeiling = Math.max(rmsFloor + 1e-5, percentileNumber(frameRms, 0.9))
  const activeRatio =
    frameRms.filter((value) => value >= rmsFloor + (rmsCeiling - rmsFloor) * 0.25).length /
    Math.max(1, frameRms.length)
  const rhythmicScore = normalizeRhythmicFluxScore(percentileNumber(frameFlux, 0.8))
  const lowFrequencyScore = clampScore(percentileNumber(lowBandRatios, 0.6) * 135)
  const bpmValue = Number(params.bpm)
  const bpmFit =
    Number.isFinite(bpmValue) && bpmValue > 0
      ? clampScore(
          bpmValue >= 85 && bpmValue <= 175
            ? 100
            : bpmValue < 85
              ? 55 + ((bpmValue - 60) / 25) * 45
              : 100 - ((bpmValue - 175) / 35) * 45
        )
      : 50
  const beatValues = buildSongEnergyBeatValues({
    frameRms,
    lowBandRatios,
    bpm: params.bpm,
    firstBeatMs: params.firstBeatMs
  })
  const beatPhraseScales = beatValues
    ? [4, 8, 16, 32].map((phraseSize) => summarizeBeatPhraseTransitions({ beatValues, phraseSize }))
    : []
  const beatPhrase = beatPhraseScales[2]
  const weightedBeatPhrase = (key: 'dropScore' | 'breakdownScore') => {
    const weights = [0.15, 0.2, 0.4, 0.25]
    return clampScore(
      beatPhraseScales.reduce((sum, value, index) => sum + (value?.[key] ?? 0) * weights[index], 0)
    )
  }
  const danceabilityScore = clampScore(
    bpmFit * 0.25 +
      rhythmicScore * 0.4 +
      activeRatio * 100 * 0.2 +
      (beatPhrase?.phraseStability ?? 50) * 0.15
  )
  const rollingWindow = Math.max(
    1,
    Math.round((8 * SONG_ENERGY_MODEL_SAMPLE_RATE) / FRAME_HOP_SIZE)
  )
  let rollingSum = 0
  let maxRolling = 0
  for (let index = 0; index < frameRms.length; index += 1) {
    rollingSum += frameRms[index]
    if (index >= rollingWindow) rollingSum -= frameRms[index - rollingWindow]
    if (index >= rollingWindow - 1) maxRolling = Math.max(maxRolling, rollingSum / rollingWindow)
  }
  const typicalRms = Math.max(1e-5, percentileNumber(frameRms, 0.5))
  const dropScore = beatPhrase
    ? clampScore(
        weightedBeatPhrase('dropScore') * 0.75 +
          clampScore(((maxRolling / typicalRms - 1) / 2.5) * 100) * 0.25
      )
    : clampScore(((maxRolling / typicalRms - 1) / 2.5) * 100)
  const breakdownScore = beatPhrase
    ? clampScore(
        weightedBeatPhrase('breakdownScore') * 0.75 +
          clampScore(
            ((percentileNumber(frameRms, 0.9) - percentileNumber(frameRms, 0.2)) / typicalRms) * 35
          ) *
            0.25
      )
    : clampScore(
        ((percentileNumber(frameRms, 0.9) - percentileNumber(frameRms, 0.2)) / typicalRms) * 35
      )
  const dancefloorScore = clampScore(
    danceabilityScore * 0.5 + rhythmicScore * 0.2 + lowFrequencyScore * 0.2 + dropScore * 0.1
  )
  return {
    danceabilityScore,
    dancefloorScore,
    dropScore,
    breakdownScore,
    rhythmicScore,
    activeRatio,
    frameRms,
    frameFlux,
    lowBandRatios
  }
}

export const analyzeSongEnergyWithModel = async (params: {
  pcmData: ArrayBuffer | ArrayBufferView
  sampleRate: number
  channels: number
  bpm?: number
  firstBeatMs?: number
}): Promise<SongEnergyModelResult | null> => {
  if (
    params.sampleRate !== SONG_ENERGY_MODEL_SAMPLE_RATE ||
    params.channels !== SONG_ENERGY_MODEL_CHANNELS
  ) {
    throw new Error(`song energy model requires ${SONG_ENERGY_MODEL_SAMPLE_RATE} Hz mono PCM`)
  }
  const rawSamples = toFloat32Samples(params.pcmData)
  const { samples } = normalizeEnergyInputLevel(rawSamples)
  if (samples.length < SONG_ENERGY_MODEL_SAMPLE_RATE * 3) return null
  const { frames, frameCount } = buildSongEnergyMelFrames(samples)
  const patchStarts = collectActivePatchStarts(samples, frameCount)
  if (patchStarts.length <= 0) return null
  const predictions = await runArousalInference(frames, patchStarts)
  const analysis = summarizeSongEnergyPredictions({ ...predictions, patchStarts })
  if (!analysis) return null
  const acoustic = summarizeAcousticEnergy({
    samples,
    frames,
    frameCount,
    bpm: params.bpm,
    firstBeatMs: params.firstBeatMs
  })
  const ensembleScores = predictions.deam.map((value, index) =>
    arousalToScore((value + predictions.emomusic[index]) / 2)
  )
  const temporal = summarizeSongEnergyTemporalSegments(
    buildSongEnergyTemporalSegments({
      modelScores: ensembleScores,
      patchStarts,
      frameRms: acoustic.frameRms,
      frameFlux: acoustic.frameFlux,
      lowBandRatios: acoustic.lowBandRatios,
      bpm: params.bpm,
      firstBeatMs: params.firstBeatMs
    })
  )
  const sustainedEnergy = analysis.sustainedScore
  const structuralScore = temporal?.representativeScore ?? sustainedEnergy
  const dropScore = temporal
    ? clampScore(temporal.dropScore * 0.7 + acoustic.dropScore * 0.3)
    : acoustic.dropScore
  const breakdownScore = temporal
    ? clampScore(temporal.breakdownScore * 0.7 + acoustic.breakdownScore * 0.3)
    : acoustic.breakdownScore
  const dancefloorScore = clampScore(
    acoustic.dancefloorScore * 0.85 +
      dropScore * 0.1 +
      (temporal?.highEnergyCoverageScore ?? 50) * 0.05
  )
  const drivingScore = temporal?.drivingScore ?? acoustic.dancefloorScore
  const combinedScore = clampScore(
    structuralScore * 0.42 +
      sustainedEnergy * 0.28 +
      dancefloorScore * 0.2 +
      acoustic.rhythmicScore * 0.05 +
      drivingScore * 0.05
  )
  const combinedConfidence = clampScore(
    analysis.confidence * 0.65 +
      acoustic.activeRatio * 100 * 0.15 +
      (temporal?.confidence ?? 50) * 0.2 -
      Math.max(0, 35 - (temporal?.structureEvidenceScore ?? 35)) * 0.1 -
      Math.max(0, 40 - acoustic.danceabilityScore) * 0.15
  )
  const enrichedAnalysis: SongEnergyAnalysisV5 = {
    ...analysis,
    version: 11,
    model: 'musicnn-deam-emomusic-structure-v11',
    sustainedScore: combinedScore,
    confidence: combinedConfidence,
    danceabilityScore: acoustic.danceabilityScore,
    dancefloorScore,
    dropScore,
    breakdownScore,
    rhythmicScore: acoustic.rhythmicScore,
    ...(temporal
      ? {
          peakScore: clampScore(analysis.peakScore * 0.65 + temporal.peakScore * 0.35),
          rangeScore: clampScore(analysis.rangeScore * 0.6 + temporal.rangeScore * 0.4),
          mainSectionScore: temporal.mainSectionScore,
          highEnergyCoverageScore: temporal.highEnergyCoverageScore,
          dropCount: temporal.dropCount,
          breakdownCount: temporal.breakdownCount,
          drivingScore: temporal.drivingScore,
          energyCurve: temporal.energyCurve
        }
      : {})
  }
  return {
    energyScore: enrichedAnalysis.sustainedScore,
    energyAlgorithmVersion: enrichedAnalysis.version,
    analysis: enrichedAnalysis
  }
}
