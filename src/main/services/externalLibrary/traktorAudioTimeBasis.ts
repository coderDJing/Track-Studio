import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveAudioTimeBasisOffsetMsForFile } from '../audioTimeBasisOffset'
import type { ExternalLibraryTrack } from '../../../shared/externalLibrary'

const cachedOffsets = new Map<string, { stamp: string; offset: Promise<number> }>()
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

const readLayer3Header = (bytes: Buffer, offset: number) => {
  if (offset + 4 > bytes.length) return null
  const header = bytes.readUInt32BE(offset)
  const version = (header >>> 19) & 3
  const bitrateIndex = (header >>> 12) & 15
  const rateIndex = (header >>> 10) & 3
  if (
    header >>> 21 !== 0x7ff ||
    version === 1 ||
    ((header >>> 17) & 3) !== 1 ||
    !bitrateIndex ||
    bitrateIndex === 15 ||
    rateIndex === 3
  )
    return null
  const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const bitrate = (version === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIndex]
  const frameLength =
    Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / sampleRate) + ((header >>> 9) & 1)
  const mono = ((header >>> 6) & 3) === 3
  return {
    version,
    sampleRate,
    frameLength,
    samples: version === 3 ? 1152 : 576,
    sideInfoLength: version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17
  }
}

const lameTagCrc = (bytes: Buffer) => {
  let crc = 0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xa001 : 0)
    }
  }
  return crc
}

// Traktor decodes an unrecognized/invalid Xing control frame as audio; libav skips it.
// A valid LAME info tag is recognized by both. See dj-data-converter/issues/3.
export const parseTraktorMp3ControlFrameOffsetMs = (bytes: Buffer): number => {
  for (let offset = 0; offset < Math.min(256, bytes.length - 4); offset += 1) {
    const header = readLayer3Header(bytes, offset)
    if (!header) continue
    const next = readLayer3Header(bytes, offset + header.frameLength)
    if (!next || next.version !== header.version || next.sampleRate !== header.sampleRate) continue
    const tagOffset = offset + 4 + header.sideInfoLength
    const tag = bytes.toString('ascii', tagOffset, tagOffset + 4)
    if (tag !== 'Xing' && tag !== 'Info') return 0
    if (tagOffset + 8 > offset + header.frameLength) return 0
    const flags = bytes.readUInt32BE(tagOffset + 4)
    if (flags & ~15) return 0
    const countOffset = tagOffset + 8
    const countsEnd = countOffset + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0)
    if (countsEnd > offset + header.frameLength) return 0
    const frames = flags & 1 ? bytes.readUInt32BE(countOffset) : 0
    const size = flags & 2 ? bytes.readUInt32BE(countOffset + (flags & 1 ? 4 : 0)) : 0
    if (!frames && !size) return 0
    const encoderOffset =
      tagOffset +
      8 +
      (flags & 1 ? 4 : 0) +
      (flags & 2 ? 4 : 0) +
      (flags & 4 ? 100 : 0) +
      (flags & 8 ? 4 : 0)
    if (
      encoderOffset + 36 <= offset + header.frameLength &&
      bytes.toString('ascii', encoderOffset, encoderOffset + 4) === 'LAME'
    ) {
      const crcOffset = encoderOffset + 34
      if (bytes.readUInt16BE(crcOffset) === lameTagCrc(bytes.subarray(offset, crcOffset))) return 0
    }
    return (header.samples / header.sampleRate) * 1000
  }
  return 0
}

const readMp3ControlFrameOffsetMs = async (filePath: string) => {
  if (path.extname(filePath).toLowerCase() !== '.mp3') return 0
  const file = await fs.open(filePath, 'r')
  try {
    let position = 0
    const tag = Buffer.alloc(10)
    for (let index = 0; index < 8; index += 1) {
      const { bytesRead } = await file.read(tag, 0, 10, position)
      if (bytesRead < 10 || tag.toString('ascii', 0, 3) !== 'ID3') break
      if (tag.subarray(6, 10).some((byte) => byte & 0x80)) return 0
      const size = (tag[6] << 21) | (tag[7] << 14) | (tag[8] << 7) | tag[9]
      position += 10 + size + (tag[3] === 4 && tag[5] & 0x10 ? 10 : 0)
    }
    const bytes = Buffer.alloc(4096)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, position)
    return parseTraktorMp3ControlFrameOffsetMs(bytes.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}

export const hydrateTraktorTrackTimeBases = async (tracks: ExternalLibraryTrack[]) => {
  const hydrated = [...tracks]
  let cursor = 0
  const worker = async () => {
    while (cursor < tracks.length) {
      const index = cursor++
      const track = tracks[index]
      try {
        const stat = await fs.stat(track.filePath)
        const key = path.resolve(track.filePath).toLowerCase()
        const stamp = `${stat.size}:${stat.mtimeMs}`
        let cached = cachedOffsets.get(key)
        if (!cached || cached.stamp !== stamp) {
          const offset = Promise.all([
            resolveAudioTimeBasisOffsetMsForFile(track.filePath),
            readMp3ControlFrameOffsetMs(track.filePath)
          ]).then(([audioOffset, controlOffset]) =>
            Number((audioOffset + controlOffset).toFixed(3))
          )
          cached = { stamp, offset }
          if (cachedOffsets.size >= 2048) cachedOffsets.delete(cachedOffsets.keys().next().value!)
          cachedOffsets.set(key, cached)
          void offset.catch(() => {
            if (cachedOffsets.get(key)?.offset === offset) cachedOffsets.delete(key)
          })
        }
        hydrated[index] = { ...track, timeBasisOffsetMs: await cached.offset }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
          continue
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, tracks.length) }, worker))
  return hydrated
}
