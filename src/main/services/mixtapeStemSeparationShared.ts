import fs from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import { registerChildProcess, terminateChildProcess } from './childProcessRegistry'
import type { MixtapeStemMode } from '../mixtapeDb'
import {
  DEFAULT_MIXTAPE_STEM_PROFILE,
  normalizeMixtapeStemProfile,
  type MixtapeStemProfile
} from '../../shared/mixtapeStemProfiles'
import { resolveLibraryStemCacheDir } from './libraryStemAssetStorage'

export const STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2 = 16
export const STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3 = 24
export const STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2 = 5
export const STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3 = 8
const STEM_PROCESS_TIMEOUT_MS = 60 * 60 * 1000
const STEM_PROCESS_TIMEOUT_MAX_MS = 2 * 60 * 60 * 1000
const STEM_CPU_PROCESS_TIMEOUT_CAP_MS = 8 * 60 * 1000
const STEM_GPU_PROCESS_TIMEOUT_CAP_MS = STEM_PROCESS_TIMEOUT_MS
const STEM_CPU_PROCESS_TIMEOUT_MIN_MS = 4 * 60 * 1000
const STEM_GPU_PROCESS_TIMEOUT_MIN_MS = 3 * 60 * 1000
const STEM_FFPROBE_TIMEOUT_MS = 20_000
export const STEM_DEVICE_PROBE_TIMEOUT_MS = 60_000
export const STEM_RUNTIME_INSTALL_VALIDATION_TIMEOUT_MS = 90_000
export const STEM_DEVICE_COMPATIBILITY_TIMEOUT_MS = 12_000
export { STEM_DEVICE_PROBE_CACHE_TTL_MS } from './mixtapeStemDeviceProbeResult'
export const STEM_WINDOWS_GPU_ADAPTER_PROBE_TIMEOUT_MS = 6_000
export const DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS = 7 * 60
const DEMUCS_HTDEMUCS_MAX_SEGMENT_SECONDS = 7.8
export const DEMUCS_PROFILE_OPTIONS: Record<
  MixtapeStemProfile,
  { shifts: string; overlap: string; segmentSec: string }
> = {
  quality: {
    shifts: '4',
    overlap: '0.5',
    segmentSec: '11'
  },
  ultra: {
    shifts: '4',
    overlap: '0.5',
    segmentSec: '7.8'
  }
}
export type MixtapeStemSeparationResult = {
  vocalPath?: string | null
  instPath?: string | null
  bassPath?: string | null
  drumsPath?: string | null
}

export type MixtapeStemComputeDevice = 'cuda' | 'mps' | 'xpu' | 'directml' | 'cpu'
export type MixtapeStemRuntimeStage =
  'separating' | 'rendering' | 'validating' | 'saving' | 'cleaning'
export type MixtapeStemCpuFallbackReasonCode =
  'gpu_unavailable' | 'gpu_failed' | 'gpu_backend_missing'
export type MixtapeStemRuntimeProgress = {
  device: MixtapeStemComputeDevice
  stage: MixtapeStemRuntimeStage
  percent: number
  activityConfirmedAt?: number | null
  stageCompleted: number | null
  stageTotal: number | null
  processedSec: number | null
  totalSec: number | null
  etaSec: number | null
}

export type MixtapeStemDeviceProbeSnapshot = {
  checkedAt: number
  runtimeKey: string
  runtimeDir: string
  pythonPath: string
  runtimeUsable: boolean
  probeInconclusive?: boolean
  importOk?: boolean
  probeError: string
  devices: MixtapeStemComputeDevice[]
  cudaAvailable: boolean
  mpsAvailable: boolean
  xpuAvailable: boolean
  xpuBackendInstalled: boolean
  xpuDemucsCompatible: boolean
  anyXpuBackendInstalled: boolean
  directmlAvailable: boolean
  directmlBackendInstalled: boolean
  directmlDemucsCompatible: boolean
  anyDirectmlBackendInstalled: boolean
  directmlDevice: string
  windowsAdapterNames: string[]
  windowsHasIntelAdapter: boolean
  windowsHasAmdAdapter: boolean
  windowsHasNvidiaAdapter: boolean
}

export const resolveStemProcessTimeoutMs = (params: {
  device: MixtapeStemComputeDevice
  inputDurationSec: number | null
}): number => {
  const isCpu = params.device === 'cpu'
  const timeoutCapMs = isCpu ? STEM_CPU_PROCESS_TIMEOUT_CAP_MS : STEM_GPU_PROCESS_TIMEOUT_CAP_MS
  const timeoutMinMs = isCpu ? STEM_CPU_PROCESS_TIMEOUT_MIN_MS : STEM_GPU_PROCESS_TIMEOUT_MIN_MS
  if (!Number.isFinite(params.inputDurationSec) || Number(params.inputDurationSec) <= 0) {
    return timeoutCapMs
  }
  const factor = isCpu ? 2.8 : 8
  const durationBasedMs = Math.round(Number(params.inputDurationSec) * 1000 * factor)
  return Math.max(timeoutMinMs, Math.min(timeoutCapMs, durationBasedMs))
}

