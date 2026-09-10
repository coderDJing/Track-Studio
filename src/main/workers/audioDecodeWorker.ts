import { parentPort } from 'node:worker_threads'
import type { MixxxWaveformData } from '../waveformCodec'
import {
  collectTransferableArrayBuffers,
  copyBuffersToTransferableViews
} from './transferableBuffers'

type DecodeJob = {
  jobId: number
  filePath: string
  analyzeKey?: boolean
  needWaveform?: boolean
  waveformTargetRate?: number
  needRawWaveform?: boolean
  rawTargetRate?: number
}

type RawWaveformData = {
  duration: number
  sampleRate: number
  rate: number
  frames: number
  minLeft: Buffer
  maxLeft: Buffer
  minRight: Buffer
  maxRight: Buffer
  meanLeft: Buffer
  meanRight: Buffer
  rmsLeft: Buffer
  rmsRight: Buffer
}

type DecodeResultPayload = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  decoderBackend?: string
  mixxxWaveformData?: MixxxWaveformData | null
  rawWaveformData?: RawWaveformData | null
  keyText?: string
  keyError?: string
  metrics?: {
    decodeMs: number
    waveformMs: number
    rawMs: number
    keyMs: number
    totalMs: number
  }
}

type DecodeResponse = {
  jobId: number
  filePath: string
  result?: DecodeResultPayload
  error?: string
}

const loadRust = () => {
  const binding = require('rust_package') as {
    decodeAudioFile: (filePath: string) => {
      pcmData: Buffer
      sampleRate: number
      channels: number
      totalFrames: number
      decoderBackend?: string
      error?: string
    }
    computeMixxxWaveform?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number
    ) => MixxxWaveformData
    computeMixxxWaveformWithRate?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number,
      targetRate: number
    ) => MixxxWaveformData
    analyzeKeyFromPcm?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number,
      fastAnalysis: boolean
    ) => { keyText: string; error?: string }
  }
  return binding
}

const BASE_WAVEFORM_RATE = 441
const DEFAULT_RAW_TARGET_RATE = 2400

const computeRawWaveform = (
  pcmData: Buffer,
  sampleRate: number,
  channels: number,
  targetRate: number
): RawWaveformData => {
  const totalSamples = Math.floor(pcmData.byteLength / 4)
  const totalFrames = Math.floor(totalSamples / Math.max(1, channels))
  const rate = Math.max(1, Math.min(Number(targetRate) || 1, sampleRate || 1))
  const step = sampleRate / rate
  const expectedFrames = Math.floor(totalFrames / step) + 1

  const minLeftValues = new Float32Array(expectedFrames)
  const maxLeftValues = new Float32Array(expectedFrames)
  const minRightValues = new Float32Array(expectedFrames)
  const maxRightValues = new Float32Array(expectedFrames)
  const meanLeftValues = new Float32Array(expectedFrames)
  const meanRightValues = new Float32Array(expectedFrames)
  const rmsLeftValues = new Float32Array(expectedFrames)
  const rmsRightValues = new Float32Array(expectedFrames)

  let outIndex = 0
  let position = 0
  let nextStore = step
  let currentMinLeft = 1
  let currentMaxLeft = -1
  let currentMinRight = 1
  let currentMaxRight = -1
  let currentSumLeft = 0
  let currentSumRight = 0
  let currentSumSqLeft = 0
  let currentSumSqRight = 0
  let currentSampleCount = 0

  const pcm = new Float32Array(pcmData.buffer, pcmData.byteOffset, totalSamples)
  const channelCount = Math.max(1, channels)

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const base = frame * channelCount
    const leftSample = pcm[base] || 0
    const rightSample = channelCount > 1 ? pcm[base + 1] || 0 : leftSample
    if (leftSample < currentMinLeft) currentMinLeft = leftSample
    if (leftSample > currentMaxLeft) currentMaxLeft = leftSample
    if (rightSample < currentMinRight) currentMinRight = rightSample
    if (rightSample > currentMaxRight) currentMaxRight = rightSample
    currentSumLeft += leftSample
    currentSumRight += rightSample
    currentSumSqLeft += leftSample * leftSample
    currentSumSqRight += rightSample * rightSample
    currentSampleCount += 1
    position += 1
    if (position >= nextStore) {
      minLeftValues[outIndex] = currentMinLeft
      maxLeftValues[outIndex] = currentMaxLeft
      minRightValues[outIndex] = currentMinRight
      maxRightValues[outIndex] = currentMaxRight
      meanLeftValues[outIndex] = currentSampleCount > 0 ? currentSumLeft / currentSampleCount : 0
      meanRightValues[outIndex] = currentSampleCount > 0 ? currentSumRight / currentSampleCount : 0
      rmsLeftValues[outIndex] =
        currentSampleCount > 0 ? Math.sqrt(currentSumSqLeft / currentSampleCount) : 0
      rmsRightValues[outIndex] =
        currentSampleCount > 0 ? Math.sqrt(currentSumSqRight / currentSampleCount) : 0
      outIndex += 1
      currentMinLeft = 1
      currentMaxLeft = -1
      currentMinRight = 1
      currentMaxRight = -1
      currentSumLeft = 0
      currentSumRight = 0
      currentSumSqLeft = 0
      currentSumSqRight = 0
      currentSampleCount = 0
      nextStore += step
      if (outIndex >= expectedFrames) break
    }
  }

  if (outIndex < expectedFrames) {
    for (let i = outIndex; i < expectedFrames; i += 1) {
      minLeftValues[i] = currentMinLeft === 1 ? 0 : currentMinLeft
      maxLeftValues[i] = currentMaxLeft === -1 ? 0 : currentMaxLeft
      minRightValues[i] = currentMinRight === 1 ? 0 : currentMinRight
      maxRightValues[i] = currentMaxRight === -1 ? 0 : currentMaxRight
      meanLeftValues[i] = currentSampleCount > 0 ? currentSumLeft / currentSampleCount : 0
      meanRightValues[i] = currentSampleCount > 0 ? currentSumRight / currentSampleCount : 0
      rmsLeftValues[i] =
        currentSampleCount > 0 ? Math.sqrt(currentSumSqLeft / currentSampleCount) : 0
      rmsRightValues[i] =
        currentSampleCount > 0 ? Math.sqrt(currentSumSqRight / currentSampleCount) : 0
    }
  }

  return {
    duration: sampleRate > 0 ? totalFrames / sampleRate : 0,
    sampleRate,
    rate,
    frames: expectedFrames,
    minLeft: Buffer.from(minLeftValues.buffer, minLeftValues.byteOffset, minLeftValues.byteLength),
    maxLeft: Buffer.from(maxLeftValues.buffer, maxLeftValues.byteOffset, maxLeftValues.byteLength),
    minRight: Buffer.from(
      minRightValues.buffer,
      minRightValues.byteOffset,
      minRightValues.byteLength
    ),
    maxRight: Buffer.from(
      maxRightValues.buffer,
      maxRightValues.byteOffset,
      maxRightValues.byteLength
    ),
    meanLeft: Buffer.from(
      meanLeftValues.buffer,
      meanLeftValues.byteOffset,
      meanLeftValues.byteLength
    ),
    meanRight: Buffer.from(
      meanRightValues.buffer,
      meanRightValues.byteOffset,
      meanRightValues.byteLength
    ),
    rmsLeft: Buffer.from(rmsLeftValues.buffer, rmsLeftValues.byteOffset, rmsLeftValues.byteLength),
    rmsRight: Buffer.from(
      rmsRightValues.buffer,
      rmsRightValues.byteOffset,
      rmsRightValues.byteLength
    )
  }
}

