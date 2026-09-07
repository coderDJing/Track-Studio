import { parentPort } from 'node:worker_threads'
import type { MixxxWaveformData } from '../waveformCodec'
import { COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE } from '../../shared/compactVisualWaveform'
import {
  buildUnifiedDisplayWaveformDetailFromMixxx,
  UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
  UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE,
  type UnifiedDisplayWaveformDetailData
} from '../../shared/unifiedDisplayWaveform'
import {
  calculateSongEnergyScoreFromPcm,
  calculateSongEnergyScoreFromUnifiedDisplay
} from '../../shared/songEnergy'
import { analyzeBeatGridWithBeatThisSlidingWindowsFromPcm } from './beatThisAnalyzer'
import { getBeatThisRuntimeAvailabilitySnapshot } from './beatThisRuntime'
import { computeRawWaveform } from './rawWaveformBuilder'
import {
  decodeSongAnalysisAudio,
  shouldUseNativeLibavSongAnalysisDecode
} from './songAnalysisAudioDecoder'
import {
  createSongBeatGridMapV2FromFixedGrid,
  normalizeSongBeatGridMapV2,
  type SongBeatGridMapV2
} from '../../shared/songBeatGridMapV2'
import { buildSongStructureAnalysisV23 } from '../../shared/songStructureV23'
import type { SongStructureAnalysisV23 } from '../../shared/songStructureV23Common'
import type { AnalysisBpmRange } from '../../shared/analysisBpmRange'

type KeyJob = {
  jobId: number
  filePath: string
  fastAnalysis?: boolean
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
  needsEnergy?: boolean
  needsStructure?: boolean
  analysisBpmRange?: AnalysisBpmRange
  cachedBpm?: number
  cachedBeatGridMap?: SongBeatGridMapV2
  cachedUnifiedDisplayWaveformData?: UnifiedDisplayWaveformDetailData
  analyzedTimeBasisOffsetMs?: number
}

type KeyResultPayload = {
  keyText?: string
  keyError?: string
  bpm?: number
  firstBeatMs?: number
  downbeatBeatOffset?: number
  timeBasisOffsetMs?: number
  bpmError?: string
  songStructureError?: string
  songStructure?: SongStructureAnalysisV23
  energyScore?: number
  energyAlgorithmVersion?: number
  mixxxWaveformData?: MixxxWaveformData | null
  unifiedDisplayWaveformData?: UnifiedDisplayWaveformDetailData | null
}

type KeyProgressPayload = {
  stage:
    | 'job-received'
    | 'decode-start'
    | 'decode-done'
    | 'analyze-start'
    | 'analyze-done'
    | 'waveform-start'
    | 'waveform-done'
    | 'job-done'
    | 'job-error'
  elapsedMs: number
  decodeMs?: number
  analyzeMs?: number
  waveformMs?: number
  decodeBackend?: string
  sampleRate?: number
  channels?: number
  totalFrames?: number
  framesToProcess?: number
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
  needsEnergy?: boolean
  needsStructure?: boolean
  detail?: string
  partialResult?: Omit<KeyResultPayload, 'mixxxWaveformData' | 'unifiedDisplayWaveformData'>
}

type KeyResponse = {
  jobId: number
  filePath: string
  progress?: KeyProgressPayload
  result?: KeyResultPayload
  error?: string
}

const K_FAST_ANALYSIS_SECONDS = 60
const BEAT_GRID_ANALYSIS_SAMPLE_RATE = 44100
const BEAT_GRID_ANALYSIS_CHANNELS = 2
const BEAT_GRID_ANALYSIS_MAX_SCAN_SEC = 120

const isNonEmptyByteArray = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.length > 0