export const normalizeText = (value: unknown, maxLen = 2000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

export const normalizeNumberOrNull = (value: unknown): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

const toDemucsSegmentSecArg = (value: number): string => {
  const parsed = Number(value)
  const safeValue = Number.isFinite(parsed) && parsed > 0 ? parsed : 7
  const rounded = Math.max(1, Math.round(safeValue * 10) / 10)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export const resolveDemucsSegmentSec = (params: {
  demucsModel: string
  requestedSegmentSec: string
}): string => {
  const requested = Number(params.requestedSegmentSec)
  const safeRequested = Number.isFinite(requested) && requested > 0 ? requested : 7
  const model = normalizeText(params.demucsModel, 128).toLowerCase()
  const capped = model.includes('htdemucs')
    ? Math.min(safeRequested, DEMUCS_HTDEMUCS_MAX_SEGMENT_SECONDS)
    : safeRequested
  return toDemucsSegmentSecArg(capped)
}

export const normalizeFilePath = (value: unknown): string => normalizeText(value, 4000)

export const normalizeStemProfile = (
  value: unknown,
  fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): MixtapeStemProfile => normalizeMixtapeStemProfile(normalizeText(value, 24), fallback)

export const createStemError = (code: string, message: string): Error & { code: string } => {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

export const STEM_CANCELLED_CODE = 'STEM_CANCELLED'

export const createStemCancelledError = () =>
  createStemError(STEM_CANCELLED_CODE, 'Stem 分离已取消')

export const isStemCancelledError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  return (
    Reflect.get(error, 'code') === STEM_CANCELLED_CODE ||
    Reflect.get(error, 'name') === 'AbortError'
  )
}

export const throwIfStemCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw createStemCancelledError()
}

export const resolveStemCacheDir = async (params: {
  filePath: string
  sourceSignature?: string
  model: string
  stemMode: MixtapeStemMode
}) =>
  await resolveLibraryStemCacheDir({
    filePath: params.filePath,
    sourceSignature: normalizeText(params.sourceSignature, 160),
    model: params.model,
    stemMode: params.stemMode
  })

export const resolveDemucsRawStemPath = (params: {
  rawOutputRoot: string
  model: string
  filePath: string
  stemName: 'vocals' | 'drums' | 'bass' | 'other'
}) => {
  const trackName = path.parse(params.filePath).name
  const candidates = [
    path.join(params.rawOutputRoot, params.model, `${params.stemName}.wav`),
    path.join(params.rawOutputRoot, params.model, trackName, `${params.stemName}.wav`)
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return ''
}

export const runProcess = async (
  command: string,
  args: string[],
  options?: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    absoluteTimeoutMs?: number
    traceLabel?: string
    progressIntervalMs?: number
    signal?: AbortSignal
    onStdoutChunk?: (chunk: string) => void
    onStderrChunk?: (chunk: string) => void
  }
) => {
  throwIfStemCancelled(options?.signal)
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now()
    let lastActivityAt = startedAt
    const child = childProcess.spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      windowsHide: true
    })
    registerChildProcess(child, options?.traceLabel || 'stem-separation')
    let stderrText = ''
    let stdoutText = ''
    let timedOut = false
    let aborted = false
    let timeoutReason: 'idle' | 'absolute' | null = null
    const timeoutMs = Math.max(10_000, Number(options?.timeoutMs) || STEM_PROCESS_TIMEOUT_MS)
    const absoluteTimeoutMs = Math.max(
      timeoutMs,
      Math.min(
        STEM_PROCESS_TIMEOUT_MAX_MS,
        Math.max(Number(options?.absoluteTimeoutMs) || 0, timeoutMs * 4)
      )
    )
    const abortProcess = () => {
      if (aborted) return
      aborted = true
      terminateChildProcess(child, options?.traceLabel || 'stem-separation')
    }
    const onAbort = () => abortProcess()
    options?.signal?.addEventListener('abort', onAbort)
    const timeoutWatcher = setInterval(() => {
      if (timedOut || aborted) return
      const now = Date.now()
      if (now - startedAt >= absoluteTimeoutMs) {
        timedOut = true
        timeoutReason = 'absolute'
        terminateChildProcess(child, options?.traceLabel || 'stem-separation')
        return
      }
      if (now - lastActivityAt >= timeoutMs) {
        timedOut = true
        timeoutReason = 'idle'
        terminateChildProcess(child, options?.traceLabel || 'stem-separation')
      }
    }, 1000)
    const cleanup = () => {
      clearInterval(timeoutWatcher)
      options?.signal?.removeEventListener('abort', onAbort)
    }

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk || '')
      if (!text) return
      lastActivityAt = Date.now()
      stdoutText += text
      if (stdoutText.length > 4000) {
        stdoutText = stdoutText.slice(-4000)
      }
      try {
        options?.onStdoutChunk?.(text)
      } catch {}
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '')
      if (!text) return
      lastActivityAt = Date.now()
      stderrText += text
      if (stderrText.length > 6000) {
        stderrText = stderrText.slice(-6000)
      }
      try {
        options?.onStderrChunk?.(text)
      } catch {}
    })
    child.on('error', (error) => {
      cleanup()
      reject(aborted || options?.signal?.aborted ? createStemCancelledError() : error)
    })
    child.on('exit', (code) => {
      cleanup()
      if (aborted || options?.signal?.aborted) {
        reject(createStemCancelledError())
        return
      }
      if (timedOut) {
        const output = normalizeText(`${stderrText}\n${stdoutText}`, 3000)
        const timeoutText =
          timeoutReason === 'idle'
            ? `分离超时（空闲 ${Math.round(timeoutMs / 1000)} 秒）`
            : `分离超时（总时长 ${Math.round(absoluteTimeoutMs / 1000)} 秒）`
        reject(
          createStemError('STEM_SPLIT_TIMEOUT', `${timeoutText}${output ? `: ${output}` : ''}`)
        )
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const output = normalizeText(`${stderrText}\n${stdoutText}`, 3000)
      reject(
        createStemError(
          'STEM_SPLIT_FAILED',
          `Demucs 进程退出码 ${code ?? -1}${output ? `: ${output}` : ''}`
        )
      )
    })
    if (options?.signal?.aborted) abortProcess()
  })
}

