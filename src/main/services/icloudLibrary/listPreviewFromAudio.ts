import {
  WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
  WAVEFORM_SURFACE_CACHE_VERSION,
  type WaveformListPreviewData
} from '../../../shared/waveformSurfaceCache'

const LIST_PREVIEW_COLUMNS = 512

const clampByte = (value: number) =>
  Math.max(0, Math.min(255, Number.isFinite(value) ? Math.round(value) : 0))

const readFourCC = (buffer: Buffer, offset: number) => buffer.toString('ascii', offset, offset + 4)

export function parseWavPcm(buffer: Buffer): { samples: Float32Array; sampleRate: number } | null {
  if (buffer.length < 44 || readFourCC(buffer, 0) !== 'RIFF' || readFourCC(buffer, 8) !== 'WAVE')
    return null
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let data: Buffer | null = null
  while (offset + 8 <= buffer.length) {
    const id = readFourCC(buffer, offset)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const next = start + size + (size % 2)
    if (start > buffer.length) break
    const chunk = buffer.subarray(start, Math.min(buffer.length, start + size))
    if (id === 'fmt ' && chunk.length >= 16) {
      if (chunk.readUInt16LE(0) !== 1) return null
      channels = chunk.readUInt16LE(2)
      sampleRate = chunk.readUInt32LE(4)
      bitsPerSample = chunk.readUInt16LE(14)
    } else if (id === 'data') {
      data = chunk
      break
    }
    offset = next
  }
  if (!data || !channels || !sampleRate || (bitsPerSample !== 16 && bitsPerSample !== 8))
    return null
  const frameCount =
    bitsPerSample === 16
      ? Math.floor(data.length / (2 * channels))
      : Math.floor(data.length / channels)
  if (frameCount <= 0) return null
  const samples = new Float32Array(frameCount)
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      if (bitsPerSample === 16) {
        sum += data.readInt16LE((frame * channels + channel) * 2) / 32768
      } else {
        sum += (data[frame * channels + channel] - 128) / 128
      }
    }
    samples[frame] = sum / channels
  }
  return { samples, sampleRate }
}

export function buildListPreviewFromPcm(
  samples: Float32Array,
  sampleRate: number
): WaveformListPreviewData | null {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return null
  const duration = samples.length / sampleRate
  const frames = LIST_PREVIEW_COLUMNS
  const detailPeakTop = new Uint8Array(frames)
  const detailPeakBottom = new Uint8Array(frames)
  const detailBody = new Uint8Array(frames)
  const colorIndex = new Uint8Array(frames)
  const colorLow = new Uint8Array(frames)
  const colorMid = new Uint8Array(frames)
  const colorHigh = new Uint8Array(frames)
  const colorRed = new Uint8Array(frames)
  const colorGreen = new Uint8Array(frames)
  const colorBlue = new Uint8Array(frames)
  const overviewTop = new Uint8Array(frames)
  const overviewBottom = new Uint8Array(frames)
  for (let index = 0; index < frames; index++) {
    const start = Math.floor((index * samples.length) / frames)
    const end = Math.max(start + 1, Math.floor(((index + 1) * samples.length) / frames))
    let peak = 0
    let trough = 0
    let energy = 0
    for (let sample = start; sample < end; sample++) {
      const value = samples[sample] || 0
      if (value > peak) peak = value
      if (value < trough) trough = value
      energy += value * value
    }
    const count = end - start
    const rms = Math.sqrt(energy / count)
    const top = clampByte(peak * 255)
    const bottom = clampByte(-trough * 255)
    const body = clampByte(rms * 255)
    detailPeakTop[index] = top
    detailPeakBottom[index] = bottom
    detailBody[index] = body
    overviewTop[index] = top
    overviewBottom[index] = bottom
    colorIndex[index] = body
    colorLow[index] = body
    colorMid[index] = clampByte(body * 0.7)
    colorHigh[index] = clampByte(body * 0.35)
    colorRed[index] = clampByte(40 + body * 0.2)
    colorGreen[index] = clampByte(90 + body * 0.4)
    colorBlue[index] = clampByte(140 + body * 0.3)
  }
  return {
    surfaceKind: 'listPreview',
    version: WAVEFORM_SURFACE_CACHE_VERSION,
    parameterVersion: WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
    duration,
    sampleRate,
    detailRate: frames / Math.max(duration, 1 / sampleRate),
    overviewRate: frames / Math.max(duration, 1 / sampleRate),
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
    overviewTop,
    overviewBottom
  }
}

export function buildListPreviewFromAudioBuffer(buffer: Buffer): WaveformListPreviewData | null {
  const wav = parseWavPcm(buffer)
  return wav ? buildListPreviewFromPcm(wav.samples, wav.sampleRate) : null
}