const resolveCachedUnifiedDisplayWaveformData = (
  value: UnifiedDisplayWaveformDetailData | null | undefined
): UnifiedDisplayWaveformDetailData | null => {
  if (!value) return null
  if (
    value.version !== UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION ||
    !Number.isFinite(value.parameterVersion) ||
    value.parameterVersion <= 0 ||
    !Number.isFinite(value.duration) ||
    value.duration <= 0 ||
    !Number.isFinite(value.detailRate) ||
    value.detailRate <= 0
  ) {
    return null
  }
  const arrays = [
    value.height,
    value.attack,
    value.colorIndex,
    value.colorLow,
    value.colorMid,
    value.colorHigh,
    value.colorRed,
    value.colorGreen,
    value.colorBlue,
    value.body,
    value.overviewHeight
  ]
  return arrays.every(isNonEmptyByteArray) ? value : null
}

type RustBinding = ReturnType<typeof loadRust>

type DecodedAudioPcm = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  decoderBackend?: string
  error?: string
}

type DecodedBeatGridPcm = DecodedAudioPcm & {
  decoderBackend: string
}

let cachedRustBinding: RustBinding | null = null

const estimateFramesToProcess = (
  totalFrames: number,
  sampleRate: number,
  fastAnalysis: boolean
): number | undefined => {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return undefined
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return undefined
  const total = Math.floor(totalFrames)
  if (!fastAnalysis) return total
  return Math.min(total, Math.floor(sampleRate * K_FAST_ANALYSIS_SECONDS))
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
    decodeAudioFileNativePcm?: (
      filePath: string,
      startSec: number | null | undefined,
      maxDurationSec: number | null | undefined,
      sampleRate: number,
      channels: number
    ) => {
      pcmData: Buffer
      sampleRate: number
      channels: number
      totalFrames: number
      decoderBackend?: string
      error?: string
    }
    analyzeKeyFromPcm?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number,
      fastAnalysis: boolean
    ) => { keyText: string; error?: string }
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
  }
  return binding
}

const getRustBinding = () => {
  if (cachedRustBinding) return cachedRustBinding
  cachedRustBinding = loadRust()
  return cachedRustBinding
}

const decodePcmWithNative = (
  filePath: string,
  params: {
    startSec?: number
    maxDurationSec?: number
    sampleRate: number
    channels: number
    decoderBackend: string
  }
): DecodedBeatGridPcm => {
  const rust = getRustBinding()
  const decodeNative = rust.decodeAudioFileNativePcm
  if (typeof decodeNative !== 'function') {
    throw new Error('decodeAudioFileNativePcm unavailable')
  }
  const decoded = decodeNative(
    filePath,
    params.startSec ?? null,
    params.maxDurationSec ?? null,
    params.sampleRate,
    params.channels
  )
  if (decoded.error) throw new Error(decoded.error)
  if (!decoded.pcmData || decoded.pcmData.byteLength <= 0) {
    throw new Error('native decoded empty PCM')
  }
  return {
    pcmData: decoded.pcmData,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    totalFrames: decoded.totalFrames,
    decoderBackend: params.decoderBackend
  }
}

const decodeBeatGridPcmForFile = async (filePath: string): Promise<DecodedBeatGridPcm> => {
  return decodePcmWithNative(filePath, {
    startSec: 0,
    maxDurationSec: BEAT_GRID_ANALYSIS_MAX_SCAN_SEC,
    sampleRate: BEAT_GRID_ANALYSIS_SAMPLE_RATE,
    channels: BEAT_GRID_ANALYSIS_CHANNELS,
    decoderBackend: 'native-libav-beat-grid'
  })
}

const analyzeKeyForFile = (
  filePath: string,
  options: {
    fastAnalysis: boolean
    needsKey: boolean
    needsBpm: boolean
    needsWaveform: boolean
    needsEnergy: boolean
    needsStructure: boolean
    cachedBpm?: number
    cachedBeatGridMap?: SongBeatGridMapV2
    cachedFirstBeatMs?: number
    cachedUnifiedDisplayWaveformData?: UnifiedDisplayWaveformDetailData
    analyzedTimeBasisOffsetMs?: number
    analysisBpmRange?: AnalysisBpmRange
  },
  reportProgress: (progress: Omit<KeyProgressPayload, 'elapsedMs'>) => void
): Promise<KeyResultPayload> => {
  return analyzeKeyForFileInternal(filePath, options, reportProgress)
}

