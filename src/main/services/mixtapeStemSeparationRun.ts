import fs from 'node:fs'
import path from 'node:path'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import {
  resolveBundledDemucsBootstrapDirPath,
  resolveBundledDemucsPythonPath,
  resolveBundledDemucsRuntimeDir,
  resolveInstalledDemucsModelPath
} from '../demucs'
import { ensureDemucsBaseModel, isDemucsBaseModelName } from './demucsBaseModelDownload'
import type { MixtapeStemMode } from '../mixtapeDb'
import {
  DEFAULT_MIXTAPE_STEM_BASE_MODEL,
  DEFAULT_MIXTAPE_STEM_PROFILE,
  parseMixtapeStemModel
} from '../../shared/mixtapeStemProfiles'
import * as shared from './mixtapeStemSeparationShared'
import * as probe from './mixtapeStemSeparationProbe'
import { decodeAudioShared } from './audioDecodePool'
import { runPersistentXpuStemInference } from './mixtapeStemPersistentXpuWorker'
import {
  downloadPreferredStemRuntime,
  getStemRuntimeDownloadState
} from './mixtapeStemRuntimeDownload'
import type {
  MixtapeStemComputeDevice,
  MixtapeStemCpuFallbackReasonCode,
  MixtapeStemRuntimeProgress,
  MixtapeStemSeparationResult
} from './mixtapeStemSeparationShared'

const {
  DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS,
  DEMUCS_PROFILE_OPTIONS,
  buildStemProcessEnv,
  createStemError,
  isStemCancelledError,
  normalizeFilePath,
  normalizeText,
  normalizeStemProfile,
  probeAudioDurationSeconds,
  resolveBundledFfprobePath,
  resolveDemucsSegmentSec,
  resolveDemucsRawStemPath,
  resolveStemCacheDir,
  resolveStemProcessTimeoutMs,
  runProcess,
  throwIfStemCancelled
} = shared

const {
  parseDemucsProgressText,
  invalidateStemDeviceProbeCache,
  probeDemucsDevices,
  resolveCpuFallbackReason,
  resolveDemucsDeviceArg
} = probe

const STEM_INFERENCE_PROGRESS_MAX_PERCENT = 94
const STEM_INFERENCE_ACTIVITY_CHECK_INTERVAL_MS = 60 * 1000

const parseStemRenderingStage = (line: string): { completed: number; total: number } | null => {
  const match = String(line || '')
    .trim()
    .match(/^FRKB_STEM_STAGE=rendering:(\d+)\/(\d+)$/)
  if (!match) return null
  const completed = Number(match[1])
  const total = Number(match[2])
  if (!Number.isInteger(completed) || !Number.isInteger(total) || total <= 0) return null
  if (completed < 0 || completed > total) return null
  return { completed, total }
}

const isStemInferenceHeartbeat = (line: string) => line.trim() === 'FRKB_STEM_HEARTBEAT'

const resolveDemucsBootstrapPath = () =>
  path.join(resolveBundledDemucsBootstrapDirPath(), 'mixtape_demucs_bootstrap.py')

const getErrorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object') return ''
  return normalizeText(Reflect.get(error, 'code'), 80)
}

type DemucsWaveformBootstrapInput = {
  pcmPath: string
  inputSampleRate: number
  inputChannels: number
  inputFrames: number
  pcmBytes: number
  decoderBackend: string
}

type DemucsWaveformBootstrapPayload = {
  mode: 'waveform_inference'
  inputPcmPath: string
  inputSampleRate: number
  inputChannels: number
  inputFrames: number
  device: string
  modelName: string
  modelRepoPath: string
  outputDir: string
  shifts: number
  overlap: number
  split: boolean
  segmentSec: number | null
  jobs: number
  sourcePath: string
}