export const resolveBundledFfprobePath = () => {
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(path.dirname(ffmpegPath), ffprobeName)
}

export const runProbeProcess = async (params: {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  maxStdoutLen?: number
  maxStderrLen?: number
}) =>
  await new Promise<{
    status: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    error?: string
  }>((resolve) => {
    let stdoutText = ''
    let stderrText = ''
    let finished = false
    let timedOut = false
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    const maxStdoutLen = Math.max(256, Number(params.maxStdoutLen) || 6000)
    const maxStderrLen = Math.max(256, Number(params.maxStderrLen) || 6000)
    const finalize = (status: number | null, error?: string) => {
      if (finished) return
      finished = true
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
      resolve({
        status,
        stdout: stdoutText,
        stderr: stderrText,
        timedOut,
        error: normalizeText(error, 800) || undefined
      })
    }
    let child: childProcess.ChildProcessWithoutNullStreams
    try {
      child = childProcess.spawn(params.command, params.args, {
        windowsHide: true,
        env: params.env
      })
      registerChildProcess(child, 'stem-probe')
    } catch (error) {
      finalize(null, error instanceof Error ? error.message : String(error || 'spawn failed'))
      return
    }
    timeoutTimer = setTimeout(
      () => {
        timedOut = true
        terminateChildProcess(child, 'stem-probe')
      },
      Math.max(1000, Number(params.timeoutMs) || 10_000)
    )
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const text = String(chunk || '')
      if (!text) return
      stdoutText += text
      if (stdoutText.length > maxStdoutLen) {
        stdoutText = stdoutText.slice(-maxStdoutLen)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      const text = String(chunk || '')
      if (!text) return
      stderrText += text
      if (stderrText.length > maxStderrLen) {
        stderrText = stderrText.slice(-maxStderrLen)
      }
    })
    child.on('error', (error) => {
      finalize(null, error instanceof Error ? error.message : String(error || 'process error'))
    })
    child.on('close', (code) => {
      finalize(typeof code === 'number' ? code : null)
    })
  })

export const probeAudioDurationSeconds = async (
  ffprobePath: string,
  filePath: string
): Promise<number | null> => {
  if (!ffprobePath || !filePath) return null
  if (!fs.existsSync(ffprobePath)) return null
  try {
    const result = await runProbeProcess({
      command: ffprobePath,
      args: [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nokey=1:noprint_wrappers=1',
        filePath
      ],
      timeoutMs: STEM_FFPROBE_TIMEOUT_MS,
      maxStdoutLen: 256,
      maxStderrLen: 256
    })
    if (result.status !== 0 || result.timedOut) return null
    const output = normalizeText(result.stdout, 120) || ''
    const seconds = Number(output)
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    return seconds
  } catch {
    return null
  }
}

export const buildStemProcessEnv = (runtimeDir: string, ffmpegPath: string): NodeJS.ProcessEnv => {
  const ffmpegDir = path.dirname(ffmpegPath)
  const pathEntries =
    process.platform === 'win32'
      ? [path.join(runtimeDir, 'Scripts'), path.join(runtimeDir, 'Library', 'bin'), ffmpegDir]
      : [path.join(runtimeDir, 'bin'), ffmpegDir]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...pathEntries, process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    PYTHONIOENCODING: 'utf-8'
  }
  if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = [path.join(runtimeDir, 'lib'), process.env.LD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(path.delimiter)
  } else if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [path.join(runtimeDir, 'lib'), process.env.DYLD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(path.delimiter)
  }
  return env
}

export const resolveStemDevicePriority = (): MixtapeStemComputeDevice[] => {
  if (process.platform === 'darwin') {
    return ['mps', 'cuda', 'cpu']
  }
  if (process.platform === 'win32') {
    return ['cuda', 'xpu', 'directml', 'cpu']
  }
  return ['cuda', 'xpu', 'mps', 'cpu']
}
