import fs from 'node:fs/promises'
import path from 'node:path'
import { encodeSerato32Color, encodeSerato32U32 } from 'serato-connect'

export type SeratoHotCue = {
  slot?: unknown
  sec?: unknown
  label?: unknown
  comment?: unknown
  color?: unknown
  colorIndex?: unknown
  isLoop?: unknown
  loopEndSec?: unknown
}

type Id3Frame = { id: string; flags: number; payload: Buffer }

const MARKERS_DESCRIPTION = 'Serato Markers2'
const LEGACY_MARKERS_DESCRIPTION = 'Serato Markers_'
const MARKERS_HEADER = Buffer.from([0x01, 0x01])
const DEFAULT_COLORS = [
  [32, 201, 151],
  [47, 128, 237],
  [155, 81, 224],
  [235, 87, 87],
  [242, 201, 76],
  [255, 107, 154],
  [39, 174, 96],
  [86, 204, 242]
] as const

const encodeSyncSafe = (value: number) =>
  Buffer.from([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f])

const decodeSyncSafe = (value: Buffer) =>
  ((value[0] & 0x7f) << 21) |
  ((value[1] & 0x7f) << 14) |
  ((value[2] & 0x7f) << 7) |
  (value[3] & 0x7f)

const readUInt32 = (value: Buffer, offset: number, syncSafe: boolean) =>
  syncSafe ? decodeSyncSafe(value.subarray(offset, offset + 4)) : value.readUInt32BE(offset)

const encodeFrameSize = (value: number, syncSafe: boolean) => {
  if (syncSafe) return encodeSyncSafe(value)
  const output = Buffer.alloc(4)
  output.writeUInt32BE(value, 0)
  return output
}

const parseId3Frames = (data: Buffer) => {
  if (data.length < 10 || data.subarray(0, 3).toString('ascii') !== 'ID3') return null
  const major = data[3]
  if (major !== 3 && major !== 4) return null
  const tagSize = decodeSyncSafe(data.subarray(6, 10))
  const end = Math.min(data.length, 10 + tagSize)
  const frames: Id3Frame[] = []
  let offset = 10
  while (offset + 10 <= end) {
    const id = data.subarray(offset, offset + 4).toString('ascii')
    if (!/^[A-Z0-9]{4}$/.test(id) || id.charCodeAt(0) === 0) break
    const size = readUInt32(data, offset + 4, major === 4)
    if (size <= 0 || offset + 10 + size > end) break
    frames.push({
      id,
      flags: data.readUInt16BE(offset + 8),
      payload: Buffer.from(data.subarray(offset + 10, offset + 10 + size))
    })
    offset += 10 + size
  }
  return { major, flags: data[5], frames, audio: data.subarray(10 + tagSize) }
}

const readGeobDescription = (payload: Buffer) => {
  if (!payload.length) return ''
  let offset = 1
  for (let index = 0; index < 3; index += 1) {
    const end = payload.indexOf(0, offset)
    if (end < 0) return ''
    if (index === 2) return payload.subarray(offset, end).toString('utf8')
    offset = end + 1
  }
  return ''
}

