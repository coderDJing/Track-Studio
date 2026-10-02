import type { UnifiedDisplayWaveformDetailData } from './unifiedDisplayWaveform'
import type { NativeWaveformBitmap } from './compactVisualWaveform'

export const WAVEFORM_SURFACE_CACHE_VERSION = 1
export const WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION = 1
export const WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION = 1
const WAVEFORM_LIST_PREVIEW_COLUMNS = 512
export const WAVEFORM_GLOBAL_OVERVIEW_RATE = 32
const WAVEFORM_GLOBAL_OVERVIEW_MIN_FRAMES = 4096
const WAVEFORM_GLOBAL_OVERVIEW_MAX_FRAMES = 16384

export type WaveformSurfaceKind = 'listPreview' | 'globalOverview'

type WaveformSurfaceDataBase = {
  version: number
  parameterVersion: number
  duration: number
  sampleRate: number
  detailRate: number
  overviewRate: number
  bodyRateDivisor: number
  colorRateDivisor: number
  detailPeakTop: Uint8Array
  detailPeakBottom: Uint8Array
  detailBody: Uint8Array
  colorIndex: Uint8Array
  colorLow: Uint8Array
  colorMid: Uint8Array
  colorHigh: Uint8Array
  colorRed: Uint8Array
  colorGreen: Uint8Array
  colorBlue: Uint8Array
  overviewTop: Uint8Array
  overviewBottom: Uint8Array
  /** Source-specific visual gain for the song-list preview; omitted for cached FRKB waveforms. */
  displayGain?: number
  nativeBitmap?: NativeWaveformBitmap
}

export type WaveformListPreviewData = WaveformSurfaceDataBase & {
  surfaceKind: 'listPreview'
}

export type WaveformGlobalOverviewData = WaveformSurfaceDataBase & {
  surfaceKind: 'globalOverview'
}

export type WaveformSurfaceCacheData = {
  listPreview: WaveformListPreviewData
  globalOverview: WaveformGlobalOverviewData
}

export type WaveformSurfaceData = WaveformListPreviewData | WaveformGlobalOverviewData

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const toUint8Array = (value: unknown) => {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  return new Uint8Array(0)
}

const readByte = (values: Uint8Array, index: number, fallback: number) => {
  if (!values.length) return fallback
  return values[clamp(Math.floor(index), 0, values.length - 1)] ?? fallback
}

const resolveTargetFrameCount = (kind: WaveformSurfaceKind, duration: number) => {
  if (kind === 'listPreview') return WAVEFORM_LIST_PREVIEW_COLUMNS
  return clamp(
    Math.ceil(duration * WAVEFORM_GLOBAL_OVERVIEW_RATE),
    WAVEFORM_GLOBAL_OVERVIEW_MIN_FRAMES,
    WAVEFORM_GLOBAL_OVERVIEW_MAX_FRAMES
  )
}

const resolveBucketRange = (sourceFrames: number, targetIndex: number, targetFrames: number) => {
  if (sourceFrames <= 1 || targetFrames <= 1) return { start: 0, end: 0 }
  const start = clamp(Math.floor((targetIndex / targetFrames) * sourceFrames), 0, sourceFrames - 1)
  const end = clamp(
    Math.max(start, Math.ceil(((targetIndex + 1) / targetFrames) * sourceFrames) - 1),
    start,
    sourceFrames - 1
  )
  return { start, end }
}