const runDemucsSeparate = async (params: {
  pythonPath: string
  demucsArgs: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  traceLabel: string
  useBootstrap: boolean
  signal?: AbortSignal
  onStderrChunk?: (chunk: string) => void
}) => {
  throwIfStemCancelled(params.signal)
  if (!params.useBootstrap) {
    await runProcess(params.pythonPath, ['-m', 'demucs.separate', ...params.demucsArgs], {
      env: params.env,
      timeoutMs: params.timeoutMs,
      traceLabel: params.traceLabel,
      progressIntervalMs: 30_000,
      signal: params.signal,
      onStderrChunk: params.onStderrChunk
    })
    return
  }
  const argvPayload = JSON.stringify(['demucs.separate', ...params.demucsArgs])
  const bootstrapPath = resolveDemucsBootstrapPath()
  if (!fs.existsSync(bootstrapPath)) {
    await runProcess(params.pythonPath, ['-m', 'demucs.separate', ...params.demucsArgs], {
      env: params.env,
      timeoutMs: params.timeoutMs,
      traceLabel: params.traceLabel,
      progressIntervalMs: 30_000,
      signal: params.signal,
      onStderrChunk: params.onStderrChunk
    })
    return
  }
  await runProcess(params.pythonPath, [bootstrapPath, argvPayload], {
    env: params.env,
    timeoutMs: params.timeoutMs,
    traceLabel: params.traceLabel,
    progressIntervalMs: 30_000,
    signal: params.signal,
    onStderrChunk: params.onStderrChunk
  })
}

// 注意：此函数将整个音频文件解码到内存，对于大文件（如 10 分钟立体声）可能占用 ~200MB。
// 这是当前设计的选择：stem 分离需要完整 PCM 数据，且用户通常不会同时处理多个大文件。
// 如需优化，可考虑流式解码 + 写入，但会增加代码复杂度。
const prepareDemucsWaveformBootstrapInput = async (params: {
  filePath: string
  inputDir: string
}): Promise<DemucsWaveformBootstrapInput> => {
  const decoded = await decodeAudioShared(params.filePath, {
    traceLabel: 'mixtape-stem-waveform-bootstrap',
    priority: 'high'
  })
  const pcmData = Buffer.isBuffer(decoded.pcmData) ? decoded.pcmData : Buffer.from(decoded.pcmData)
  const inputSampleRate = Math.max(0, Math.floor(Number(decoded.sampleRate) || 0))
  const inputChannels = Math.max(0, Math.floor(Number(decoded.channels) || 0))
  const inputFrames = Math.max(0, Math.floor(Number(decoded.totalFrames) || 0))
  const expectedBytes = inputFrames * inputChannels * 4
  if (!pcmData.byteLength || inputSampleRate <= 0 || inputChannels <= 0 || inputFrames <= 0) {
    throw createStemError('STEM_DECODE_INVALID', 'Stem 输入解码结果无效')
  }
  if (expectedBytes > 0 && pcmData.byteLength !== expectedBytes) {
    throw createStemError(
      'STEM_DECODE_INVALID',
      `Stem 输入 PCM 字节数异常: expected=${expectedBytes} actual=${pcmData.byteLength}`
    )
  }
  await fs.promises.mkdir(params.inputDir, { recursive: true })
  const pcmPath = path.join(params.inputDir, 'input.f32')
  await fs.promises.writeFile(pcmPath, pcmData)
  return {
    pcmPath,
    inputSampleRate,
    inputChannels,
    inputFrames,
    pcmBytes: pcmData.byteLength,
    decoderBackend: normalizeText(decoded.decoderBackend, 80) || 'unknown'
  }
}

const runDemucsWaveformInference = async (params: {
  pythonPath: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  traceLabel: string
  payload: DemucsWaveformBootstrapPayload
  signal?: AbortSignal
  onStderrChunk?: (chunk: string) => void
}) => {
  throwIfStemCancelled(params.signal)
  const bootstrapPath = resolveDemucsBootstrapPath()
  if (!fs.existsSync(bootstrapPath)) {
    throw createStemError('STEM_BOOTSTRAP_MISSING', `未找到 Demucs bootstrap: ${bootstrapPath}`)
  }
  const payloadJson = JSON.stringify(params.payload)
  await runProcess(params.pythonPath, [bootstrapPath, payloadJson], {
    env: params.env,
    timeoutMs: params.timeoutMs,
    traceLabel: params.traceLabel,
    progressIntervalMs: 30_000,
    signal: params.signal,
    onStderrChunk: params.onStderrChunk
  })
}