const analyzeKeyForFileInternal = async (
  filePath: string,
  options: {
    fastAnalysis: boolean
    needsKey: boolean
    needsBpm: boolean
    needsWaveform: boolean
    needsEnergy: boolean
    needsStructure: boolean
    cachedBpm?: number
    cachedBeatGridMap?: SongBeatGridMapV2
    cachedUnifiedDisplayWaveformData?: UnifiedDisplayWaveformDetailData
    analyzedTimeBasisOffsetMs?: number
    analysisBpmRange?: AnalysisBpmRange
  },
  reportProgress: (progress: Omit<KeyProgressPayload, 'elapsedMs'>) => void
): Promise<KeyResultPayload> => {
  const result: KeyResultPayload = {}
  const needsKey = Boolean(options.needsKey)
  const needsBpm = Boolean(options.needsBpm) && getBeatThisRuntimeAvailabilitySnapshot() !== false
  const needsWaveform = Boolean(options.needsWaveform)
  const needsEnergy = Boolean(options.needsEnergy)
  const needsStructure = Boolean(options.needsStructure)
  const cachedUnifiedDisplayWaveformData =
    needsEnergy || needsStructure
      ? resolveCachedUnifiedDisplayWaveformData(options.cachedUnifiedDisplayWaveformData)
      : null
  let structureWaveformData = cachedUnifiedDisplayWaveformData
  const needsPcmEnergy = needsEnergy && !cachedUnifiedDisplayWaveformData
  const useNativeLibavWaveformDecode =
    (needsWaveform || needsPcmEnergy || (needsStructure && !structureWaveformData)) &&
    shouldUseNativeLibavSongAnalysisDecode(filePath)
  const useNativeLibavPrimaryDecode = (needsKey || needsPcmEnergy) && useNativeLibavWaveformDecode
  const needsRustDecode =
    (needsKey && !useNativeLibavPrimaryDecode) ||
    ((needsWaveform || needsPcmEnergy || (needsStructure && !structureWaveformData)) &&
      !useNativeLibavWaveformDecode)
  let rust: RustBinding | null = null
  let decoded: DecodedAudioPcm | null = null
  let beatGridDecoded: DecodedBeatGridPcm | null = null
  let reusableNativeLibavWaveformDecoded: DecodedAudioPcm | null = null
  const resolveRustBinding = () => {
    if (!rust) {
      rust = getRustBinding()
    }
    return rust
  }
  if (needsRustDecode || useNativeLibavPrimaryDecode || needsBpm) {
    reportProgress({
      stage: 'decode-start',
      needsKey,
      needsBpm,
      needsWaveform,
      needsEnergy,
      needsStructure
    })
    const decodeStartAt = Date.now()
    if (useNativeLibavPrimaryDecode) {
      reusableNativeLibavWaveformDecoded = decodeSongAnalysisAudio(resolveRustBinding(), filePath)
      decoded = reusableNativeLibavWaveformDecoded
    } else if (needsRustDecode) {
      const rustDecoded = resolveRustBinding().decodeAudioFile(filePath)
      if (rustDecoded.error) {
        throw new Error(rustDecoded.error)
      }
      decoded = rustDecoded
    } else {
      beatGridDecoded = await decodeBeatGridPcmForFile(filePath)
    }
    const decodeMs = Date.now() - decodeStartAt
    const decodedMeta = decoded || beatGridDecoded
    const framesToProcess = decodedMeta
      ? estimateFramesToProcess(
          decodedMeta.totalFrames,
          decodedMeta.sampleRate,
          options.fastAnalysis
        )
      : undefined
    reportProgress({
      stage: 'decode-done',
      decodeMs,
      decodeBackend: decodedMeta?.decoderBackend,
      sampleRate: decodedMeta?.sampleRate,
      channels: decodedMeta?.channels,
      totalFrames: decodedMeta?.totalFrames,
      framesToProcess
    })
  }

  if (needsKey || needsBpm) {
    const analysisFramesToProcess = estimateFramesToProcess(
      (beatGridDecoded || decoded)?.totalFrames || 0,
      (beatGridDecoded || decoded)?.sampleRate || 0,
      options.fastAnalysis
    )
    const analyzePlanDetail = needsBpm
      ? options.fastAnalysis
        ? 'key+beat-this-windowed-fast'
        : 'key+beat-this-windowed'
      : options.fastAnalysis
        ? 'key-fast'
        : 'key-full'
    reportProgress({
      stage: 'analyze-start',
      needsKey,
      needsBpm,
      needsStructure,
      framesToProcess: analysisFramesToProcess,
      detail: analyzePlanDetail
    })
    const analyzeStartAt = Date.now()
    let hasAnalysisError = false

    if (needsKey) {
      if (!decoded) {
        throw new Error('Rust PCM decode missing for key analysis')
      }
      const analyzeKey = resolveRustBinding().analyzeKeyFromPcm
      if (typeof analyzeKey !== 'function') {
        throw new Error('analyzeKeyFromPcm not available')
      }
      const keyOnly = analyzeKey(
        decoded.pcmData,
        decoded.sampleRate,
        decoded.channels,
        options.fastAnalysis
      )
      result.keyText = keyOnly.keyText
      result.keyError = keyOnly.error
      if (keyOnly.error) {
        hasAnalysisError = true
      }
    }

    if (needsBpm) {
      try {
        if (!beatGridDecoded) {
          beatGridDecoded = await decodeBeatGridPcmForFile(filePath)
        }
        const beatThisResult = await analyzeBeatGridWithBeatThisSlidingWindowsFromPcm({
          pcmData: beatGridDecoded.pcmData,
          sampleRate: beatGridDecoded.sampleRate,
          channels: beatGridDecoded.channels,
          sourceFilePath: filePath,
          minBpm: options.analysisBpmRange?.minBpm,
          maxBpm: options.analysisBpmRange?.maxBpm
        })
        result.bpm = beatThisResult.bpm
        result.firstBeatMs = beatThisResult.firstBeatMs
        result.downbeatBeatOffset = beatThisResult.downbeatBeatOffset
        result.timeBasisOffsetMs = options.analyzedTimeBasisOffsetMs
        result.bpmError = undefined
      } catch (error) {
        result.bpmError =
          error instanceof Error ? error.message : String(error || 'Beat This! analyze failed')
      }

      if (!result.bpmError) {
        const normalizedBpm = Number(result.bpm)
        if (!Number.isFinite(normalizedBpm) || normalizedBpm <= 0) {
          result.bpmError = 'invalid bpm value from Beat This! analyzer'
        }
      }

      if (result.bpmError) {
        hasAnalysisError = true
      }
    }

    reportProgress({
      stage: 'analyze-done',
      analyzeMs: Date.now() - analyzeStartAt,
      detail: hasAnalysisError ? 'analysis-has-errors' : undefined,
      partialResult: {
        keyText: result.keyText,
        keyError: result.keyError,
        bpm: result.bpm,
        firstBeatMs: result.firstBeatMs,
        downbeatBeatOffset: result.downbeatBeatOffset,
        timeBasisOffsetMs: result.timeBasisOffsetMs,
        bpmError: result.bpmError
      }
    })
  }

  if (needsEnergy && decoded) {
    const energy = calculateSongEnergyScoreFromPcm({
      pcmData: decoded.pcmData,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      bpm: result.bpm ?? options.cachedBpm
    })
    if (energy) {
      result.energyScore = energy.energyScore
      result.energyAlgorithmVersion = energy.energyAlgorithmVersion
    }
  }

  if (cachedUnifiedDisplayWaveformData) {
    reportProgress({
      stage: 'waveform-start',
      needsEnergy,
      needsStructure,
      detail: 'structure-cache'
    })
    const waveformStartAt = Date.now()
    const energy =
      needsEnergy && result.energyScore === undefined
        ? calculateSongEnergyScoreFromUnifiedDisplay(
            cachedUnifiedDisplayWaveformData,
            result.bpm ?? options.cachedBpm
          )
        : null
    if (energy && needsEnergy) {
      result.energyScore = energy.energyScore
      result.energyAlgorithmVersion = energy.energyAlgorithmVersion
    }
    reportProgress({
      stage: 'waveform-done',
      waveformMs: Date.now() - waveformStartAt,
      needsEnergy,
      needsStructure,
      detail: 'structure-cache'
    })
  }

  if (
    (needsWaveform || (needsStructure && !structureWaveformData)) &&
    (typeof resolveRustBinding().computeMixxxWaveformWithRate === 'function' ||
      typeof resolveRustBinding().computeMixxxWaveform === 'function')
  ) {
    if (!decoded) {
      if (!useNativeLibavWaveformDecode) {
        throw new Error('Rust PCM decode missing for waveform/structure analysis')
      }
    }
    reportProgress({ stage: 'waveform-start', needsEnergy, needsStructure })
    const waveformStartAt = Date.now()
    try {
      const targetRate = UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE
      let waveformDecoded: DecodedAudioPcm
      if (useNativeLibavWaveformDecode) {
        if (reusableNativeLibavWaveformDecoded) {
          waveformDecoded = reusableNativeLibavWaveformDecoded
        } else {
          const nativeLibavWaveformDecoded = decodeSongAnalysisAudio(resolveRustBinding(), filePath)
          reusableNativeLibavWaveformDecoded = nativeLibavWaveformDecoded
          waveformDecoded = nativeLibavWaveformDecoded
        }
      } else {
        waveformDecoded = decoded as DecodedAudioPcm
      }
      const mixxxWaveformData =
        typeof resolveRustBinding().computeMixxxWaveformWithRate === 'function'
          ? resolveRustBinding().computeMixxxWaveformWithRate!(
              waveformDecoded.pcmData,
              waveformDecoded.sampleRate,
              waveformDecoded.channels,
              targetRate
            )
          : resolveRustBinding().computeMixxxWaveform!(
              waveformDecoded.pcmData,
              waveformDecoded.sampleRate,
              waveformDecoded.channels
            )
      const rawWaveformData = computeRawWaveform(
        waveformDecoded.pcmData,
        waveformDecoded.sampleRate,
        waveformDecoded.channels,
        COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE
      )
      const unifiedDisplayWaveformData = mixxxWaveformData
        ? buildUnifiedDisplayWaveformDetailFromMixxx(mixxxWaveformData, rawWaveformData)
        : null
      structureWaveformData = unifiedDisplayWaveformData
      if (needsWaveform) {
        result.mixxxWaveformData = mixxxWaveformData
        result.unifiedDisplayWaveformData = unifiedDisplayWaveformData
      }
      const energy =
        needsEnergy && result.energyScore === undefined
          ? calculateSongEnergyScoreFromUnifiedDisplay(
              unifiedDisplayWaveformData,
              result.bpm ?? options.cachedBpm
            )
          : null
      if (energy && needsEnergy) {
        result.energyScore = energy.energyScore
        result.energyAlgorithmVersion = energy.energyAlgorithmVersion
      }
      reportProgress({
        stage: 'waveform-done',
        waveformMs: Date.now() - waveformStartAt,
        needsEnergy,
        needsStructure,
        detail: String(waveformDecoded.decoderBackend || '').startsWith('native-libav')
          ? 'waveform-ok:native-libav'
          : 'waveform-ok'
      })
    } catch (error) {
      result.mixxxWaveformData = null
      reportProgress({
        stage: 'waveform-done',
        waveformMs: Date.now() - waveformStartAt,
        needsEnergy,
        needsStructure,
        detail: 'waveform-failed'
      })
    }
  }

  if (needsStructure) {
    const cachedBeatGridMap = normalizeSongBeatGridMapV2(options.cachedBeatGridMap, {
      allowSingleClip: true
    })
    const analyzedFirstBeatMs = Number(result.firstBeatMs)
    const timeBasisOffsetMs = Number(options.analyzedTimeBasisOffsetMs)
    const analyzedBeatGridMap =
      Number.isFinite(Number(result.bpm)) &&
      Number.isFinite(analyzedFirstBeatMs) &&
      Number.isInteger(result.downbeatBeatOffset)
        ? createSongBeatGridMapV2FromFixedGrid({
            bpm: result.bpm,
            firstBeatMs: Number.isFinite(timeBasisOffsetMs)
              ? analyzedFirstBeatMs + Math.max(0, timeBasisOffsetMs)
              : analyzedFirstBeatMs,
            downbeatBeatOffset: result.downbeatBeatOffset,
            source: 'analysis'
          })
        : null
    const beatGridMap =
      cachedBeatGridMap?.source === 'manual' || !analyzedBeatGridMap
        ? cachedBeatGridMap
        : analyzedBeatGridMap
    if (!structureWaveformData) {
      result.songStructureError = 'missing unified waveform for v23 structure analysis'
    } else if (!beatGridMap) {
      result.songStructureError = 'missing v2 beat grid for v23 structure analysis'
    } else {
      const songStructure = buildSongStructureAnalysisV23({
        waveformData: structureWaveformData,
        beatGridMap
      })
      if (songStructure) result.songStructure = songStructure
      else result.songStructureError = 'v23 structure analyzer returned no result'
    }
  }

  return result
}

