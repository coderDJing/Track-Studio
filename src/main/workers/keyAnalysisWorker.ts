import { parentPort, threadId } from 'node:worker_threads'
import type { MixxxWaveformData } from '../waveformCodec'
import {
  collectTransferableArrayBuffers,
  copyBuffersToTransferableViews
} from './transferableBuffers'
import { COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE } from '../../shared/compactVisualWaveform'
import {
  buildUnifiedDisplayWaveformDetailFromMixxx,
  UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
  UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE,
  type UnifiedDisplayWaveformDetailData
} from '../../shared/unifiedDisplayWaveform'
import {
  analyzeSongEnergyWithModel,
  normalizeSongEnergyBeatGrid,
  SONG_ENERGY_MODEL_CHANNELS,
  SONG_ENERGY_MODEL_SAMPLE_RATE
} from './songEnergyModel'
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
  projectSongBeatGridMapV2ToFixedGrid,
  type SongBeatGridMapV2
} from '../../shared/songBeatGridMapV2'
import { buildSongStructureAnalysisV23 } from '../../shared/songStructureV23'
import type { SongStructureAnalysisV23 } from '../../shared/songStructureV23Common'
import type { AnalysisBpmRange } from '../../shared/analysisBpmRange'
import type { SongEnergyAnalysisV5 } from '../../shared/songEnergy'
import type { KeyAnalysisDiagnosticPhase } from '../services/keyAnalysis/types'
import type { AnalysisGridMode } from '../../shared/analysisGridMode'
import { normalizeAnalysisGridMode } from '../../shared/analysisGridMode'
import type { DynamicGridOutcome } from '../../shared/dynamicBeatGridTypes'
import { convertDynamicTimelineGridMapToAudio } from '../../shared/dynamicBeatGridCoordinates'
import {
  DYNAMIC_GRID_DEFERRED_STRUCTURE_ERROR,
  buildDynamicGridFailureDetail,
  resolveDynamicGridTimelineDefinition,
  type DynamicGridProgress,
  type DynamicGridTimelineDefinition
} from '../services/keyAnalysis/dynamicGridIntegration'
import { runDynamicBeatGridAnalysis } from './dynamicGridAnalysisRunner'

type KeyJob = {
  jobId: number
  diagnostics?: boolean
  filePath: string
  fastAnalysis?: boolean
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
  needsEnergy?: boolean
  needsStructure?: boolean
  analysisBpmRange?: AnalysisBpmRange
  analysisGridMode?: AnalysisGridMode
  audioDurationSec?: number
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
  energyError?: string
  songStructure?: SongStructureAnalysisV23
  structureBeatGridMap?: SongBeatGridMapV2
  dynamicGridOutcome?: DynamicGridOutcome
  energyScore?: number
  energyAlgorithmVersion?: number
  energyAnalysis?: SongEnergyAnalysisV5
  energySourceGridSignature?: string
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
  dynamicGrid?: DynamicGridProgress
  partialResult?: Omit<KeyResultPayload, 'mixxxWaveformData' | 'unifiedDisplayWaveformData'>
}

