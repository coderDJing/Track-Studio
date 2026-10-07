// Clean-room FLAC structure reader, using RFC 9639 §§8–9. It skips encoded
// samples without reconstructing PCM, and checks both header and frame CRCs.
// Native FlacAnalyzeManager uses the containing frame's first sample, byte
// offset relative to the first audio frame, and full block sample count.
export type UsbFlacCuePosition = {
  decodingStartFramePosition: number
  fileOffsetInBlock: number
  numberOfSampleInBlock: number
}
export type UsbFlacCueLocator = (timeMs: number) => UsbFlacCuePosition

const invalid = (): never => {
  throw new Error('FLAC 音频结构不完整或不支持，无法生成 Cue 解码定位')
}

class Bits {
  position: number
  constructor(
    readonly bytes: Buffer,
    offset: number
  ) {
    this.position = offset * 8
  }
  read(count: number): number {
    if (count < 0 || count > 36 || this.position + count > this.bytes.length * 8) invalid()
    let value = 0
    for (let i = 0; i < count; i++, this.position++)
      value = value * 2 + ((this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1)
    return value
  }
  skip(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.position + count > this.bytes.length * 8)
      invalid()
    this.position += count
  }
  unary(): number {
    let zeros = 0
    while (this.read(1) === 0) zeros++
    return zeros
  }
}

const crcTable = (width: number, polynomial: number): number[] =>
  Array.from({ length: 256 }, (_, byte) => {
    let crc = byte * 2 ** (width - 8)
    for (let bit = 0; bit < 8; bit++)
      crc = ((crc << 1) ^ (crc & (2 ** (width - 1)) ? polynomial : 0)) & (2 ** width - 1)
    return crc
  })
const crc8 = crcTable(8, 0x07)
const crc16 = crcTable(16, 0x8005)
const checksum = (bytes: Buffer, start: number, end: number, wide: boolean): number => {
  let crc = 0
  for (let offset = start; offset < end; offset++)
    crc = wide
      ? ((crc << 8) ^ crc16[(crc >> 8) ^ bytes[offset]]) & 0xffff
      : crc8[crc ^ bytes[offset]]
  return crc
}

const codedNumber = (bits: Bits, variable: boolean): number => {
  const first = bits.read(8)
  if (first < 128) return first
  let length = 0
  for (let mask = 128; first & mask; mask >>= 1) length++
  if (length < 2 || length > (variable ? 7 : 6)) invalid()
  let value = first & (2 ** (7 - length) - 1)
  for (let i = 1; i < length; i++) {
    const byte = bits.read(8)
    if ((byte & 0xc0) !== 0x80) invalid()
    value = value * 64 + (byte & 63)
  }
  const minimum = [0, 0, 128, 2048, 65536, 2097152, 67108864, 2147483648][length]
  if (value < minimum || value >= 2 ** (variable ? 36 : 31)) invalid()
  return value
}

const skipResidual = (bits: Bits, count: number, order: number) => {
  const method = bits.read(2)
  if (method > 1) invalid()
  const partitions = 2 ** bits.read(4)
  const perPartition = count / partitions
  if (!Number.isInteger(perPartition) || perPartition <= order) invalid()
  const parameterBits = 4 + method
  for (let partition = 0; partition < partitions; partition++) {
    const samples = perPartition - (partition === 0 ? order : 0)
    const parameter = bits.read(parameterBits)
    if (parameter === 2 ** parameterBits - 1) bits.skip(samples * bits.read(5))
    else
      for (let i = 0; i < samples; i++) {
        bits.unary()
        bits.skip(parameter)
      }
  }
}

const skipSubframe = (bits: Bits, count: number, depth: number) => {
  if (bits.read(1)) invalid()
  const kind = bits.read(6)
  if (bits.read(1)) depth -= bits.unary() + 1
  if (depth <= 0) invalid()
  if (kind === 0) bits.skip(depth)
  else if (kind === 1) bits.skip(count * depth)
  else {
    if (!(kind >= 8 && kind <= 12) && kind < 32) invalid()
    const order = kind < 32 ? kind - 8 : kind - 31
    if (order > count) invalid()
    bits.skip(order * depth)
    if (kind >= 32) {
      const precision = bits.read(4) + 1
      if (precision === 16 || bits.read(5) >= 16) invalid()
      bits.skip(order * precision)
    }
    skipResidual(bits, count, order)
  }
}

type Stream = {
  offset: number
  sampleRate: number
  depth: number
  channels: number
  total: number
  minBlock: number
  maxBlock: number
}