const shouldRetryWithNextDevice = (error: unknown): boolean => {
  if (isStemCancelledError(error)) return false
  const message = normalizeText(
    error instanceof Error ? error.message : String(error || ''),
    4000
  ).toLowerCase()
  if (!message) return false
  const patterns = [
    'torch not compiled with cuda enabled',
    'cuda unavailable',
    'no cuda gpus are available',
    'invalid device string',
    'expected one of cpu',
    'weights_only',
    'weights only load failed',
    'unpickler',
    'unsupported global',
    'mps backend',
    'device type mps',
    'is not available for this process',
    'out of memory',
    'cudnn',
    'hip',
    'torchcodec',
    'libtorchcodec',
    'libtorio',
    'ffmpeg',
    'xpu',
    'oneapi',
    'level zero',
    'directml',
    'privateuseone',
    'dml'
  ]
  return patterns.some((pattern) => message.includes(pattern))
}

const shouldRetryWithFallbackModel = (error: unknown): boolean => {
  if (isStemCancelledError(error)) return false
  const message = normalizeText(
    error instanceof Error ? error.message : String(error || ''),
    4000
  ).toLowerCase()
  if (!message) return false
  const patterns = [
    'unknown model',
    'could not find pre-trained model',
    'model not found',
    'no such file or directory',
    'diffq is not installed',
    'trying to use diffq'
  ]
  return patterns.some((pattern) => message.includes(pattern))
}

const listLocalDemucsWeightFiles = (modelRepoPath: string): string[] => {
  try {
    return fs
      .readdirSync(modelRepoPath)
      .map((name) => normalizeText(name, 300).toLowerCase())
      .filter((name) => name.endsWith('.th'))
  } catch {
    return []
  }
}