const parseHexColor = (value: unknown) => {
  const match = String(value || '')
    .trim()
    .match(/^#?([0-9a-f]{6})$/i)
  if (!match) return null
  const number = Number.parseInt(match[1], 16)
  return [(number >>> 16) & 0xff, (number >>> 8) & 0xff, number & 0xff] as const
}

const resolveColor = (cue: SeratoHotCue) => {
  const parsed = parseHexColor(cue.color)
  if (parsed) return parsed
  const index = Number(cue.colorIndex)
  return DEFAULT_COLORS[Number.isInteger(index) && index >= 0 ? index % DEFAULT_COLORS.length : 0]
}

const normalizeCue = (cue: SeratoHotCue) => {
  const slot = Number(cue.slot)
  const sec = Number(cue.sec)
  if (!Number.isInteger(slot) || slot < 0 || slot > 7 || !Number.isFinite(sec) || sec < 0) {
    return null
  }
  const loopEnd = Number(cue.loopEndSec)
  const isLoop = Boolean(cue.isLoop) && Number.isFinite(loopEnd) && loopEnd > sec
  return {
    slot,
    sec,
    loopEndSec: isLoop ? loopEnd : undefined,
    name: String(cue.label || cue.comment || '')
      .trim()
      .slice(0, 51),
    color: resolveColor(cue)
  }
}

const encodeMarkerEntry = (cue: ReturnType<typeof normalizeCue>) => {
  if (!cue) return null
  const name = Buffer.from(cue.name, 'utf8')
  if (cue.loopEndSec !== undefined) {
    const body = Buffer.alloc(23 + name.length)
    body[1] = cue.slot
    body.writeUInt32BE(Math.min(0xffffffff, Math.round(cue.sec * 1000)), 2)
    body.writeUInt32BE(Math.min(0xffffffff, Math.round(cue.loopEndSec * 1000)), 6)
    body[14] = 255
    body[15] = cue.color[0]
    body[16] = cue.color[1]
    body[17] = cue.color[2]
    body[21] = 0
    name.copy(body, 22)
    body[22 + name.length] = 0
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length, 0)
    return Buffer.concat([Buffer.from('LOOP\0'), length, body])
  }
  const body = Buffer.alloc(13 + name.length)
  body[1] = cue.slot
  body.writeUInt32BE(Math.min(0xffffffff, Math.round(cue.sec * 1000)), 2)
  body[7] = cue.color[0]
  body[8] = cue.color[1]
  body[9] = cue.color[2]
  name.copy(body, 12)
  body[12 + name.length] = 0
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  return Buffer.concat([Buffer.from('CUE\0'), length, body])
}

const encodeMarkers = (cues: SeratoHotCue[]) => {
  const entries = cues.map(normalizeCue).map(encodeMarkerEntry).filter(Boolean) as Buffer[]
  const binary = Buffer.concat([MARKERS_HEADER, ...entries, Buffer.from([0])])
  const encoded = Buffer.from(binary.toString('base64'), 'ascii')
  const data = Buffer.concat([MARKERS_HEADER, encoded])
  return data.length >= 470 ? data : Buffer.concat([data, Buffer.alloc(470 - data.length)])
}

const encodeLegacyPosition = (sec?: number) => {
  if (sec === undefined) return Buffer.from([0x7f, 0x7f, 0x7f, 0x7f, 0x7f])
  const millis = Math.max(0, Math.min(0xffffff, Math.round(sec * 1000)))
  return Buffer.concat([Buffer.from([0]), encodeSerato32U32(millis)])
}

const encodeLegacyMarker = (params: {
  startSec?: number
  endSec?: number
  color: readonly [number, number, number]
  type: 0 | 1 | 3
}) =>
  Buffer.concat([
    encodeLegacyPosition(params.startSec),
    encodeLegacyPosition(params.endSec),
    Buffer.from([0, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f]),
    encodeSerato32Color({ r: params.color[0], g: params.color[1], b: params.color[2] }),
    Buffer.from([params.type, 0])
  ])

const encodeLegacyMarkers = (cues: SeratoHotCue[]) => {
  const normalized = cues.map(normalizeCue).filter(Boolean)
  const cueBySlot = new Map(normalized.map((cue) => [cue!.slot, cue!]))
  const entries: Buffer[] = []
  for (let slot = 0; slot < 5; slot += 1) {
    const cue = cueBySlot.get(slot)
    entries.push(
      cue
        ? encodeLegacyMarker({ startSec: cue.sec, color: cue.color, type: 1 })
        : encodeLegacyMarker({ color: [0, 0, 0], type: 0 })
    )
  }
  for (let slot = 0; slot < 9; slot += 1) {
    const cue = cueBySlot.get(slot)
    entries.push(
      cue?.loopEndSec !== undefined
        ? encodeLegacyMarker({
            startSec: cue.sec,
            endSec: cue.loopEndSec,
            color: [0x27, 0xaa, 0xe1],
            type: 3
          })
        : encodeLegacyMarker({ color: [0, 0, 0], type: 3 })
    )
  }
  const count = Buffer.alloc(4)
  count.writeUInt32BE(entries.length, 0)
  return Buffer.concat([
    Buffer.from([2, 5]),
    count,
    ...entries,
    encodeSerato32Color({ r: 255, g: 255, b: 255 })
  ])
}

