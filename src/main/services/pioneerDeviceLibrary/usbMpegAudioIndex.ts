export type UsbMpegAudioIndex = {
  firstFrameOffset: number
  frameOffsets: number[]
  sampleRate: number
  samplesPerFrame: number
  channels: number
  version: 1 | 2
  isVbr: boolean
  metadataFrame: boolean
}

const bitrates = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}
const rates = [44100, 48000, 32000]

/** Complete physical Layer III frame index, including a Xing/Info metadata frame. */
export const readUsbMpegAudioIndex = (audio: Buffer): UsbMpegAudioIndex => {
  let offset = 0
  if (audio.toString('ascii', 0, 3) === 'ID3') {
    if (
      audio.length < 10 ||
      ![2, 3, 4].includes(audio[3]) ||
      audio[4] !== 0 ||
      (audio[5] & (audio[3] === 2 ? 0x3f : audio[3] === 3 ? 0x1f : 0x0f)) !== 0 ||
      audio.subarray(6, 10).some((byte) => byte >= 128)
    )
      throw new Error('MP3 ID3 元数据布局无效')
    const size = audio.subarray(6, 10).reduce((value, byte) => value * 128 + byte, 0)
    const footerSize = audio[3] === 4 && audio[5] & 0x10 ? 10 : 0
    offset = 10 + size + footerSize
    if (offset > audio.length) throw new Error('MP3 ID3 元数据被截断')
    if (footerSize) {
      const footer = audio.subarray(offset - 10, offset)
      if (
        footer.toString('ascii', 0, 3) !== '3DI' ||
        !footer.subarray(3).equals(audio.subarray(3, 10))
      )
        throw new Error('MP3 ID3 页脚无效')
    }
  }
  const first = offset
  const end =
    audio.length >= 128 && audio.toString('ascii', audio.length - 128, audio.length - 125) === 'TAG'
      ? audio.length - 128
      : audio.length
  const frames: number[] = []
  let configuration: number | undefined
  let firstSize = 0
  let sampleRate = 0
  let samplesPerFrame = 0
  let channels = 0
  let version: 1 | 2 = 1
  while (offset < end) {
    if (offset + 4 > end) throw new Error('MP3 帧头被截断')
    const header = audio.readUInt32BE(offset)
    const versionBits = (header >>> 19) & 3
    const rateCode = (header >>> 10) & 3
    const bitrateCode = (header >>> 12) & 15
    if (
      header >>> 21 !== 2047 ||
      ![2, 3].includes(versionBits) ||
      ((header >>> 17) & 3) !== 1 ||
      rateCode === 3 ||
      !bitrateCode ||
      bitrateCode === 15
    )
      throw new Error('尚未支持此 MPEG 音频格式的非零 Cue 定位')
    // Native matching retains version/layer, sample rate and channel configuration,
    // allowing bitrate, padding and stereo mode-extension changes between frames.
    const current = header & 0x001e0ccf
    configuration ??= current
    if (current !== configuration) throw new Error('MP3 帧版本、采样率或声道配置不一致')
    version = versionBits === 3 ? 1 : 2
    sampleRate = rates[rateCode] / version
    samplesPerFrame = version === 1 ? 1152 : 576
    channels = ((header >>> 6) & 3) === 3 ? 1 : 2
    const bitrate = bitrates[version][bitrateCode]
    const size =
      Math.floor(((version === 1 ? 144000 : 72000) * bitrate) / sampleRate) + ((header >>> 9) & 1)
    if (offset + size > end) throw new Error('MP3 音频帧被截断')
    frames.push(offset - first)
    if (frames.length === 1) firstSize = size
    offset += size
  }
  if (frames.length < 3 || offset !== end) throw new Error('MP3 音频帧不完整')
  const sideInfoSize = version === 1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17
  const markerOffset = first + 4 + ((audio[first + 1] & 1) === 0 ? 2 : 0) + sideInfoSize
  const marker = audio.toString('ascii', markerOffset, markerOffset + 4)
  if (audio.toString('ascii', first + 36, first + 40) === 'VBRI')
    throw new Error('尚未验证 VBRI 元数据的 MPEG Cue 定位')
  const metadataFrame = ['Xing', 'Info'].includes(marker)
  if (metadataFrame) {
    if (markerOffset + 12 > first + firstSize) throw new Error('Xing 元数据被截断')
    const flags = audio.readUInt32BE(markerOffset + 4)
    if (flags & ~15 || !(flags & 1) || audio.readUInt32BE(markerOffset + 8) !== frames.length - 1)
      throw new Error('Xing 音频帧总数与文件不一致')
  }
  // Native no-Xing detection compares up to 51 matching frames at the head
  // and at the data byte midpoint. A change elsewhere must not enable VBR
  // locators that the native reader would keep at zero.
  const firstBitrateCode = (audio.readUInt32BE(first) >>> 12) & 15
  const scanChangedBitrate = (start: number): boolean => {
    let found = 0
    for (let cursor = start; cursor + 4 <= end && found < 51; ) {
      const header = audio.readUInt32BE(cursor)
      const code = (header >>> 12) & 15
      if (
        header >>> 21 !== 2047 ||
        (header & 0x001e0ccf) !== configuration ||
        !code ||
        code === 15
      ) {
        cursor++
        continue
      }
      if (code !== firstBitrateCode) return true
      found++
      cursor +=
        Math.floor(((version === 1 ? 144000 : 72000) * bitrates[version][code]) / sampleRate) +
        ((header >>> 9) & 1)
    }
    return false
  }
  const isVbr =
    marker === 'Xing' ||
    scanChangedBitrate(first) ||
    scanChangedBitrate(first + Math.floor((end - first) / 2))
  return {
    firstFrameOffset: first,
    frameOffsets: frames,
    sampleRate,
    samplesPerFrame,
    channels,
    version,
    isVbr,
    metadataFrame
  }
}