type KeyResponse = {
  jobId: number
  filePath: string
  progress?: KeyProgressPayload
  diagnostic?: KeyAnalysisDiagnosticPhase
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

const decodeSongEnergyPcmForFile = async (filePath: string): Promise<DecodedBeatGridPcm> => {
  return decodePcmWithNative(filePath, {
    sampleRate: SONG_ENERGY_MODEL_SAMPLE_RATE,
    channels: SONG_ENERGY_MODEL_CHANNELS,
    decoderBackend: 'native-libav-song-energy'
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
    analysisGridMode?: AnalysisGridMode
    audioDurationSec?: number
  },
  reportProgress: (progress: Omit<KeyProgressPayload, 'elapsedMs'>) => void,
  reportDiagnosticPhase?: (phase: string) => void
): Promise<KeyResultPayload> => {
  return analyzeKeyForFileInternal(filePath, options, reportProgress, reportDiagnosticPhase)
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
    analysisGridMode?: AnalysisGridMode
    audioDurationSec?: number
  },
  reportProgress: (progress: Omit<KeyProgressPayload, 'elapsedMs'>) => void,
  reportDiagnosticPhase?: (phase: string) => void
): Promise<KeyResultPayload> => {
  const result: KeyResultPayload = {}
  const needsKey = Boolean(options.needsKey)
  const needsBpm = Boolean(options.needsBpm) && getBeatThisRuntimeAvailabilitySnapshot() !== false
  const needsWaveform = Boolean(options.needsWaveform)
  const needsEnergy = Boolean(options.needsEnergy)
  const needsStructure = Boolean(options.needsStructure)
  const analysisGridMode = normalizeAnalysisGridMode(options.analysisGridMode, 'normal')
  // Dynamic 不做 120s 预解码：窗口扫描由有界 scanner 负责。
  const isDynamicGrid = needsBpm && analysisGridMode === 'dynamic'
  let dynamicTimelineDefinition: DynamicGridTimelineDefinition | null = null
  const cachedUnifiedDisplayWaveformData = needsStructure
    ? resolveCachedUnifiedDisplayWaveformData(options.cachedUnifiedDisplayWaveformData)
    : null
  let structureWaveformData = cachedUnifiedDisplayWaveformData
  const useNativeLibavWaveformDecode =
    (needsWaveform || (needsStructure && !structureWaveformData)) &&
    shouldUseNativeLibavSongAnalysisDecode(filePath)
  const useNativeLibavPrimaryDecode = needsKey && useNativeLibavWaveformDecode
  const needsRustDecode =
    (needsKey && !useNativeLibavPrimaryDecode) ||
    ((needsWaveform || (needsStructure && !structureWaveformData)) && !useNativeLibavWaveformDecode)
  let rust: RustBinding | null = null
  let decoded: DecodedAudioPcm | null = null
  let beatGridDecoded: DecodedBeatGridPcm | null = null
  let energyDecoded: DecodedBeatGridPcm | null = null
  let reusableNativeLibavWaveformDecoded: DecodedAudioPcm | null = null
  const resolveRustBinding = () => {
    if (!rust) {
      rust = getRustBinding()
    }
    return rust
  }
  if (needsRustDecode || useNativeLibavPrimaryDecode || needsBpm || needsEnergy) {
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
      reportDiagnosticPhase?.('decode:native-primary')
      reusableNativeLibavWaveformDecoded = decodeSongAnalysisAudio(resolveRustBinding(), filePath)
      decoded = reusableNativeLibavWaveformDecoded
    } else if (needsRustDecode) {
      reportDiagnosticPhase?.('decode:rust-pcm')
      const rustDecoded = resolveRustBinding().decodeAudioFile(filePath)
      if (rustDecoded.error) {
        throw new Error(rustDecoded.error)
      }
      decoded = rustDecoded
    } else if (needsBpm && !isDynamicGrid) {
      reportDiagnosticPhase?.('decode:beat-grid-pcm')
      beatGridDecoded = await decodeBeatGridPcmForFile(filePath)
    }
    if (needsEnergy) {
      reportDiagnosticPhase?.('decode:energy-pcm')
      energyDecoded = await decodeSongEnergyPcmForFile(filePath)
    }
    const decodeMs = Date.now() - decodeStartAt
    const decodedMeta = decoded || energyDecoded || beatGridDecoded
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
      reportDiagnosticPhase?.('key:native-start')
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
      reportDiagnosticPhase?.('key:native-done')
      if (keyOnly.error) {
        hasAnalysisError = true
      }
    }

    if (needsBpm && isDynamicGrid) {
      const rawTimeBasisOffsetMs = options.analyzedTimeBasisOffsetMs
      const hasTimeBasis =
        rawTimeBasisOffsetMs !== undefined && Number.isFinite(Number(rawTimeBasisOffsetMs))
      let outcome: DynamicGridOutcome = hasTimeBasis
        ? await runDynamicBeatGridAnalysis({
            filePath,
            durationAudioSec: options.audioDurationSec,
            minBpm: options.analysisBpmRange?.minBpm,
            maxBpm: options.analysisBpmRange?.maxBpm,
            onProgress: (dynamicGrid) => {
              reportProgress({
                stage: 'analyze-start',
                needsKey,
                needsBpm,
                needsStructure,
                dynamicGrid,
                detail: `dynamic-grid:${dynamicGrid.phase}`
              })
            }
          })
        : { status: 'error', reason: 'audio-time-basis-unavailable' }
      if (outcome.status === 'fixed' || outcome.status === 'dynamic') {
        const definition = resolveDynamicGridTimelineDefinition({
          outcome,
          timeBasisOffsetMs: rawTimeBasisOffsetMs,
          expectedDurationAudioSec: options.audioDurationSec
        })
        if (definition.ok) {
          dynamicTimelineDefinition = definition.value
          result.bpm = definition.value.projection.bpm
          result.firstBeatMs = definition.value.projection.firstBeatMs
          result.downbeatBeatOffset = definition.value.projection.downbeatBeatOffset
          result.timeBasisOffsetMs = rawTimeBasisOffsetMs
          result.bpmError = undefined
        } else {
          outcome = { status: 'error', reason: definition.reason }
        }
      }
      result.dynamicGridOutcome = outcome
      if (outcome.status !== 'fixed' && outcome.status !== 'dynamic') {
        // 无法确认网格 ≠ 没有节拍：绝不写 no-bpm，也不回退首段固定网格。
        result.bpm = undefined
        result.firstBeatMs = undefined
        result.downbeatBeatOffset = undefined
        result.bpmError = buildDynamicGridFailureDetail(outcome)
      }
      reportDiagnosticPhase?.(result.bpmError ? 'bpm:failed' : 'bpm:dynamic-done')
      if (result.bpmError) hasAnalysisError = true
    } else if (needsBpm) {
      try {
        if (!beatGridDecoded) {
          reportDiagnosticPhase?.('bpm:decode')
          beatGridDecoded = await decodeBeatGridPcmForFile(filePath)
        }
        reportDiagnosticPhase?.('bpm:beat-this-start')
        const beatThisResult = await analyzeBeatGridWithBeatThisSlidingWindowsFromPcm({
          pcmData: beatGridDecoded.pcmData,
          sampleRate: beatGridDecoded.sampleRate,
          channels: beatGridDecoded.channels,
          sourceFilePath: filePath,
          minBpm: options.analysisBpmRange?.minBpm,
          maxBpm: options.analysisBpmRange?.maxBpm,
          onDiagnosticPhase: reportDiagnosticPhase
        })
        result.bpm = beatThisResult.bpm
        result.firstBeatMs = beatThisResult.firstBeatMs
        result.downbeatBeatOffset = beatThisResult.downbeatBeatOffset
        result.timeBasisOffsetMs = options.analyzedTimeBasisOffsetMs
        result.bpmError = undefined
        reportDiagnosticPhase?.('bpm:beat-this-done')
      } catch (error) {
        result.bpmError =
          error instanceof Error ? error.message : String(error || 'Beat This! analyze failed')
      }

      if (!result.bpmError) {
        const normalizedBpm = Number(result.bpm)
        if (!Number.isFinite(normalizedBpm) || normalizedBpm <= 0) {
          result.bpmError = 'invalid bpm value from Beat This! analyzer'
        } else {
          const analyzedBeatGridMap = createSongBeatGridMapV2FromFixedGrid({
            bpm: normalizedBpm,
            firstBeatMs: result.firstBeatMs,
            downbeatBeatOffset: result.downbeatBeatOffset,
            source: 'analysis'
          })
          if (!analyzedBeatGridMap) {
            result.bpmError = 'invalid v2 beat grid from Beat This! analyzer'
          }
        }
      }

      if (result.bpmError) {
        reportDiagnosticPhase?.('bpm:failed')
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
        bpmError: result.bpmError,
        dynamicGridOutcome: result.dynamicGridOutcome
      }
    })
  }

  const dynamicOutcome = result.dynamicGridOutcome
  const dynamicAudioGridMap =
    dynamicOutcome && (dynamicOutcome.status === 'fixed' || dynamicOutcome.status === 'dynamic')
      ? dynamicOutcome.beatGridMap
      : null
  if (needsEnergy && !(needsBpm && result.bpmError)) {
    reportDiagnosticPhase?.('energy:start')
    try {
      if (!energyDecoded) throw new Error('missing 16 kHz mono PCM for song energy model')
      const cachedGridProjection = projectSongBeatGridMapV2ToFixedGrid(options.cachedBeatGridMap)
      const analyzedEnergyGrid = normalizeSongEnergyBeatGrid(result.bpm, result.firstBeatMs)
      const cachedEnergyGrid = normalizeSongEnergyBeatGrid(
        cachedGridProjection?.bpm ?? options.cachedBpm,
        cachedGridProjection?.firstBeatMs
      )
      const energyGrid = analyzedEnergyGrid ?? cachedEnergyGrid
      const hasValidBpm = [result.bpm, cachedGridProjection?.bpm, options.cachedBpm].some(
        (value) => Number.isFinite(Number(value)) && Number(value) > 0
      )
      if (!hasValidBpm) {
        throw new Error('song energy requires a valid beat-grid BPM')
      }
      if (!energyGrid) {
        throw new Error('song energy requires a valid beat-grid first beat')
      }
      const dynamicDefinition = dynamicAudioGridMap ? dynamicTimelineDefinition : null
      if (dynamicAudioGridMap && !dynamicDefinition) {
        throw new Error('dynamic song energy requires a validated timeline grid')
      }
      if (dynamicDefinition) {
        const decodedAudioSec = energyDecoded.totalFrames / energyDecoded.sampleRate
        if (Math.abs(decodedAudioSec - dynamicDefinition.durationAudioSec) > 0.25) {
          throw new Error('song energy audio duration does not match dynamic grid duration')
        }
      }
      // 人工/既有完整 map 也必须用 audio 坐标参与能量计算，而不是退回首段固定分桶。
      let energyAudioGridMap = dynamicAudioGridMap
      let energySourceGridSignature = dynamicDefinition?.map.signature
      if (!energyAudioGridMap) {
        const cachedMap = normalizeSongBeatGridMapV2(options.cachedBeatGridMap, {
          allowSingleClip: true
        })
        if (cachedMap && cachedMap.clips.length > 1) {
          const timeBasisOffsetMs = Number(options.analyzedTimeBasisOffsetMs)
          if (!Number.isFinite(timeBasisOffsetMs) || timeBasisOffsetMs < 0) {
            throw new Error('manual dynamic grid requires a valid audio time basis offset')
          }
          const audioDurationSec = energyDecoded.totalFrames / energyDecoded.sampleRate
          const conversion = convertDynamicTimelineGridMapToAudio({
            beatGridMap: cachedMap,
            timelineDurationSec: audioDurationSec + timeBasisOffsetMs / 1000,
            timeBasisOffsetMs,
            audioDurationSec
          })
          if (conversion.status === 'error') {
            throw new Error(`manual dynamic grid audio conversion failed: ${conversion.reason}`)
          }
          energyAudioGridMap = conversion.map
          energySourceGridSignature = cachedMap.signature
        }
      }
      const energy = await analyzeSongEnergyWithModel({
        pcmData: energyDecoded.pcmData,
        sampleRate: energyDecoded.sampleRate,
        channels: energyDecoded.channels,
        bpm: dynamicDefinition?.projection.bpm ?? energyGrid.bpm,
        firstBeatMs: energyAudioGridMap ? undefined : energyGrid.firstBeatMs,
        ...(energyAudioGridMap ? { beatGridMapAudio: energyAudioGridMap } : {}),
        onDiagnosticPhase: reportDiagnosticPhase
      })
      if (!energy) throw new Error('audio is silent or shorter than the model input window')
      result.energyScore = energy.energyScore
      result.energyAlgorithmVersion = energy.energyAlgorithmVersion
      result.energyAnalysis = energy.analysis
      // 派生能量绑定有效源网格签名，后续 clip 变化即可判定 stale。
      result.energySourceGridSignature = energySourceGridSignature
    } catch (error) {
      result.energyError = error instanceof Error ? error.message : String(error)
    }
    reportDiagnosticPhase?.(result.energyError ? 'energy:failed' : 'energy:done')
  }

  if (cachedUnifiedDisplayWaveformData) {
    reportProgress({
      stage: 'waveform-start',
      needsEnergy,
      needsStructure,
      detail: 'structure-cache'
    })
    const waveformStartAt = Date.now()
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

  if (needsStructure && isDynamicGrid) {
    // 段落算法正在独立重构：不启动基于首段投影的段落计算，也不让网格任务因此失败。
    reportDiagnosticPhase?.('structure:deferred-dynamic-grid')
    result.songStructureError = DYNAMIC_GRID_DEFERRED_STRUCTURE_ERROR
  } else if (needsStructure) {
    reportDiagnosticPhase?.('structure:start')
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
      if (songStructure) {
        result.songStructure = songStructure
        result.structureBeatGridMap = beatGridMap
      } else result.songStructureError = 'v23 structure analyzer returned no result'
    }
    reportDiagnosticPhase?.(result.songStructureError ? 'structure:failed' : 'structure:done')
  }

  return result
}