const encodeVorbisMarkersValue = (cues: SeratoHotCue[]) => {
  const data = Buffer.concat([
    Buffer.from('application/octet-stream\0\0Serato Markers2\0', 'ascii'),
    encodeMarkers(cues)
  ])
  const base64 = data.toString('base64').replace(/=+$/g, '')
  return base64.replace(/.{1,72}/g, (line) => `${line}\n`).trimEnd()
}

const encodeGeobPayload = (description: string, data: Buffer) =>
  Buffer.concat([
    Buffer.from([0]),
    Buffer.from('application/octet-stream\0', 'ascii'),
    Buffer.from([0]),
    Buffer.from(`${description}\0`, 'utf8'),
    data
  ])

const encodeFrame = (frame: Id3Frame, syncSafe: boolean) =>
  Buffer.concat([
    Buffer.from(frame.id, 'ascii'),
    encodeFrameSize(frame.payload.length, syncSafe),
    Buffer.from([(frame.flags >>> 8) & 0xff, frame.flags & 0xff]),
    frame.payload
  ])

const writeId3Markers = (input: Buffer, cues: SeratoHotCue[]) => {
  const parsed = parseId3Frames(input)
  const markerFrames: Id3Frame[] = [
    {
      id: 'GEOB',
      flags: 0,
      payload: encodeGeobPayload(LEGACY_MARKERS_DESCRIPTION, encodeLegacyMarkers(cues))
    },
    {
      id: 'GEOB',
      flags: 0,
      payload: encodeGeobPayload(MARKERS_DESCRIPTION, encodeMarkers(cues))
    }
  ]
  if (!parsed) {
    const body = Buffer.concat(markerFrames.map((frame) => encodeFrame(frame, true)))
    return Buffer.concat([Buffer.from('ID3\x04\0\0'), encodeSyncSafe(body.length), body, input])
  }
  const frames = parsed.frames.filter(
    (frame) =>
      !(
        frame.id === 'GEOB' &&
        ['Serato Markers2', 'Serato Markers_'].includes(readGeobDescription(frame.payload))
      )
  )
  frames.push(...markerFrames)
  const body = Buffer.concat(frames.map((frame) => encodeFrame(frame, parsed.major === 4)))
  const header = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([parsed.major, 0, parsed.flags]),
    encodeSyncSafe(body.length)
  ])
  return Buffer.concat([header, body, parsed.audio])
}

const writeAiffMarkers = (input: Buffer, cues: SeratoHotCue[]) => {
  if (input.length < 12 || input.subarray(0, 4).toString('ascii') !== 'FORM') {
    throw new Error('AIFF 文件结构无效，无法写入 Serato Hot Cue。')
  }
  const chunks: Array<{ id: string; data: Buffer }> = []
  let offset = 12
  while (offset + 8 <= input.length) {
    const id = input.subarray(offset, offset + 4).toString('ascii')
    const size = input.readUInt32BE(offset + 4)
    if (offset + 8 + size > input.length) break
    chunks.push({ id, data: Buffer.from(input.subarray(offset + 8, offset + 8 + size)) })
    offset += 8 + size + (size % 2)
  }
  if (!chunks.length) throw new Error('AIFF 文件没有可识别的块，无法写入 Serato Hot Cue。')
  const existing = chunks.find((chunk) => chunk.id === 'ID3 ')
  const id3 = writeId3Markers(existing?.data || Buffer.alloc(0), cues)
  const nextChunks = existing
    ? chunks.map((chunk) => (chunk === existing ? { id: 'ID3 ', data: id3 } : chunk))
    : [...chunks, { id: 'ID3 ', data: id3 }]
  const body = Buffer.concat(
    nextChunks.map((chunk) => {
      const size = Buffer.alloc(4)
      size.writeUInt32BE(chunk.data.length, 0)
      return Buffer.concat([
        Buffer.from(chunk.id, 'ascii'),
        size,
        chunk.data,
        chunk.data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)
      ])
    })
  )
  const formSize = Buffer.alloc(4)
  formSize.writeUInt32BE(4 + body.length, 0)
  return Buffer.concat([input.subarray(0, 4), formSize, input.subarray(8, 12), body])
}

