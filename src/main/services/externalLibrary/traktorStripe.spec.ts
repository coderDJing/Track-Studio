import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExternalLibrarySnapshot } from '../../../shared/externalLibrary'
import {
  loadTraktorStripePreviews,
  parseTraktorStripePreview,
  resolveTraktorStripeRelativePath
} from './traktorStripe'

const zeroAudioId = Buffer.alloc(256).toString('base64')
const sequentialAudioId = Buffer.from(Array.from({ length: 256 }, (_, index) => index)).toString(
  'base64'
)

const makeStripe = () => {
  const raw = Buffer.alloc(25 + 65_536 * 4)
  raw[0] = 6
  raw.write('PRTS', 1, 'ascii')
  raw[5] = 2
  raw.writeUInt32LE(1024, 13)
  raw.writeUInt32LE(64, 17)
  for (let column = 0; column < 1024; column += 1) {
    const radius = column >= 512 ? 24 : 8
    for (let row = 32 - radius; row < 32 + radius; row += 1) {
      const offset = 25 + (column * 64 + row) * 4
      raw[offset] = 25
      raw[offset + 1] = 50
      raw[offset + 2] = 100
      raw[offset + 3] = 128
    }
  }
  return raw
}

describe('Traktor Stripe previews', () => {
  it('derives native Stripe paths from TrackID without using audio filenames', () => {
    expect(resolveTraktorStripeRelativePath(zeroAudioId)).toBe(
      path.join('Stripes', '031', '5MO1STA4IXTHCA3NYWKDDKERCO3A')
    )
    expect(resolveTraktorStripeRelativePath(sequentialAudioId)).toBe(
      path.join('Stripes', '098', 'CTPFBGASQA4Q5BRYNBCRBCEBXBLA')
    )
    expect(resolveTraktorStripeRelativePath('invalid')).toBeNull()
  })

  it('decodes the native column-major overview bitmap without inventing audio samples', () => {
    const data = parseTraktorStripePreview(makeStripe(), 120)
    expect(data?.detailPeakTop).toHaveLength(1024)
    expect(data!.detailPeakTop[16]).toBeLessThan(data!.detailPeakTop[900])
    expect(data!.detailBody[16]).toBeLessThan(data!.detailBody[900])
    expect(data?.nativeBitmap?.width).toBe(1024)
    expect(data?.nativeBitmap?.height).toBe(64)
    const pixels = data!.nativeBitmap!.rgba
    const pixel = (row: number, column: number) =>
      pixels.slice((row * 1024 + column) * 4, (row * 1024 + column + 1) * 4)
    expect(Array.from(pixel(16, 16))).toEqual([0, 0, 0, 0])
    expect(Array.from(pixel(16, 900))).toEqual([50, 100, 199, 128])
    expect(Array.from(pixel(32, 16))).toEqual([50, 100, 199, 128])
    expect(parseTraktorStripePreview(Buffer.alloc(25), 120)).toBeNull()
    const unsupported = makeStripe()
    unsupported.writeUInt32LE(2048, 13)
    expect(parseTraktorStripePreview(unsupported, 120)).toBeNull()
  })

  it('matches a collection track to its Stripe file', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-traktor-stripe-test-'))
    try {
      const filePath = path.join(tempRoot, 'track.mp3')
      const relativePath = resolveTraktorStripeRelativePath(zeroAudioId)!
      const stripePath = path.join(tempRoot, relativePath)
      const snapshot: ExternalLibrarySnapshot = {
        kind: 'traktor',
        rootPath: tempRoot,
        libraryPath: path.join(tempRoot, 'collection.nml'),
        tracks: [{ id: 'test', filePath, audioId: zeroAudioId, durationSec: 120, cues: [] }],
        playlists: [],
        warnings: []
      }
      expect((await loadTraktorStripePreviews(snapshot, [filePath]))[0].data).toBeNull()
      await fs.mkdir(path.dirname(stripePath), { recursive: true })
      await fs.writeFile(stripePath, makeStripe())
      const result = await loadTraktorStripePreviews(snapshot, [filePath])
      expect(result[0].data?.surfaceKind).toBe('listPreview')
      expect(result[0].data?.detailPeakTop[900]).toBeGreaterThan(0)
      expect(result[0].data?.nativeBitmap?.rgba).toHaveLength(1024 * 64 * 4)
    } finally {
      if (!path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        throw new Error('Temporary test directory is outside the system temp root.')
      }
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })
})
