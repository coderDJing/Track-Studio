import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExternalLibrarySnapshot } from '../../../shared/externalLibrary'
import {
  WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
  WAVEFORM_SURFACE_CACHE_VERSION,
  type WaveformListPreviewData
} from '../../../shared/waveformSurfaceCache'

const STRIPE_HEADER_SIZE = 25
const STRIPE_WIDTH = 1024
const STRIPE_HEIGHT = 64
const STRIPE_FRAME_SIZE = 4
const PREVIEW_COLUMNS = STRIPE_WIDTH
const HASH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
const HASH_INITIAL_STATE = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
const HASH_SHIFT_ROUNDS = [
  [7, 12, 17, 22],
  [5, 9, 14, 20],
  [4, 11, 16, 23],
  [6, 10, 15, 21]
]
const HASH_SHIFTS = Array.from(
  { length: 64 },
  (_, index) => HASH_SHIFT_ROUNDS[Math.floor(index / 16)][index % 4]
)
const HASH_TABLE = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
)

// Traktor's TrackID hash uses MD5 rounds with a final zero block instead of MD5 padding.
// Path derivation was independently documented by traktor-stem-bridge (MIT):
// https://github.com/zicez/traktor-stem-bridge/blob/main/docs/algorithm.md
export const resolveTraktorStripeRelativePath = (audioId: string): string | null => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audioId)) return null
  const trackId = Buffer.from(audioId, 'base64')
  if (trackId.length !== 256) return null
  const state = [...HASH_INITIAL_STATE]
  for (let blockIndex = 0; blockIndex <= 4; blockIndex += 1) {
    const words = Array.from({ length: 16 }, (_, index) =>
      blockIndex === 4 ? 0 : trackId.readUInt32LE(blockIndex * 64 + index * 4)
    )
    let [a, b, c, d] = state
    for (let index = 0; index < 64; index += 1) {
      let value: number
      let wordIndex: number
      if (index < 16) {
        value = (b & c) | (~b & d)
        wordIndex = index
      } else if (index < 32) {
        value = (d & b) | (~d & c)
        wordIndex = (5 * index + 1) % 16
      } else if (index < 48) {
        value = b ^ c ^ d
        wordIndex = (3 * index + 5) % 16
      } else {
        value = c ^ (b | ~d)
        wordIndex = (7 * index) % 16
      }
      const sum = (a + value + HASH_TABLE[index] + words[wordIndex]) >>> 0
      const rotated = (sum << HASH_SHIFTS[index]) | (sum >>> (32 - HASH_SHIFTS[index]))
      const nextB = (b + rotated) >>> 0
      a = d
      d = c
      c = b
      b = nextB
    }
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
  }
  const shard = String(state[0] & 0x7f).padStart(3, '0')
  const basename = state
    .flatMap((word) =>
      [0, 5, 10, 15, 20, 25, 30].map((shift) => HASH_ALPHABET[(word >>> shift) & 31])
    )
    .join('')
  return path.join('Stripes', shard, basename)
}

