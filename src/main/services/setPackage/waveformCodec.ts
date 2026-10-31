import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'
import {
  UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
  UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
  type UnifiedDisplayWaveformDetailData
} from '../../../shared/unifiedDisplayWaveform'
import {
  WAVEFORM_SURFACE_CACHE_VERSION,
  WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
  WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION,
  type WaveformSurfaceCacheData,
  type WaveformSurfaceData
} from '../../../shared/waveformSurfaceCache'
import { SetPackageError } from './manifest'

export type SetPackageWaveforms = {
  detail?: UnifiedDisplayWaveformDetailData
  surfaces?: WaveformSurfaceCacheData
}
export const MAX_PACKAGE_WAVEFORM_BYTES = 256 * 1024 * 1024
const compress = promisify(gzip)
const decompress = promisify(gunzip)
const DETAIL_ARRAYS = [
  'height',
  'attack',
  'colorIndex',
  'colorLow',
  'colorMid',
  'colorHigh',
  'colorRed',
  'colorGreen',
  'colorBlue',
  'body',
  'overviewHeight'
] as const
const SURFACE_ARRAYS = [
  'detailPeakTop',
  'detailPeakBottom',
  'detailBody',
  'colorIndex',
  'colorLow',
  'colorMid',
  'colorHigh',
  'colorRed',
  'colorGreen',
  'colorBlue',
  'overviewTop',
  'overviewBottom'
] as const

const invalid = (): never => {
  throw new SetPackageError('PACKAGE_FILE_CORRUPTED', 'SET 波形数据格式、版本或长度非法')
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
const positive = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return invalid()
  return value
}
const readArrays = <T extends readonly string[]>(input: Record<string, unknown>, keys: T) => {
  const entries = keys.map((key) => {
    const encoded = input[key]
    if (typeof encoded !== 'string' || !encoded.length) return invalid()
    const decoded = Buffer.from(encoded, 'base64')
    if (!decoded.length || decoded.toString('base64') !== encoded) return invalid()
    return [key, new Uint8Array(decoded)] as const
  })
  // 每个 key 都在上面的运行时校验后写入。
  return Object.fromEntries(entries) as Record<T[number], Uint8Array>
}
const readMeta = (input: Record<string, unknown>) => ({
  duration: positive(input.duration),
  sampleRate: positive(input.sampleRate),
  detailRate: positive(input.detailRate),
  overviewRate: positive(input.overviewRate),
  bodyRateDivisor: positive(input.bodyRateDivisor)
})
const parseDetail = (value: unknown): UnifiedDisplayWaveformDetailData => {
  const input = record(value)
  if (
    input.version !== UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION ||
    input.parameterVersion !== UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION
  )
    return invalid()
  const meta = readMeta(input)
  const arrays = readArrays(input, DETAIL_ARRAYS)
  const frames = arrays.height.length
  if (
    DETAIL_ARRAYS.slice(0, 9).some((key) => arrays[key].length !== frames) ||
    arrays.body.length !== Math.ceil(frames / meta.bodyRateDivisor) ||
    frames !== Math.ceil(meta.duration * meta.detailRate) ||
    arrays.overviewHeight.length !== Math.ceil(meta.duration * meta.overviewRate)
  )
    return invalid()
  return {
    ...meta,
    ...arrays,
    version: UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
    parameterVersion: UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION
  }
}
const parseSurface = <K extends WaveformSurfaceData['surfaceKind']>(value: unknown, kind: K) => {
  const input = record(value)
  const parameterVersion =
    kind === 'listPreview'
      ? WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION
      : WAVEFORM_GLOBAL_OVERVIEW_PARAMETER_VERSION
  if (
    input.version !== WAVEFORM_SURFACE_CACHE_VERSION ||
    input.parameterVersion !== parameterVersion ||
    input.surfaceKind !== kind
  )
    return invalid()
  const arrays = readArrays(input, SURFACE_ARRAYS)
  const frames = arrays.detailPeakTop.length
  if (SURFACE_ARRAYS.some((key) => arrays[key].length !== frames)) return invalid()
  return {
    ...readMeta(input),
    ...arrays,
    colorRateDivisor: positive(input.colorRateDivisor),
    version: WAVEFORM_SURFACE_CACHE_VERSION,
    parameterVersion,
    surfaceKind: kind
  }
}
const parseBundle = (value: unknown, audioSha256: string): SetPackageWaveforms => {
  const input = record(value)
  if (
    input.format !== 'frkb-set-waveforms' ||
    input.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(audioSha256) ||
    input.audioSha256 !== audioSha256
  )
    return invalid()
  const result: SetPackageWaveforms = {}
  if (input.detail !== undefined) result.detail = parseDetail(input.detail)
  if (input.surfaces !== undefined) {
    const surfaces = record(input.surfaces)
    result.surfaces = {
      listPreview: parseSurface(surfaces.listPreview, 'listPreview'),
      globalOverview: parseSurface(surfaces.globalOverview, 'globalOverview')
    }
  }
  if (!result.detail && !result.surfaces) return invalid()
  if (
    result.detail &&
    result.surfaces &&
    result.detail.duration !== result.surfaces.globalOverview.duration
  )
    return invalid()
  return result
}
const encodeData = (value: UnifiedDisplayWaveformDetailData | WaveformSurfaceData) =>
  Object.fromEntries(
    Object.entries(value).map(([key, data]) => [
      key,
      data instanceof Uint8Array ? Buffer.from(data).toString('base64') : data
    ])
  )

export async function encodeSetPackageWaveforms(
  data: SetPackageWaveforms,
  audioSha256: string
): Promise<Buffer> {
  const value = {
    format: 'frkb-set-waveforms',
    version: 1,
    audioSha256,
    ...(data.detail ? { detail: encodeData(data.detail) } : {}),
    ...(data.surfaces
      ? {
          surfaces: {
            listPreview: encodeData(data.surfaces.listPreview),
            globalOverview: encodeData(data.surfaces.globalOverview)
          }
        }
      : {})
  }
  parseBundle(value, audioSha256)
  const json = Buffer.from(JSON.stringify(value))
  if (json.byteLength > MAX_PACKAGE_WAVEFORM_BYTES) return invalid()
  return await compress(json)
}

export async function decodeSetPackageWaveforms(
  payload: Buffer,
  audioSha256: string
): Promise<SetPackageWaveforms> {
  try {
    const json = await decompress(payload, { maxOutputLength: MAX_PACKAGE_WAVEFORM_BYTES })
    return parseBundle(JSON.parse(json.toString('utf8')) as unknown, audioSha256)
  } catch (error) {
    if (error instanceof SetPackageError) throw error
    return invalid()
  }
}
