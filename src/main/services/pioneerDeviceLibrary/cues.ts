import path from 'node:path'
import type { IPioneerPlaylistTrack, ISongHotCue, ISongMemoryCue } from '../../../types/globals'
import { log } from '../../log'
import { readPioneerCuesInWorker } from './workerPool'
import { resolvePioneerDevicePath } from './devicePath'
import {
  isValidPioneerUsbLoopBeatPair,
  normalizePioneerUsbLoopBeatFields
} from '../../../shared/pioneerUsbLoopBeats'

type RustPioneerHotCueRecord = {
  slot?: number
  label?: string
  timeSec?: number
  isLoop?: boolean
  loopTimeSec?: number | null
  loopNumerator?: number | null
  loopDenominator?: number | null
  comment?: string | null
  colorIndex?: number | null
  colorName?: string | null
  colorHex?: string | null
  source?: string | null
}

type RustPioneerMemoryCueRecord = {
  timeSec?: number
  isLoop?: boolean
  loopTimeSec?: number | null
  loopNumerator?: number | null
  loopDenominator?: number | null
  activeLoop?: boolean | null
  order?: number
  comment?: string | null
  colorIndex?: number | null
  colorName?: string | null
  colorHex?: string | null
  source?: string | null
}

type RustPioneerCueDump = {
  analyzeFilePath?: string
  cueFilePath?: string
  hotCues?: RustPioneerHotCueRecord[]
  memoryCues?: RustPioneerMemoryCueRecord[]
  error?: string
}

type WorkerCueProgressItem = {
  analyzeFilePath?: string
  dump?: RustPioneerCueDump | null
}

type PioneerTrackCueData = {
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
}

export type PioneerCueReadOptions = {
  requireCues?: boolean
}

const normalizeText = (value: unknown) => {
  const text = String(value || '').trim()
  return text || undefined
}

// Preserve existing comment text when submitting a complete cue list.
const normalizeCueComment = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const normalizeNonNegativeNumber = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined
}

const normalizeOptionalInteger = (value: unknown) => {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined
}

