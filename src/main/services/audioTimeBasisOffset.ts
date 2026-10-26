import path from 'node:path'
import { mainFilePathKey } from '../filePathComparison'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import { log } from '../log'
import { runWithConcurrency } from '../nodeTaskUtils'
import { probeAudioTimeBasisOffsetMs } from './audioTimeBasisOffsetProbe'

export const CURRENT_AUDIO_TIME_BASIS_OFFSET_ALGORITHM_VERSION = 1
export const AUDIO_TIME_BASIS_PROBE_CONCURRENCY = 4

const timeBasisOffsetCache = new Map<string, Promise<number>>()
const toFixedMs = (value: number) => Number(value.toFixed(3))

const normalizeLookupKey = (value: unknown) =>
  mainFilePathKey(typeof value === 'string' ? value : '')

type RustTimeBasisBinding = {
  probeAudioTimeBasisOffsetMs?: (filePath: string) => number | Promise<number>
  probeAudioTimeBasisOffsetMsBatch?: (filePaths: string[]) => number[] | Promise<number[]>
}

let rustTimeBasisBinding: RustTimeBasisBinding | null | undefined

const loadRustTimeBasisBinding = (): RustTimeBasisBinding | null => {
  if (rustTimeBasisBinding !== undefined) return rustTimeBasisBinding
  try {
    const binding = require('rust_package') as RustTimeBasisBinding
    if (typeof binding.probeAudioTimeBasisOffsetMsBatch !== 'function') {
      rustTimeBasisBinding = null
      return null
    }
    rustTimeBasisBinding = binding
    return binding
  } catch {
    rustTimeBasisBinding = null
    return null
  }
}

const cacheResolvedPath = (filePath: string) => {
  const resolved = path.resolve(filePath)
  return {
    resolved,
    cacheKey: normalizeLookupKey(resolved)
  }
}

export const resolveBundledFfprobePath = () => {
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(path.dirname(ffmpegPath), ffprobeName)
}

const probeFfmpegTimeBasisOffsetMs = async (filePath: string): Promise<number> => {
  let ffprobePath = ''
  try {
    ffprobePath = resolveBundledFfprobePath()
  } catch {
    return 0
  }
  const result = await probeAudioTimeBasisOffsetMs(ffprobePath, filePath)
  if (result.error) {
    log.error('[audio-time-basis] probe ffmpeg time basis failed', {
      filePath,
      error: result.error
    })
  }
  return result.offsetMs
}

const probeNativeTimeBasisOffsetMs = async (filePath: string): Promise<number> => {
  const rust = loadRustTimeBasisBinding()
  if (typeof rust?.probeAudioTimeBasisOffsetMs !== 'function') {
    return await probeFfmpegTimeBasisOffsetMs(filePath)
  }
  const offset = Number(await rust.probeAudioTimeBasisOffsetMs(filePath))
  return Number.isFinite(offset) ? offset : 0
}

export const resolveAudioTimeBasisOffsetMsForFile = async (filePath: string) => {
  const { resolved, cacheKey } = cacheResolvedPath(filePath)
  if (!cacheKey) return 0
  let promise = timeBasisOffsetCache.get(cacheKey)
  if (!promise) {
    promise = probeNativeTimeBasisOffsetMs(resolved)
    timeBasisOffsetCache.set(cacheKey, promise)
  }
  return await promise
}

export const resolveAudioTimeBasisOffsetMsForFiles = async (filePaths: string[]) => {
  const uniqueResolved: string[] = []
  const seen = new Set<string>()
  for (const filePath of filePaths) {
    const { resolved, cacheKey } = cacheResolvedPath(filePath)
    if (!cacheKey || seen.has(cacheKey) || timeBasisOffsetCache.has(cacheKey)) continue
    seen.add(cacheKey)
    uniqueResolved.push(resolved)
  }
  if (!uniqueResolved.length) return

  const rust = loadRustTimeBasisBinding()
  if (typeof rust?.probeAudioTimeBasisOffsetMsBatch === 'function') {
    const offsets = await rust.probeAudioTimeBasisOffsetMsBatch(uniqueResolved)
    if (Array.isArray(offsets) && offsets.length === uniqueResolved.length) {
      uniqueResolved.forEach((resolved, index) => {
        const offset = Number(offsets[index])
        timeBasisOffsetCache.set(
          normalizeLookupKey(resolved),
          Promise.resolve(Number.isFinite(offset) ? offset : 0)
        )
      })
      return
    }
  }

  await runWithConcurrency(
    uniqueResolved.map((resolved) => async () => resolveAudioTimeBasisOffsetMsForFile(resolved)),
    { concurrency: AUDIO_TIME_BASIS_PROBE_CONCURRENCY }
  )
}

export const hasCachedAudioTimeBasisOffsetMsForFile = (filePath: string) => {
  const { cacheKey } = cacheResolvedPath(filePath)
  return Boolean(cacheKey && timeBasisOffsetCache.has(cacheKey))
}

export const resolveAudioFirstBeatTimelineMs = (
  firstBeatAudioMs: number,
  timeBasisOffsetMs: number
) =>
  toFixedMs(
    (Number.isFinite(Number(firstBeatAudioMs)) ? Number(firstBeatAudioMs) : 0) +
      Math.max(0, Number(timeBasisOffsetMs) || 0)
  )