const decodeWithCache = async (
  filePath: string,
  analyzeKey: boolean,
  needWaveform: boolean,
  waveformTargetRate?: number,
  needRawWaveform: boolean = false,
  rawTargetRate?: number
): Promise<DecodeResultPayload> => {
  const startedAt = Date.now()
  const rust = loadRust()
  const decodeStartedAt = Date.now()
  const result = rust.decodeAudioFile(filePath)
  const decodeMs = Date.now() - decodeStartedAt
  if (result.error) {
    throw new Error(result.error)
  }

  let mixxxWaveformData: MixxxWaveformData | null = null
  let waveformMs = 0
  if (needWaveform) {
    const target = Number(waveformTargetRate)
    const useCustomRate = Number.isFinite(target) && target > BASE_WAVEFORM_RATE
    const waveformStartedAt = Date.now()
    try {
      if (useCustomRate && typeof rust.computeMixxxWaveformWithRate === 'function') {
        mixxxWaveformData = rust.computeMixxxWaveformWithRate(
          result.pcmData,
          result.sampleRate,
          result.channels,
          target
        )
      } else if (typeof rust.computeMixxxWaveform === 'function') {
        mixxxWaveformData = rust.computeMixxxWaveform(
          result.pcmData,
          result.sampleRate,
          result.channels
        )
      } else {
        mixxxWaveformData = null
      }
    } catch {
      mixxxWaveformData = null
    } finally {
      waveformMs = Date.now() - waveformStartedAt
    }
  }

  let rawWaveformData: RawWaveformData | null = null
  let rawMs = 0
  if (needRawWaveform) {
    const rawStartedAt = Date.now()
    const target =
      Number.isFinite(rawTargetRate) && Number(rawTargetRate) > 0
        ? Number(rawTargetRate)
        : DEFAULT_RAW_TARGET_RATE
    try {
      rawWaveformData = computeRawWaveform(
        result.pcmData,
        result.sampleRate,
        result.channels,
        target
      )
    } catch {
      rawWaveformData = null
    } finally {
      rawMs = Date.now() - rawStartedAt
    }
  }

  let keyText: string | undefined
  let keyError: string | undefined
  let keyMs = 0
  if (analyzeKey && typeof rust.analyzeKeyFromPcm === 'function') {
    const keyStartedAt = Date.now()
    const keyResult = rust.analyzeKeyFromPcm(
      result.pcmData,
      result.sampleRate,
      result.channels,
      true
    )
    keyMs = Date.now() - keyStartedAt
    keyText = keyResult?.keyText
    keyError = keyResult?.error
  }

  return {
    pcmData: result.pcmData,
    sampleRate: result.sampleRate,
    channels: result.channels,
    totalFrames: result.totalFrames,
    decoderBackend: result.decoderBackend,
    mixxxWaveformData,
    rawWaveformData,
    keyText,
    keyError,
    metrics: {
      decodeMs,
      waveformMs,
      rawMs,
      keyMs,
      totalMs: Date.now() - startedAt
    }
  }
}

parentPort?.on('message', async (job: DecodeJob) => {
  const response: DecodeResponse = {
    jobId: job?.jobId ?? 0,
    filePath: job?.filePath ?? ''
  }

  try {
    if (!job?.filePath) {
      throw new Error('Missing file path')
    }
    response.result = await decodeWithCache(
      job.filePath,
      Boolean(job.analyzeKey),
      Boolean(job.needWaveform),
      job.waveformTargetRate,
      Boolean(job.needRawWaveform),
      job.rawTargetRate
    )
  } catch (error) {
    response.error = (error as Error)?.message ?? String(error)
  }

  const transferableResponse = copyBuffersToTransferableViews(response)
  parentPort?.postMessage(
    transferableResponse,
    collectTransferableArrayBuffers(transferableResponse)
  )
})
