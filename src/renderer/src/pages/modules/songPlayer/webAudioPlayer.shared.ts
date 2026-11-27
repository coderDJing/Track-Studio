import { isIcloudPlaybackUrl } from '@shared/icloudLibrary'
import type { CompactVisualWaveformData } from '@shared/compactVisualWaveform'
import { isNeteasePreviewUrl } from '@shared/netease'

export type { CompactVisualWaveformData }

export type RGBWaveformBandKey = 'low' | 'mid' | 'high'
export type MixxxWaveformBandKey = RGBWaveformBandKey | 'all'

export type MixxxWaveformBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft?: Uint8Array
  peakRight?: Uint8Array
}

export type MixxxWaveformData = {
  duration: number
  sampleRate: number
  step: number
  bands: Record<MixxxWaveformBandKey, MixxxWaveformBand>
}

export type PcmLoadPayload = {
  pcmData: Float32Array | ArrayBuffer | ArrayBufferView | null
  sampleRate: number
  channels: number
  totalFrames: number
  compactVisualWaveformData?: CompactVisualWaveformData | null
  filePath?: string | null
}

export type SeekedEventPayload = {
  time: number
  manual: boolean
}

export type WebAudioPlayerEvents = {
  ready: undefined
  play: undefined
  pause: undefined
  finish: undefined
  seekstart: SeekedEventPayload
  seeked: SeekedEventPayload
  timeupdate: number
  decode: number
  error: unknown
  waveformready: undefined
} & Record<string, unknown>

export type ErrorLike = {
  name?: unknown
  message?: unknown
}

export interface AudioOutputSinkTarget {
  setSinkId?(deviceId: string): Promise<void>
}

export type AudioElementWithExtensions = HTMLAudioElement &
  AudioOutputSinkTarget & {
    crossOrigin: string | null
  }

export type AudioContextWithExtensions = AudioContext & AudioOutputSinkTarget
export type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext
export type WindowWithAudioContext = Window & {
  AudioContext?: AudioContextConstructor
  webkitAudioContext?: AudioContextConstructor
}

export const getErrorLike = (value: unknown): ErrorLike | null =>
  value && typeof value === 'object' ? (value as ErrorLike) : null

export const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const isIgnorablePlayInterruptionError = (error: unknown) => {
  const errorLike = getErrorLike(error)
  const name = String(errorLike?.name || '').trim()
  const message = String(errorLike?.message || error || '').trim()
  if (name === 'AbortError') return true
  const lowered = message.toLowerCase()
  return (
    lowered.includes('play() request was interrupted by a call to pause()') ||
    lowered.includes('play() request was interrupted by a new load request')
  )
}

export const isEmptySourceAudioErrorMessage = (message: unknown) =>
  String(message || '')
    .trim()
    .toLowerCase()
    .includes('empty src attribute')

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  aac: 'audio/aac',
  ac3: 'audio/ac3',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  alac: 'audio/mp4',
  ape: 'audio/x-ape',
  dts: 'audio/vnd.dts',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mka: 'audio/x-matroska',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  tak: 'audio/x-tak',
  tta: 'audio/x-tta',
  wav: 'audio/wav',
  wave: 'audio/wav',
  webm: 'audio/webm',
  wma: 'audio/x-ms-wma',
  wv: 'audio/x-wavpack'
}

const htmlAudioSupportCache = new Map<string, boolean>()

const normalizeExtension = (filePath: string) => {
  const raw = (filePath || '').trim().toLowerCase()
  if (!raw) return ''
  const match = raw.match(/\.([a-z0-9]+)$/i)
  return match ? match[1] : ''
}

const FORCE_PCM_EXTENSIONS = new Set([
  // Chromium 对 AIFF 的 HTML 音频输出和 MediaElementAudioSource 兼容性不稳定，统一走 PCM。
  'aif',
  'aiff',
  'm4a',
  'm4b',
  'mp4',
  'mka',
  'webm',
  'alac',
  'ape',
  'tak',
  'tta',
  'wv',
  'dts',
  'ac3',
  'wma',
  'aac'
])

export const canPlayHtmlAudio = (filePath: string) => {
  // 网易云试听地址没有扩展名，但不能走本地解码：那会把 URL 当磁盘路径，播放一闪就停。
  if (isNeteasePreviewUrl(filePath) || isIcloudPlaybackUrl(filePath)) return true
  const ext = normalizeExtension(filePath)
  if (!ext) return false
  if (FORCE_PCM_EXTENSIONS.has(ext)) return false

  const mime = AUDIO_MIME_BY_EXTENSION[ext]
  if (!mime) return false
  if (typeof document === 'undefined') return true
  const cached = htmlAudioSupportCache.get(mime)
  if (cached !== undefined) return cached
  const audio = document.createElement('audio')
  const result = audio.canPlayType(mime)
  const supported = result === 'probably' || result === 'maybe'
  htmlAudioSupportCache.set(mime, supported)
  return supported
}

export const toPreviewUrl = (filePath: string) => {
  const raw = (filePath || '').trim()
  if (!raw) return ''
  if (raw.startsWith('frkb-preview://')) return raw
  // Logical iCloud keys are not local files; wrapping them as frkb-preview://local/ stalls playback.
  if (raw.startsWith('icloud-song:')) return ''
  return `frkb-preview://local/?path=${encodeURIComponent(raw)}`
}

export const normalizePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) {
    return new Float32Array(0)
  }
  if (pcmData instanceof Float32Array) {
    return pcmData
  }
  if (pcmData instanceof ArrayBuffer) {
    return new Float32Array(pcmData)
  }
  if (ArrayBuffer.isView(pcmData)) {
    const view = pcmData as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}