parentPort?.on('message', async (job: KeyJob) => {
  const response: KeyResponse = {
    jobId: job?.jobId ?? 0,
    filePath: job?.filePath ?? ''
  }
  const startedAt = Date.now()
  const startedThreadCpu = job.diagnostics ? process.threadCpuUsage() : null
  let memorySampledAt = 0
  let workerMemory: KeyAnalysisDiagnosticPhase['workerMemory']
  const reportDiagnosticPhase = startedThreadCpu
    ? (phase: string) => {
        const cpu = process.threadCpuUsage(startedThreadCpu)
        const now = Date.now()
        if (now - memorySampledAt >= 1_000) {
          const memory = process.memoryUsage()
          const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10
          workerMemory = {
            rssMb: mb(memory.rss),
            heapUsedMb: mb(memory.heapUsed),
            externalMb: mb(memory.external),
            arrayBuffersMb: mb(memory.arrayBuffers)
          }
          memorySampledAt = now
        }
        parentPort?.postMessage({
          jobId: response.jobId,
          filePath: response.filePath,
          diagnostic: {
            phase,
            startedAtMs: now,
            workerElapsedMs: now - startedAt,
            workerThreadCpuMs: Math.round((cpu.user + cpu.system) / 1000),
            workerThreadId: threadId,
            workerMemory
          }
        } satisfies KeyResponse)
      }
    : undefined
  const reportProgress = (progress: Omit<KeyProgressPayload, 'elapsedMs'>) => {
    reportDiagnosticPhase?.(progress.stage)
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
        analysisBpmRange: job.analysisBpmRange,
        analysisGridMode: job.analysisGridMode,
        audioDurationSec: job.audioDurationSec
      },
      reportProgress,
      reportDiagnosticPhase
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

  reportDiagnosticPhase?.('result:copy-buffers')
  const transferableResponse = copyBuffersToTransferableViews(response)
  reportDiagnosticPhase?.('result:send')
  parentPort?.postMessage(
    transferableResponse,
    collectTransferableArrayBuffers(transferableResponse)
  )
})