export const parseTraktorStripePreview = (
  raw: Buffer,
  durationSec: number
): WaveformListPreviewData | null => {
  if (
    raw.length !== STRIPE_HEADER_SIZE + STRIPE_WIDTH * STRIPE_HEIGHT * STRIPE_FRAME_SIZE ||
    raw[0] !== 6 ||
    raw.toString('ascii', 1, 5) !== 'PRTS' ||
    raw[5] !== 2 ||
    raw.readUInt32LE(13) !== STRIPE_WIDTH ||
    raw.readUInt32LE(17) !== STRIPE_HEIGHT ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0
  )
    return null

  const detailPeakTop = new Uint8Array(PREVIEW_COLUMNS)
  const detailPeakBottom = new Uint8Array(PREVIEW_COLUMNS)
  const detailBody = new Uint8Array(PREVIEW_COLUMNS)
  const colorIndex = new Uint8Array(PREVIEW_COLUMNS)
  const colorLow = new Uint8Array(PREVIEW_COLUMNS)
  const colorMid = new Uint8Array(PREVIEW_COLUMNS)
  const colorHigh = new Uint8Array(PREVIEW_COLUMNS)
  const colorRed = new Uint8Array(PREVIEW_COLUMNS)
  const colorGreen = new Uint8Array(PREVIEW_COLUMNS)
  const colorBlue = new Uint8Array(PREVIEW_COLUMNS)
  // PRTS stores a premultiplied RGBA overview bitmap, column-major, not 65536 audio frames.
  const rgba = new Uint8Array(STRIPE_WIDTH * STRIPE_HEIGHT * STRIPE_FRAME_SIZE)
  const center = STRIPE_HEIGHT / 2

  for (let column = 0; column < PREVIEW_COLUMNS; column += 1) {
    let top = 0
    let bottom = 0
    let alphaSum = 0
    let redSum = 0
    let greenSum = 0
    let blueSum = 0
    for (let row = 0; row < STRIPE_HEIGHT; row += 1) {
      const offset = STRIPE_HEADER_SIZE + (column * STRIPE_HEIGHT + row) * STRIPE_FRAME_SIZE
      const target = (row * STRIPE_WIDTH + column) * STRIPE_FRAME_SIZE
      const alpha = raw[offset + 3]
      rgba[target + 3] = alpha
      if (!alpha) continue
      // ImageData expects straight alpha; the cache's colors are premultiplied.
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[target + channel] = Math.min(255, Math.round((raw[offset + channel] * 255) / alpha))
      }
      top = Math.max(top, center - row)
      bottom = Math.max(bottom, row + 1 - center)
      alphaSum += alpha
      redSum += raw[offset]
      greenSum += raw[offset + 1]
      blueSum += raw[offset + 2]
    }
    detailPeakTop[column] = Math.round((top / center) * 255)
    detailPeakBottom[column] = Math.round((bottom / center) * 255)
    detailBody[column] = Math.round(alphaSum / STRIPE_HEIGHT)
    colorIndex[column] = 3
    if (alphaSum) {
      colorRed[column] = Math.min(255, Math.round((redSum / alphaSum) * 255))
      colorGreen[column] = Math.min(255, Math.round((greenSum / alphaSum) * 255))
      colorBlue[column] = Math.min(255, Math.round((blueSum / alphaSum) * 255))
    }
  }

  const detailRate = PREVIEW_COLUMNS / durationSec
  return {
    surfaceKind: 'listPreview',
    version: WAVEFORM_SURFACE_CACHE_VERSION,
    parameterVersion: WAVEFORM_LIST_PREVIEW_PARAMETER_VERSION,
    duration: durationSec,
    sampleRate: 0,
    detailRate,
    overviewRate: detailRate,
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
    overviewBottom: new Uint8Array(detailPeakBottom),
    nativeBitmap: { width: STRIPE_WIDTH, height: STRIPE_HEIGHT, rgba }
  }
}

export const loadTraktorStripePreviews = async (
  snapshot: ExternalLibrarySnapshot,
  filePaths: string[]
): Promise<Array<{ filePath: string; data: WaveformListPreviewData | null }>> => {
  const tracksByPath = new Map(
    snapshot.tracks.map((track) => [path.normalize(track.filePath).toLowerCase(), track])
  )
  const collectionDir = path.dirname(snapshot.libraryPath)
  const items: Array<{ filePath: string; data: WaveformListPreviewData | null }> = []
  for (const filePath of filePaths) {
    const track = tracksByPath.get(path.normalize(filePath).toLowerCase())
    const relativePath = track?.audioId ? resolveTraktorStripeRelativePath(track.audioId) : null
    let data: WaveformListPreviewData | null = null
    if (relativePath) {
      try {
        data = parseTraktorStripePreview(
          await fs.readFile(path.join(collectionDir, relativePath)),
          track?.durationSec || 0
        )
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
    }
    items.push({ filePath, data })
  }
  return items
}