const buildSurfaceData = (
  kind: WaveformSurfaceKind,
  data: UnifiedDisplayWaveformDetailData
): WaveformSurfaceData | null => {
  const duration = Math.max(0, Number(data.duration) || 0)
  const sampleRate = Math.max(0, Number(data.sampleRate) || 0)
  const sourceFrames = Math.min(
    data.height?.length || 0,
    data.colorIndex?.length || 0,
    data.colorLow?.length || 0,
    data.colorMid?.length || 0,
    data.colorHigh?.length || 0,
    data.colorRed?.length || 0,
    data.colorGreen?.length || 0,
    data.colorBlue?.length || 0
  )
  if (!duration || !sampleRate || !sourceFrames) return null

  const frameCount = resolveTargetFrameCount(kind, duration)
  const detailPeakTop = new Uint8Array(frameCount)
  const detailPeakBottom = new Uint8Array(frameCount)
  const detailBody = new Uint8Array(frameCount)
  const colorIndex = new Uint8Array(frameCount)
  const colorLow = new Uint8Array(frameCount)
  const colorMid = new Uint8Array(frameCount)
  const colorHigh = new Uint8Array(frameCount)
  const colorRed = new Uint8Array(frameCount)
  const colorGreen = new Uint8Array(frameCount)
  const colorBlue = new Uint8Array(frameCount)

  for (let index = 0; index < frameCount; index += 1) {
    const { start, end } = resolveBucketRange(sourceFrames, index, frameCount)
    let peak = 0
    let sum = 0
    let selectedFrame = start
    for (let frame = start; frame <= end; frame += 1) {
      const height = readByte(data.height, frame, 0)
      sum += height
      if (height >= peak) {
        peak = height
        selectedFrame = frame
      }
    }
    const sampleCount = Math.max(1, end - start + 1)
    const mean = sum / sampleCount
    detailPeakTop[index] = peak
    detailPeakBottom[index] = peak
    detailBody[index] = clamp(Math.round(mean * 0.7 + peak * 0.3), 0, 255)
    colorIndex[index] = readByte(data.colorIndex, selectedFrame, 3)
    colorLow[index] = readByte(data.colorLow, selectedFrame, 0)
    colorMid[index] = readByte(data.colorMid, selectedFrame, 0)
    colorHigh[index] = readByte(data.colorHigh, selectedFrame, 0)
    colorRed[index] = readByte(data.colorRed, selectedFrame, 235)
    colorGreen[index] = readByte(data.colorGreen, selectedFrame, 242)
    colorBlue[index] = readByte(data.colorBlue, selectedFrame, 248)
  }

  const detailRate = frameCount / duration
  const base = {
    version: WAVEFORM_SURFACE_CACHE_VERSION,
    parameterVersion:
      kind === 'listPreview'
        ? WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION
        : WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION,
    duration,
    sampleRate,
    detailRate,
    overviewRate: kind === 'globalOverview' ? WAVEFORM_GLOBAL_OVERVIEW_RATE : detailRate,
    bodyRateDivisor: 1,
    colorRateDivisor: 1,
    detailPeakTop,
    detailPeakBottom,
    detailBody,
    colorIndex,
    colorLow,
    colorMid,
    colorHigh,
    colorRed,
    colorGreen,
    colorBlue,
    overviewTop: new Uint8Array(detailPeakTop),
    overviewBottom: new Uint8Array(detailPeakBottom)
  }

  if (kind === 'listPreview') {
    return { ...base, surfaceKind: 'listPreview' }
  }
  return { ...base, surfaceKind: 'globalOverview' }
}

export const buildWaveformSurfaceCacheDataFromUnifiedDisplay = (
  data: UnifiedDisplayWaveformDetailData | null | undefined
): WaveformSurfaceCacheData | null => {
  if (!data) return null
  const listPreview = buildSurfaceData('listPreview', data)
  const globalOverview = buildSurfaceData('globalOverview', data)
  if (!listPreview || !globalOverview) return null
  return {
    listPreview: listPreview as WaveformListPreviewData,
    globalOverview: globalOverview as WaveformGlobalOverviewData
  }
}

export const normalizeWaveformSurfaceData = <T extends WaveformSurfaceData>(
  value: unknown,
  kind: T['surfaceKind']
): T | null => {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as WaveformSurfaceData)
      : null
  if (!payload || payload.surfaceKind !== kind) return null
  const detailPeakTop = toUint8Array(payload.detailPeakTop)
  const detailPeakBottom = toUint8Array(payload.detailPeakBottom)
  const detailBody = toUint8Array(payload.detailBody)
  const colorIndex = toUint8Array(payload.colorIndex)
  const colorLow = toUint8Array(payload.colorLow)
  const colorMid = toUint8Array(payload.colorMid)
  const colorHigh = toUint8Array(payload.colorHigh)
  const colorRed = toUint8Array(payload.colorRed)
  const colorGreen = toUint8Array(payload.colorGreen)
  const colorBlue = toUint8Array(payload.colorBlue)
  const overviewTop = toUint8Array(payload.overviewTop)
  const overviewBottom = toUint8Array(payload.overviewBottom)
  const frames = Math.min(
    detailPeakTop.length,
    detailPeakBottom.length,
    detailBody.length,
    colorIndex.length,
    colorLow.length,
    colorMid.length,
    colorHigh.length,
    colorRed.length,
    colorGreen.length,
    colorBlue.length,
    overviewTop.length,
    overviewBottom.length
  )
  const duration = Math.max(0, Number(payload.duration) || 0)
  const sampleRate = Math.max(0, Number(payload.sampleRate) || 0)
  const detailRate = Math.max(0, Number(payload.detailRate) || 0)
  if (!frames || !duration || !sampleRate || !detailRate) return null
  return {
    ...payload,
    version: Math.max(0, Number(payload.version) || 0),
    parameterVersion: Math.max(0, Number(payload.parameterVersion) || 0),
    duration,
    sampleRate,
    detailRate,
    overviewRate: Math.max(0, Number(payload.overviewRate) || 0),
    bodyRateDivisor: Math.max(1, Number(payload.bodyRateDivisor) || 1),
    colorRateDivisor: Math.max(1, Number(payload.colorRateDivisor) || 1),
    detailPeakTop,
    detailPeakBottom,
    detailBody,
    colorIndex,
    colorLow,
    colorMid,
    colorHigh,
    colorRed,
    colorGreen,
    colorBlue,
    overviewTop,
    overviewBottom
  } as T
}