const streamInfo = (bytes: Buffer): Stream => {
  if (bytes.length < 42 || bytes.toString('ascii', 0, 4) !== 'fLaC') invalid()
  let offset = 4
  let stream: Stream | undefined
  for (;;) {
    if (offset + 4 > bytes.length) invalid()
    const kind = bytes[offset] & 127
    const last = (bytes[offset] & 128) !== 0
    const size = bytes.readUIntBE(offset + 1, 3)
    const start = offset + 4
    offset = start + size
    if (offset > bytes.length || kind === 127) invalid()
    if (kind === 0) {
      if (stream || start !== 8 || size !== 34) invalid()
      const properties = bytes.readBigUInt64BE(start + 10)
      stream = {
        offset: 0,
        sampleRate: Number(properties >> 44n),
        channels: Number((properties >> 41n) & 7n) + 1,
        depth: Number((properties >> 36n) & 31n) + 1,
        total: Number(properties & 0xfffffffffn),
        minBlock: bytes.readUInt16BE(start),
        maxBlock: bytes.readUInt16BE(start + 2)
      }
    } else if (!stream) invalid()
    if (last) break
  }
  if (!stream) return invalid()
  if (
    !stream.sampleRate ||
    stream.channels > 2 ||
    stream.depth < 4 ||
    stream.minBlock < 16 ||
    stream.maxBlock < stream.minBlock ||
    !stream.total ||
    offset >= bytes.length
  )
    invalid()
  return { ...stream, offset }
}

const sampleRates = [
  0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000
]
const depths = [0, 8, 12, 0, 16, 20, 24, 32]

/** A complete, contiguous frame index is required; no sync-byte searching or guessed offsets. */
export const createUsbFlacCueLocator = (bytes: Buffer): UsbFlacCueLocator => {
  const stream = streamInfo(bytes)
  const frames: UsbFlacCuePosition[] = []
  let offset = stream.offset
  let samples = 0
  let strategy: boolean | undefined
  let fixedBlock = 0
  while (offset < bytes.length) {
    const start = offset
    const bits = new Bits(bytes, start)
    if (bits.read(15) !== 0x7ffc) invalid()
    const variable = bits.read(1) === 1
    if (strategy !== undefined && strategy !== variable) invalid()
    strategy = variable
    const blockCode = bits.read(4)
    const rateCode = bits.read(4)
    const channelCode = bits.read(4)
    const depthCode = bits.read(3)
    if (bits.read(1) || !blockCode || rateCode === 15 || channelCode > 10 || depthCode === 3)
      invalid()
    const number = codedNumber(bits, variable)
    const count =
      blockCode === 6
        ? bits.read(8) + 1
        : blockCode === 7
          ? bits.read(16) + 1
          : blockCode === 1
            ? 192
            : blockCode < 6
              ? 144 * 2 ** blockCode
              : 2 ** blockCode
    const rate =
      rateCode === 0
        ? stream.sampleRate
        : rateCode === 12
          ? bits.read(8) * 1000
          : rateCode >= 13
            ? bits.read(16) * (rateCode === 14 ? 10 : 1)
            : sampleRates[rateCode]
    const depth = depthCode === 0 ? stream.depth : depths[depthCode]
    const channels = channelCode < 8 ? channelCode + 1 : 2
    if (rate !== stream.sampleRate || depth !== stream.depth || channels !== stream.channels)
      invalid()
    if (number !== (variable ? samples : frames.length) || count > stream.maxBlock) invalid()
    if (!variable && !fixedBlock) fixedBlock = count
    if (
      samples + count > stream.total ||
      (!variable && count > fixedBlock) ||
      (samples + count < stream.total &&
        (count < stream.minBlock || (!variable && count !== fixedBlock)))
    )
      invalid()
    const headerEnd = bits.position / 8
    if (checksum(bytes, start, headerEnd, false) !== bits.read(8)) invalid()
    for (let channel = 0; channel < channels; channel++) {
      const side =
        (channelCode === 8 && channel === 1) ||
        (channelCode === 9 && channel === 0) ||
        (channelCode === 10 && channel === 1)
      skipSubframe(bits, count, depth + (side ? 1 : 0))
    }
    const padding = (8 - (bits.position % 8)) % 8
    if (bits.read(padding) !== 0) invalid()
    const frameEnd = bits.position / 8
    if (checksum(bytes, start, frameEnd, true) !== bits.read(16)) invalid()
    frames.push({
      decodingStartFramePosition: samples,
      fileOffsetInBlock: start - stream.offset,
      numberOfSampleInBlock: count
    })
    samples += count
    offset = bits.position / 8
  }
  if (samples !== stream.total || !frames.length) invalid()
  return (timeMs) => {
    if (!Number.isSafeInteger(timeMs) || timeMs < 0)
      throw new Error('FLAC Cue 时间必须为非负整数毫秒')
    // Preserve the native double-operation order before floor, including exact frame boundaries.
    const sample = Math.floor(stream.sampleRate * timeMs * 0.001)
    if (sample >= stream.total) throw new Error('FLAC Cue 位置超出音频范围')
    let low = 0
    let high = frames.length
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2)
      if (frames[middle].decodingStartFramePosition <= sample) low = middle
      else high = middle
    }
    return { ...frames[low] }
  }
}