parentPort?.on('message', async (job: KeyJob) => {
  const response: KeyResponse = {
    jobId: job?.jobId ?? 0,
    filePath: job?.filePath ?? ''
  }
  const startedAt = Date.now()
  const reportProgress = (progress: Omit<KeyProgressPayload, 'elapsedMs'>) => {
    parentPort?.postMessage({
      jobId: response.jobId,
      filePath: response.filePath,
      progress: {
        ...progress,
        elapsedMs: Date.now() - startedAt
      }
    } satisfies KeyResponse)
  }

  try {
    if (!job?.filePath) {
      throw new Error('Missing file path')
    }
    reportProgress({
      stage: 'job-received',
      needsKey: Boolean(job.needsKey),
      needsBpm: Boolean(job.needsBpm),
      needsWaveform: Boolean(job.needsWaveform),
      needsEnergy: Boolean(job.needsEnergy),
      needsStructure: Boolean(job.needsStructure)
    })
    const result = await analyzeKeyForFile(
      job.filePath,
      {
        fastAnalysis: Boolean(job.fastAnalysis),
        needsKey: Boolean(job.needsKey),
        needsBpm: Boolean(job.needsBpm),
        needsWaveform: Boolean(job.needsWaveform),
        needsEnergy: Boolean(job.needsEnergy),
        needsStructure: Boolean(job.needsStructure),
        cachedBpm: job.cachedBpm,
        cachedBeatGridMap: job.cachedBeatGridMap,
        cachedUnifiedDisplayWaveformData: job.cachedUnifiedDisplayWaveformData,
        analyzedTimeBasisOffsetMs: job.analyzedTimeBasisOffsetMs,
        analysisBpmRange: job.analysisBpmRange
      },
      reportProgress
    )
    response.result = result
    reportProgress({ stage: 'job-done' })
  } catch (error) {
    const message = (error as Error)?.message ?? String(error)
    response.error = message
    reportProgress({
      stage: 'job-error',
      detail: message.slice(0, 300)
    })
  }

  parentPort?.postMessage(response)
})