const normalizeAbsolutePathKey = (value: string) => {
  const normalized = path.resolve(String(value || '').trim())
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const normalizeHotCueRecord = (record: RustPioneerHotCueRecord): ISongHotCue | null => {
  const slot = normalizeOptionalInteger(record?.slot)
  const sec = normalizeNonNegativeNumber(record?.timeSec)
  if (slot === undefined || sec === undefined) return null
  const loopEndSec = normalizeNonNegativeNumber(record?.loopTimeSec)
  const isLoop = loopEndSec !== undefined && loopEndSec > sec && Boolean(record?.isLoop)
  return {
    slot,
    sec,
    label: normalizeText(record?.label),
    comment: normalizeCueComment(record?.comment),
    colorIndex: normalizeOptionalInteger(record?.colorIndex),
    colorName: normalizeText(record?.colorName),
    color: normalizeText(record?.colorHex),
    isLoop,
    loopEndSec: loopEndSec !== undefined && loopEndSec > sec ? loopEndSec : undefined,
    ...normalizePioneerUsbLoopBeatFields(record, isLoop),
    source: normalizeText(record?.source)
  }
}

const normalizeMemoryCueRecord = (record: RustPioneerMemoryCueRecord): ISongMemoryCue | null => {
  const sec = normalizeNonNegativeNumber(record?.timeSec)
  if (sec === undefined) return null
  const loopEndSec = normalizeNonNegativeNumber(record?.loopTimeSec)
  const isLoop = loopEndSec !== undefined && loopEndSec > sec && Boolean(record?.isLoop)
  return {
    sec,
    order: normalizeOptionalInteger(record?.order),
    comment: normalizeCueComment(record?.comment),
    colorIndex: normalizeOptionalInteger(record?.colorIndex),
    colorName: normalizeText(record?.colorName),
    color: normalizeText(record?.colorHex),
    isLoop,
    loopEndSec: loopEndSec !== undefined && loopEndSec > sec ? loopEndSec : undefined,
    ...normalizePioneerUsbLoopBeatFields(record, isLoop),
    activeLoop:
      typeof record?.activeLoop === 'boolean'
        ? Boolean(
            record.activeLoop && record.isLoop && loopEndSec !== undefined && loopEndSec > sec
          )
        : undefined,
    source: normalizeText(record?.source)
  }
}

export const normalizePioneerCueDump = (
  dump: RustPioneerCueDump | null | undefined
): PioneerTrackCueData => {
  if (!dump || dump.error) return {}
  const hotCues = Array.isArray(dump?.hotCues)
    ? dump.hotCues
        .map((item) => normalizeHotCueRecord(item))
        .filter((item): item is ISongHotCue => Boolean(item))
    : []
  const memoryCues = Array.isArray(dump?.memoryCues)
    ? dump.memoryCues
        .map((item) => normalizeMemoryCueRecord(item))
        .filter((item): item is ISongMemoryCue => Boolean(item))
    : []
  return {
    hotCues: Array.isArray(dump.hotCues) ? hotCues : undefined,
    memoryCues: Array.isArray(dump.memoryCues) ? memoryCues : undefined
  }
}

export const normalizeRequiredPioneerCueDump = (
  dump: RustPioneerCueDump | null | undefined
): PioneerTrackCueData => {
  if (!dump || dump.error || !Array.isArray(dump.hotCues) || !Array.isArray(dump.memoryCues))
    throw new Error(`无法完整读取歌曲标点${dump?.error ? `：${dump.error}` : ''}`)
  const validTime = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  const validRecord = (record: RustPioneerHotCueRecord | RustPioneerMemoryCueRecord) => {
    const hasLoopBeats = record?.loopNumerator != null || record?.loopDenominator != null
    return (
      validTime(record?.timeSec) &&
      (record?.isLoop !== true ||
        (validTime(record.loopTimeSec) && record.loopTimeSec > record.timeSec)) &&
      (!hasLoopBeats ||
        (isValidPioneerUsbLoopBeatPair(record.loopNumerator, record.loopDenominator) &&
          (record.isLoop === true || (record.loopNumerator === 0 && record.loopDenominator === 0))))
    )
  }
  if (
    dump.hotCues.length > 8 ||
    dump.memoryCues.length > 10 ||
    dump.hotCues.some(
      (record) =>
        !validRecord(record) ||
        !Number.isSafeInteger(record?.slot) ||
        Number(record.slot) < 0 ||
        Number(record.slot) > 7
    ) ||
    dump.memoryCues.some((record) => !validRecord(record)) ||
    new Set(dump.hotCues.map((record) => record.slot)).size !== dump.hotCues.length ||
    new Set(
      dump.memoryCues.map((record) => {
        const start = Math.round(Number(record.timeSec) * 1000)
        const end =
          validTime(record.loopTimeSec) && record.loopTimeSec > Number(record.timeSec)
            ? Math.round(record.loopTimeSec * 1000)
            : ''
        return `${start}:${end}`
      })
    ).size !== dump.memoryCues.length
  )
    throw new Error('歌曲标点数据无效，无法安全编辑')
  return normalizePioneerCueDump(dump)
}

export async function enrichPioneerTracksWithCueData(
  rootPath: string,
  tracks: IPioneerPlaylistTrack[],
  options?: PioneerCueReadOptions
): Promise<IPioneerPlaylistTrack[]> {
  if (!Array.isArray(tracks) || tracks.length === 0) return []
  const requireCues = options?.requireCues === true

  const analyzePathKeys = new Set<string>()
  const absoluteAnalyzePaths: string[] = []
  for (const track of tracks) {
    const analyzePath = String(track?.analyzePath || '').trim()
    if (!analyzePath) {
      if (requireCues) throw new Error('歌曲缺少分析文件路径，无法读取完整标点')
      continue
    }
    const absoluteAnalyzePath = resolvePioneerDevicePath(rootPath, analyzePath)
    if (!absoluteAnalyzePath) {
      if (requireCues) throw new Error('缺少设备根目录，无法读取完整标点')
      continue
    }
    const absoluteKey = normalizeAbsolutePathKey(absoluteAnalyzePath)
    if (analyzePathKeys.has(absoluteKey)) continue
    analyzePathKeys.add(absoluteKey)
    absoluteAnalyzePaths.push(absoluteAnalyzePath)
  }

  if (!absoluteAnalyzePaths.length) {
    return tracks.map((track) => ({
      ...track
    }))
  }

  const cueDataByAbsolutePath = new Map<string, PioneerTrackCueData>()
  let cueReadError: Error | undefined
  try {
    await readPioneerCuesInWorker<{ total?: number }>(absoluteAnalyzePaths, (progress) => {
      const item = progress as WorkerCueProgressItem | null
      const absoluteAnalyzePath = String(item?.analyzeFilePath || '').trim()
      if (!absoluteAnalyzePath) return
      const absoluteKey = normalizeAbsolutePathKey(absoluteAnalyzePath)
      if (!analyzePathKeys.has(absoluteKey)) return
      // Progress is called by an EventEmitter, so validation must not throw into the worker pool.
      try {
        cueDataByAbsolutePath.set(
          absoluteKey,
          requireCues
            ? normalizeRequiredPioneerCueDump(item?.dump)
            : normalizePioneerCueDump(item?.dump)
        )
      } catch (error) {
        cueReadError = error instanceof Error ? error : new Error(String(error))
      }
    })
    if (requireCues) {
      if (cueReadError) throw cueReadError
      if (cueDataByAbsolutePath.size !== analyzePathKeys.size)
        throw new Error('部分歌曲标点未读取完成，请重新读取后再编辑')
    }
  } catch (error) {
    log.error('[pioneer-device-library] read cue data failed', {
      rootPath,
      error
    })
    if (requireCues) throw error
    return tracks.map((track) => ({
      ...track
    }))
  }

  return tracks.map((track) => {
    const analyzePath = String(track?.analyzePath || '').trim()
    const cueData = analyzePath
      ? cueDataByAbsolutePath.get(
          normalizeAbsolutePathKey(resolvePioneerDevicePath(rootPath, analyzePath))
        )
      : undefined
    if (!cueData?.hotCues && !cueData?.memoryCues) {
      return {
        ...track
      }
    }
    return {
      ...track,
      hotCues: cueData.hotCues,
      memoryCues: cueData.memoryCues
    }
  })
}
