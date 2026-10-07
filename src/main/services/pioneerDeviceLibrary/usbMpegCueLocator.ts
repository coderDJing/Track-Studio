import { parseUsbAnlz } from './usbAnlzWrite'
import { readUsbMpegAudioIndex } from './usbMpegAudioIndex'

export type UsbMpegCuePosition = { mpegFrame: number; mpegAbs: number }
export type UsbMpegCueLocator = (milliseconds: number) => UsbMpegCuePosition
export type UsbMpegCueIndex = { offsets: number[]; sampleCount: number }

/** Native generation is disabled when the second PVBR index word is zero. */
export const readUsbMpegCueIndex = (dat: Buffer): UsbMpegCueIndex | undefined => {
  const tags = parseUsbAnlz(dat).sections.filter((section) => section.kind === 'PVBR')
  if (!tags.length) return undefined
  if (tags.length !== 1) throw new Error('重复 MPEG 索引，无法确认 Cue 定位')
  const bytes = tags[0].bytes
  if (bytes.readUInt32BE(4) !== 16 || ![20, 1620].includes(bytes.length))
    throw new Error('未知 PVBR 索引布局，无法确认 Cue 定位')
  if (bytes.length === 20 || bytes.readUInt32BE(20) === 0) return undefined
  const sampleCount = bytes.readUInt32BE(1616)
  if (!sampleCount) throw new Error('MPEG 索引缺少样本总数')
  return {
    offsets: Array.from({ length: 400 }, (_, index) => bytes.readUInt32BE(16 + index * 4)),
    sampleCount
  }
}

/** Generate native MPEG locators only when the complete PVBR index agrees with the audio. */
export const createUsbMpegCueLocator = (
  audio: Buffer,
  index: UsbMpegCueIndex
): UsbMpegCueLocator => {
  const { frameOffsets: frames, sampleRate, samplesPerFrame, isVbr } = readUsbMpegAudioIndex(audio)
  if (index.sampleCount !== frames.length * samplesPerFrame || index.offsets.length !== 400)
    throw new Error('PVBR 样本总数与 MP3 不一致')
  for (let bucket = 1; bucket <= 400; bucket++) {
    const product = bucket * frames.length
    const seed = product >= 3600 ? Math.floor(product / 400) - 8 : 0
    if (index.offsets[bucket - 1] !== frames[seed]) throw new Error('PVBR 索引与 MP3 帧位置不一致')
  }
  return (milliseconds) => {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 0xfffffffe)
      throw new Error('MPEG Cue 时间必须为非负整数毫秒')
    const quantizedMs = Math.ceil(Math.floor(milliseconds * 0.075) * 13.333333333333334)
    const physicalFrame = Math.floor(Math.floor(sampleRate * quantizedMs * 0.001) / samplesPerFrame)
    if (physicalFrame >= frames.length) throw new Error('MPEG Cue 超出音频范围')
    return {
      mpegFrame: Math.floor(Math.floor(milliseconds * 0.15) / 2),
      mpegAbs: !isVbr || physicalFrame < 8 ? 0 : frames[physicalFrame - 8]
    }
  }
}