const parseLocalDemucsYamlModelIds = (yamlRaw: string): string[] => {
  const matches = Array.from(String(yamlRaw || '').matchAll(/['"]([0-9a-f]{8})['"]/gi))
  return Array.from(new Set(matches.map((match) => String(match[1] || '').toLowerCase())))
}

const inspectLocalDemucsModel = (params: {
  modelRepoPath: string
  demucsModelName: string
  localWeightFiles: string[]
}): {
  available: boolean
  reason: string
} => {
  const modelRepoPath = normalizeFilePath(params.modelRepoPath)
  const demucsModelName = normalizeText(params.demucsModelName, 128)
  if (!modelRepoPath || !demucsModelName) {
    return {
      available: false,
      reason: 'MODEL_NAME_EMPTY'
    }
  }
  const localModelYaml = path.join(modelRepoPath, `${demucsModelName}.yaml`)
  if (!fs.existsSync(localModelYaml)) {
    return {
      available: false,
      reason: 'MODEL_YAML_MISSING'
    }
  }
  const yamlRaw = fs.readFileSync(localModelYaml, 'utf8')
  const modelIds = parseLocalDemucsYamlModelIds(yamlRaw)
  if (!modelIds.length) {
    return {
      available: true,
      reason: 'MODEL_YAML_NO_WEIGHT_ID'
    }
  }
  const localWeightFiles = Array.isArray(params.localWeightFiles) ? params.localWeightFiles : []
  const missingModelIds = modelIds.filter(
    (id) =>
      !localWeightFiles.some((filename) => filename.startsWith(`${id}-`) || filename === `${id}.th`)
  )
  if (missingModelIds.length > 0) {
    return {
      available: false,
      reason: `MODEL_WEIGHT_MISSING:${missingModelIds.join(',')}`
    }
  }
  return {
    available: true,
    reason: 'OK'
  }
}

const resolveDemucsModelCandidates = (params: {
  requestedModel: string
  modelRepoPath: string
}): string[] => {
  const requestedModel = normalizeText(params.requestedModel, 128)
  const localWeightFiles = listLocalDemucsWeightFiles(params.modelRepoPath)
  const inspected = inspectLocalDemucsModel({
    modelRepoPath: params.modelRepoPath,
    demucsModelName: requestedModel,
    localWeightFiles
  })
  if (!inspected.available) {
    throw createStemError(
      'STEM_MODEL_MISSING',
      `未找到请求的本地 Demucs 模型，请检查 ${params.modelRepoPath}: ${requestedModel}:${inspected.reason}`
    )
  }
  return [requestedModel]
}

export const runStemSeparation = async (params: {
  filePath: string
  sourceSignature?: string
  stemMode: MixtapeStemMode
  model: string
  signal?: AbortSignal
  onDeviceStart?: (
    device: MixtapeStemComputeDevice,
    context?: {
      reasonCode?: MixtapeStemCpuFallbackReasonCode
      reasonDetail?: string
    }
  ) => void
  onProgress?: (progress: MixtapeStemRuntimeProgress) => void
}): Promise<MixtapeStemSeparationResult> => {
  const filePath = normalizeFilePath(params.filePath)
  if (!filePath || !fs.existsSync(filePath)) {
    throw createStemError('STEM_SOURCE_MISSING', 'Stem 源文件不存在')
  }
  const parsedModel = parseMixtapeStemModel(params.model, DEFAULT_MIXTAPE_STEM_PROFILE)
  const requestedDemucsModelName =
    normalizeText(parsedModel.demucsModel, 128) || DEFAULT_MIXTAPE_STEM_BASE_MODEL
  const stemProfile = normalizeStemProfile(parsedModel.profile, DEFAULT_MIXTAPE_STEM_PROFILE)
  let modelRepoPath: string
  if (stemProfile === 'ultra') {
    modelRepoPath = resolveInstalledDemucsModelPath(requestedDemucsModelName)
  } else {
    if (!isDemucsBaseModelName(requestedDemucsModelName)) {
      throw createStemError(
        'STEM_MODEL_UNSUPPORTED',
        `不支持的基础 Stem 模型: ${requestedDemucsModelName || '<empty>'}`
      )
    }
    modelRepoPath = await ensureDemucsBaseModel(requestedDemucsModelName)
  }
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobePath = resolveBundledFfprobePath()
  if (!fs.existsSync(modelRepoPath)) {
    throw createStemError('STEM_MODEL_MISSING', `未找到 Demucs 模型目录: ${modelRepoPath}`)
  }
  if (!fs.existsSync(ffmpegPath)) {
    throw createStemError('STEM_FFMPEG_MISSING', `未找到 ffmpeg: ${ffmpegPath}`)
  }
  if (!fs.existsSync(ffprobePath)) {
    throw createStemError('STEM_FFPROBE_MISSING', `未找到 ffprobe: ${ffprobePath}`)
  }
  let deviceSnapshot = await probeDemucsDevices(ffmpegPath)
  throwIfStemCancelled(params.signal)

  const stemCacheDir = await resolveStemCacheDir({
    filePath,
    sourceSignature: normalizeText(params.sourceSignature, 160),
    model: params.model,
    stemMode: params.stemMode
  })
  const rawOutputRoot = path.join(stemCacheDir, '__raw')
  const bootstrapInputDir = path.join(stemCacheDir, '__input')
  await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rm(bootstrapInputDir, { recursive: true, force: true }).catch(() => {})
  await fs.promises.mkdir(rawOutputRoot, { recursive: true })

  const inputDurationSec = await probeAudioDurationSeconds(ffprobePath, filePath)
  const preferNoSplit =
    Number.isFinite(inputDurationSec) &&
    Number(inputDurationSec) > 0 &&
    Number(inputDurationSec) <= DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS
  let runtimeDir = normalizeFilePath(deviceSnapshot.runtimeDir) || resolveBundledDemucsRuntimeDir()
  let pythonPath =
    normalizeFilePath(deviceSnapshot.pythonPath) || resolveBundledDemucsPythonPath(runtimeDir)
  if (!fs.existsSync(pythonPath)) {
    const downloaded = await downloadPreferredStemRuntime('stem')
    throwIfStemCancelled(params.signal)
    if (downloaded) {
      invalidateStemDeviceProbeCache()
      deviceSnapshot = await probeDemucsDevices(ffmpegPath)
      runtimeDir = normalizeFilePath(deviceSnapshot.runtimeDir) || resolveBundledDemucsRuntimeDir()
      pythonPath =
        normalizeFilePath(deviceSnapshot.pythonPath) || resolveBundledDemucsPythonPath(runtimeDir)
    } else {
      const runtimeDownloadState = getStemRuntimeDownloadState()
      const downloadError =
        normalizeText(runtimeDownloadState.error, 600) ||
        normalizeText(runtimeDownloadState.message, 240)
      if (runtimeDownloadState.status === 'failed' && downloadError) {
        throw createStemError('STEM_ENGINE_BROKEN', `Demucs 运行时安装失败: ${downloadError}`)
      }
    }
  }
  if (!fs.existsSync(pythonPath)) {
    throw createStemError(
      'STEM_ENGINE_MISSING',
      `未找到 Demucs 运行时: ${pythonPath} (runtime=${deviceSnapshot.runtimeKey})`
    )
  }
  if (!deviceSnapshot.runtimeUsable) {
    throw createStemError(
      'STEM_ENGINE_BROKEN',
      `Demucs 运行时不可用: ${deviceSnapshot.probeError || `runtime=${deviceSnapshot.runtimeKey}`}`
    )
  }
  const env = buildStemProcessEnv(runtimeDir, ffmpegPath)
  let waveformBootstrapInput: DemucsWaveformBootstrapInput | null = null
  let waveformBootstrapReady = false
  try {
    waveformBootstrapInput = await prepareDemucsWaveformBootstrapInput({
      filePath,
      inputDir: bootstrapInputDir
    })
    throwIfStemCancelled(params.signal)
    waveformBootstrapReady = fs.existsSync(resolveDemucsBootstrapPath())
  } catch {
    // waveform bootstrap 是性能优化路径；失败后会走常规 Demucs 分离。
    // 这里不是最终错误，避免把可恢复降级写入 log.txt 干扰错误上报。
  }

  const demucsModelCandidates = resolveDemucsModelCandidates({
    requestedModel: requestedDemucsModelName,
    modelRepoPath
  })
  const deviceCandidates: MixtapeStemComputeDevice[] = deviceSnapshot.devices
  let selectedDevice: MixtapeStemComputeDevice | null = null
  let selectedDemucsModelName = ''
  let lastModelError: unknown = null
  let highestProgressPercent = 0
  try {
    for (let modelIndex = 0; modelIndex < demucsModelCandidates.length; modelIndex += 1) {
      const demucsModelName = demucsModelCandidates[modelIndex]
      const profileOptions = DEMUCS_PROFILE_OPTIONS[stemProfile] || DEMUCS_PROFILE_OPTIONS.quality
      const demucsSegmentSec = resolveDemucsSegmentSec({
        demucsModel: demucsModelName,
        requestedSegmentSec: profileOptions.segmentSec
      })
      const isHtDemucsModel = normalizeText(demucsModelName, 128).toLowerCase().includes('htdemucs')
      const noSplitDisabledReason = isHtDemucsModel ? 'htdemucs_requires_segmented_inference' : null
      const runDemucsForDevice = async (device: MixtapeStemComputeDevice) => {
        throwIfStemCancelled(params.signal)
        const processTimeoutMs = resolveStemProcessTimeoutMs({
          device,
          inputDurationSec
        })
        const demucsDeviceArg = resolveDemucsDeviceArg(device, deviceSnapshot)
        const demucsBaseArgs = [
          '-n',
          demucsModelName,
          '--repo',
          modelRepoPath,
          '-d',
          demucsDeviceArg,
          '-j',
          '1',
          '--filename',
          '{stem}.{ext}',
          '-o',
          rawOutputRoot,
          '--shifts',
          profileOptions.shifts
        ]
        const demucsSplitArgs = [
          ...demucsBaseArgs,
          '--overlap',
          profileOptions.overlap,
          '--segment',
          demucsSegmentSec,
          filePath
        ]
        const demucsNoSplitArgs = [...demucsBaseArgs, '--no-split', filePath]
        await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
        await fs.promises.mkdir(rawOutputRoot, { recursive: true })
        let lastProgressEmitAt = 0
        let lastProgressPercent = -1
        let lastProgressAdvancedAt = Date.now()
        const emitProgress = (parsed: {
          percent: number
          processedSec: number | null
          totalSec: number | null
          etaSec: number | null
        }) => {
          const now = Date.now()
          const reportedPercent = Math.max(0, Math.min(100, Math.round(parsed.percent)))
          const percent = Math.min(STEM_INFERENCE_PROGRESS_MAX_PERCENT, reportedPercent)
          if (percent < highestProgressPercent) return
          const isInitialProgress = percent === 0 && highestProgressPercent === 0
          if (!isInitialProgress) {
            const noPercentChange = percent === lastProgressPercent
            if (noPercentChange && now - lastProgressEmitAt < 2000) return
          }
          highestProgressPercent = percent
          if (percent > lastProgressPercent) lastProgressAdvancedAt = now
          lastProgressEmitAt = now
          lastProgressPercent = percent
          params.onProgress?.({
            device,
            stage: 'separating',
            percent,
            stageCompleted: null,
            stageTotal: null,
            processedSec: parsed.processedSec,
            totalSec: parsed.totalSec,
            etaSec: parsed.etaSec
          })
        }
        const emitInferenceActivityConfirmation = () => {
          const now = Date.now()
          if (now - lastProgressAdvancedAt < STEM_INFERENCE_ACTIVITY_CHECK_INTERVAL_MS) return
          params.onProgress?.({
            device,
            stage: 'separating',
            percent: highestProgressPercent,
            activityConfirmedAt: now,
            stageCompleted: null,
            stageTotal: null,
            processedSec: null,
            totalSec: null,
            etaSec: null
          })
        }
        const handleStderrChunk = (chunk: string) => {
          const emitRenderingProgress = (stage: { completed: number; total: number }) => {
            const completed = Math.max(0, Math.min(stage.total, stage.completed))
            const total = Math.max(1, stage.total)
            const percent = STEM_INFERENCE_PROGRESS_MAX_PERCENT + (completed / total) * 2
            if (percent < highestProgressPercent) return
            highestProgressPercent = percent
            lastProgressEmitAt = Date.now()
            lastProgressPercent = percent
            params.onProgress?.({
              device,
              stage: 'rendering',
              percent,
              stageCompleted: completed,
              stageTotal: total,
              processedSec:
                Number.isFinite(Number(inputDurationSec)) && Number(inputDurationSec) > 0
                  ? Number(inputDurationSec)
                  : null,
              totalSec:
                Number.isFinite(Number(inputDurationSec)) && Number(inputDurationSec) > 0
                  ? Number(inputDurationSec)
                  : null,
              etaSec: null
            })
          }

          const chunks = chunk.split(/[\r\n]+/)
          for (const line of chunks) {
            if (isStemInferenceHeartbeat(line)) {
              emitInferenceActivityConfirmation()
              continue
            }
            const renderingStage = parseStemRenderingStage(line)
            if (renderingStage) {
              emitRenderingProgress(renderingStage)
              continue
            }
            const parsed = parseDemucsProgressText(line)
            if (!parsed) continue
            emitProgress(parsed)
          }
        }
        emitProgress({
          percent: 0,
          processedSec: 0,
          totalSec:
            Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
              ? inputDurationSec
              : null,
          etaSec: null
        })
        const allowNoSplit =
          preferNoSplit && device !== 'cpu' && device !== 'xpu' && !noSplitDisabledReason
        const runWaveformBootstrap = async (split: boolean) => {
          if (!waveformBootstrapInput || !waveformBootstrapReady) {
            throw createStemError('STEM_BOOTSTRAP_UNAVAILABLE', 'Waveform bootstrap 不可用')
          }
          const payload: DemucsWaveformBootstrapPayload = {
            mode: 'waveform_inference',
            inputPcmPath: waveformBootstrapInput.pcmPath,
            inputSampleRate: waveformBootstrapInput.inputSampleRate,
            inputChannels: waveformBootstrapInput.inputChannels,
            inputFrames: waveformBootstrapInput.inputFrames,
            device: demucsDeviceArg,
            modelName: demucsModelName,
            modelRepoPath,
            outputDir: rawOutputRoot,
            shifts: Math.max(1, Number(profileOptions.shifts) || 1),
            overlap: Math.max(0, Number(profileOptions.overlap) || 0),
            split,
            segmentSec: split ? Math.max(1, Number(demucsSegmentSec) || 1) : null,
            jobs: 1,
            sourcePath: filePath
          }
          if (device === 'xpu') {
            try {
              await runPersistentXpuStemInference({
                pythonPath,
                env,
                timeoutMs: processTimeoutMs,
                traceLabel: `mixtape-stem-waveform:${demucsModelName}:${device}`,
                payload,
                signal: params.signal,
                onStderrChunk: handleStderrChunk
              })
              return
            } catch (error) {
              if (isStemCancelledError(error)) throw error
              // XPU 常驻 worker 只是加速路径；失败后仍会尝试普通 bootstrap。
              // 最终不可恢复错误会由外层设备/模型重试链路抛出，这里保持静默。
              await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
              await fs.promises.mkdir(rawOutputRoot, { recursive: true })
            }
          }
          await runDemucsWaveformInference({
            pythonPath,
            env,
            timeoutMs: processTimeoutMs,
            traceLabel: `mixtape-stem-waveform:${demucsModelName}:${device}`,
            payload,
            signal: params.signal,
            onStderrChunk: handleStderrChunk
          })
        }
        const runDeviceInference = async (split: boolean) => {
          if (waveformBootstrapInput && waveformBootstrapReady) {
            await runWaveformBootstrap(split)
            return
          }
          await runDemucsSeparate({
            pythonPath,
            demucsArgs: split ? demucsSplitArgs : demucsNoSplitArgs,
            env,
            timeoutMs: processTimeoutMs,
            traceLabel: `mixtape-stem-demucs:${demucsModelName}:${device}`,
            useBootstrap: device !== 'cpu',
            signal: params.signal,
            onStderrChunk: handleStderrChunk
          })
        }
        if (!allowNoSplit) {
          await runDeviceInference(true)
          emitProgress({
            percent: 100,
            processedSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            totalSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            etaSec: 0
          })
          return
        }
        try {
          await runDeviceInference(false)
          emitProgress({
            percent: 100,
            processedSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            totalSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            etaSec: 0
          })
        } catch (error) {
          if (isStemCancelledError(error)) throw error
          // no-split 只是短音频优化路径；失败后立即回到 split 模式。
          // split 再失败时外层会抛出真实错误，不在这里提前污染 log.txt。
          await runDeviceInference(true)
          emitProgress({
            percent: 100,
            processedSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            totalSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            etaSec: 0
          })
        }
      }
      let currentSelectedDevice: MixtapeStemComputeDevice | null = null
      let lastDeviceError: unknown = null
      const retryableDeviceFailures: Array<{
        device: MixtapeStemComputeDevice
        errorCode: string
        errorMessage: string
      }> = []
      try {
        for (let index = 0; index < deviceCandidates.length; index += 1) {
          const device = deviceCandidates[index]
          try {
            if (device === 'cpu') {
              const firstFailure = retryableDeviceFailures[0] || null
              const { reasonCode, reasonDetail } = resolveCpuFallbackReason({
                deviceSnapshot,
                firstFailure
              })
              params.onDeviceStart?.(device, {
                reasonCode,
                reasonDetail
              })
            } else {
              params.onDeviceStart?.(device)
            }
          } catch {}
          try {
            await runDemucsForDevice(device)
            currentSelectedDevice = device
            break
          } catch (error) {
            lastDeviceError = error
            const hasNext = index < deviceCandidates.length - 1
            const retryable = hasNext && shouldRetryWithNextDevice(error)
            const normalizedErrorCode = getErrorCode(error)
            const normalizedErrorMessage = normalizeText(
              error instanceof Error ? error.message : String(error || ''),
              800
            )
            if (retryable) {
              retryableDeviceFailures.push({
                device,
                errorCode: normalizedErrorCode,
                errorMessage: normalizedErrorMessage
              })
            }
            if (!retryable) {
              throw error
            }
          }
        }
        if (!currentSelectedDevice) {
          throw (
            lastDeviceError ||
            createStemError('STEM_SPLIT_FAILED', 'Demucs 分离失败：未找到可用设备')
          )
        }
        selectedDevice = currentSelectedDevice
        selectedDemucsModelName = demucsModelName
        break
      } catch (error) {
        lastModelError = error
        const hasNextModel = modelIndex < demucsModelCandidates.length - 1
        const retryWithFallbackModel = hasNextModel && shouldRetryWithFallbackModel(error)
        if (retryWithFallbackModel) {
          continue
        }
        throw error
      }
    }
    if (!selectedDevice || !selectedDemucsModelName) {
      throw (
        lastModelError || createStemError('STEM_SPLIT_FAILED', 'Demucs 分离失败：未找到可用模型')
      )
    }
  } catch (error) {
    await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
    await fs.promises.rm(bootstrapInputDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  const completedDevice = selectedDevice
  const emitPostInferenceProgress = (progress: {
    stage: 'validating' | 'saving' | 'cleaning'
    percent: number
    stageCompleted: number | null
    stageTotal: number | null
  }) => {
    params.onProgress?.({
      device: completedDevice,
      stage: progress.stage,
      percent: progress.percent,
      stageCompleted: progress.stageCompleted,
      stageTotal: progress.stageTotal,
      processedSec:
        Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0 ? inputDurationSec : null,
      totalSec:
        Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0 ? inputDurationSec : null,
      etaSec: null
    })
  }
  let stemAssetsWritten = false
  try {
    emitPostInferenceProgress({
      stage: 'validating',
      percent: 97,
      stageCompleted: null,
      stageTotal: null
    })
    const vocalsPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: selectedDemucsModelName,
      filePath,
      stemName: 'vocals'
    })
    const drumsPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: selectedDemucsModelName,
      filePath,
      stemName: 'drums'
    })
    const bassPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: selectedDemucsModelName,
      filePath,
      stemName: 'bass'
    })
    const otherPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: selectedDemucsModelName,
      filePath,
      stemName: 'other'
    })

    if (!vocalsPath || !drumsPath || !bassPath || !otherPath) {
      throw createStemError('STEM_SPLIT_OUTPUT_MISSING', 'Demucs 输出不完整，缺少 stems 文件')
    }

    await fs.promises.mkdir(stemCacheDir, { recursive: true })
    const vocalOutputPath = path.join(stemCacheDir, 'vocal.wav')
    const instOutputPath = path.join(stemCacheDir, 'inst.wav')
    const drumsOutputPath = path.join(stemCacheDir, 'drums.wav')
    const bassOutputPath = path.join(stemCacheDir, 'bass.wav')
    const stemOutputs = [
      [vocalsPath, vocalOutputPath],
      [otherPath, instOutputPath],
      [bassPath, bassOutputPath],
      [drumsPath, drumsOutputPath]
    ] as const
    emitPostInferenceProgress({
      stage: 'saving',
      percent: 98,
      stageCompleted: 0,
      stageTotal: stemOutputs.length
    })
    for (const [index, [sourcePath, outputPath]] of stemOutputs.entries()) {
      await fs.promises.copyFile(sourcePath, outputPath)
      emitPostInferenceProgress({
        stage: 'saving',
        percent: 98 + (index + 1) / stemOutputs.length,
        stageCompleted: index + 1,
        stageTotal: stemOutputs.length
      })
    }
    stemAssetsWritten = true
    return {
      vocalPath: vocalOutputPath,
      instPath: instOutputPath,
      bassPath: bassOutputPath,
      drumsPath: drumsOutputPath
    }
  } finally {
    if (stemAssetsWritten) {
      emitPostInferenceProgress({
        stage: 'cleaning',
        percent: 99,
        stageCompleted: 0,
        stageTotal: 2
      })
    }
    await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
    if (stemAssetsWritten) {
      emitPostInferenceProgress({
        stage: 'cleaning',
        percent: 99,
        stageCompleted: 1,
        stageTotal: 2
      })
    }
    await fs.promises.rm(bootstrapInputDir, { recursive: true, force: true }).catch(() => {})
    if (stemAssetsWritten) {
      emitPostInferenceProgress({
        stage: 'cleaning',
        percent: 99,
        stageCompleted: 2,
        stageTotal: 2
      })
    }
  }
}