const writeFlacMarkers = (input: Buffer, cues: SeratoHotCue[]) => {
  if (input.subarray(0, 4).toString('ascii') !== 'fLaC') {
    throw new Error('FLAC 文件结构无效，无法写入 Serato Hot Cue。')
  }
  const blocks: Array<{ type: number; data: Buffer }> = []
  let offset = 4
  while (offset + 4 <= input.length) {
    const header = input.readUInt32BE(offset)
    const type = (header >>> 24) & 0x7f
    const size = header & 0xffffff
    offset += 4
    if (offset + size > input.length)
      throw new Error('FLAC 元数据块损坏，无法写入 Serato Hot Cue。')
    blocks.push({ type, data: Buffer.from(input.subarray(offset, offset + size)) })
    offset += size
    if ((header & 0x80000000) !== 0) break
  }
  const commentBlock = blocks.find((block) => block.type === 4)
  const marker = `SERATO_MARKERS_V2=${encodeVorbisMarkersValue(cues)}`
  if (commentBlock) {
    let cursor = 0
    const vendorLength = commentBlock.data.readUInt32LE(cursor)
    cursor += 4
    const vendor = commentBlock.data.subarray(cursor, cursor + vendorLength)
    cursor += vendorLength
    const count = commentBlock.data.readUInt32LE(cursor)
    cursor += 4
    const comments: Buffer[] = []
    for (let index = 0; index < count && cursor + 4 <= commentBlock.data.length; index += 1) {
      const length = commentBlock.data.readUInt32LE(cursor)
      cursor += 4
      comments.push(Buffer.from(commentBlock.data.subarray(cursor, cursor + length)))
      cursor += length
    }
    const filtered = comments.filter(
      (item) => !item.toString('utf8').toUpperCase().startsWith('SERATO_MARKERS_V2=')
    )
    const encodedComments = [...filtered, Buffer.from(marker, 'utf8')]
    const countBuffer = Buffer.alloc(4)
    countBuffer.writeUInt32LE(encodedComments.length, 0)
    commentBlock.data = Buffer.concat([
      commentBlock.data.subarray(0, 4 + vendorLength),
      countBuffer,
      ...encodedComments.flatMap((item) => {
        const length = Buffer.alloc(4)
        length.writeUInt32LE(item.length, 0)
        return [length, item]
      })
    ])
  } else {
    const vendor = Buffer.from('FRKB', 'utf8')
    const comment = Buffer.from(marker, 'utf8')
    const vendorLength = Buffer.alloc(4)
    vendorLength.writeUInt32LE(vendor.length, 0)
    const count = Buffer.alloc(4)
    count.writeUInt32LE(1, 0)
    const commentLength = Buffer.alloc(4)
    commentLength.writeUInt32LE(comment.length, 0)
    blocks.push({
      type: 4,
      data: Buffer.concat([vendorLength, vendor, count, commentLength, comment])
    })
  }
  const body = Buffer.concat(
    blocks.map((block, index) => {
      const header = Buffer.alloc(4)
      header.writeUInt32BE(
        ((index === blocks.length - 1 ? 0x80000000 : 0) |
          (block.type << 24) |
          block.data.length) >>>
          0,
        0
      )
      return Buffer.concat([header, block.data])
    })
  )
  return Buffer.concat([Buffer.from('fLaC', 'ascii'), body, input.subarray(offset)])
}

export const writeSeratoHotCues = async (filePath: string, cues: SeratoHotCue[]) => {
  const normalized = cues.map(normalizeCue).filter(Boolean)
  if (!normalized.length) return false
  const extension = path.extname(filePath).toLowerCase()
  if (!['.mp3', '.aiff', '.aif', '.flac'].includes(extension)) {
    throw new Error(
      `Serato Hot Cue 写入暂支持 MP3/AIFF/FLAC，当前格式为 ${extension || '未知格式'}。`
    )
  }
  const input = await fs.readFile(filePath)
  const output =
    extension === '.mp3'
      ? writeId3Markers(input, cues)
      : extension === '.flac'
        ? writeFlacMarkers(input, cues)
        : writeAiffMarkers(input, cues)
  await fs.writeFile(filePath, output)
  return true
}
