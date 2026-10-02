import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildExternalLibraryBrowserTracks } from './browserAdapter'
import type { ExternalLibrarySnapshot } from '../../../shared/externalLibrary'

vi.mock('../audioTimeBasisOffset', () => ({
  resolveAudioTimeBasisOffsetMsForFile: vi.fn(async () => 0)
}))

import {
  hydrateTraktorTrackTimeBases,
  parseTraktorMp3ControlFrameOffsetMs
} from './traktorAudioTimeBasis'

const makeFrames = (rateIndex = 0, version = 3, mono = false) => {
  const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const length = Math.floor((version === 3 ? 144000 * 128 : 72000 * 64) / rate)
  const bytes = Buffer.alloc(length * 2)
  const header =
    (0xffe00000 |
      (version << 19) |
      (1 << 17) |
      (1 << 16) |
      ((8 + (version === 3 ? 1 : 0)) << 12) |
      (rateIndex << 10) |
      (mono ? 3 << 6 : 0)) >>>
    0
  bytes.writeUInt32BE(header, 0)
  bytes.writeUInt32BE(header, length)
  const side = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17
  bytes.write('Xing', 4 + side)
  bytes.writeUInt32BE(1, 8 + side)
  bytes.writeUInt32BE(2, 12 + side)
  bytes.write('Apple', 16 + side)
  return bytes
}

describe('Traktor PCM timeline lead-in', () => {
  let tempRoot = ''
  afterEach(async () => {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true })
    tempRoot = ''
  })

  it.each([0, 1, 2])('uses one MPEG frame at sample-rate index %s, not a fixed 26ms', (index) => {
    expect(parseTraktorMp3ControlFrameOffsetMs(makeFrames(index))).toBeCloseTo(
      (1152 / [44100, 48000, 32000][index]) * 1000,
      6
    )
  })

  it('handles mono and MPEG2 and leaves streams without Xing unchanged', () => {
    expect(parseTraktorMp3ControlFrameOffsetMs(makeFrames(0, 2, true))).toBeCloseTo(
      (576 / 22050) * 1000,
      6
    )
    const bytes = makeFrames()
    bytes.fill(0, 36, 40)
    expect(parseTraktorMp3ControlFrameOffsetMs(bytes)).toBe(0)
    expect(parseTraktorMp3ControlFrameOffsetMs(Buffer.from('Xing is not an MPEG frame'))).toBe(0)
    expect(parseTraktorMp3ControlFrameOffsetMs(makeFrames().subarray(0, 100))).toBe(0)
  })

  it('does not treat a LAME string with an invalid CRC as a recognized control frame', () => {
    const bytes = makeFrames()
    bytes.write('LAME3.100', 48)
    expect(parseTraktorMp3ControlFrameOffsetMs(bytes)).toBeCloseTo((1152 / 44100) * 1000, 6)
  })

  it('recognizes a complete LAME tag with a CRC independently verified by ffprobe', () => {
    const prefix = Buffer.from(
      '//uQwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAJAAAQUgAzMzMzMzMzMzMzM0xMTExMTExMTExMZmZmZmZmZmZmZmZ/f39/f39/f39/f5mZmZmZmZmZmZmZs7Ozs7Ozs7Ozs7PMzMzMzMzMzMzMzObm5ubm5ubm5ubm//////////////8AAAAATEFNRTMuMTAwAAAAAAAAAAAAAAAAJAPMAAAAAAAAEFLvDiYT',
      'base64'
    )
    const bytes = Buffer.alloc(834)
    prefix.copy(bytes)
    prefix.copy(bytes, 417, 0, 4)
    expect(parseTraktorMp3ControlFrameOffsetMs(bytes)).toBe(0)
    bytes[prefix.length - 1] ^= 1
    expect(parseTraktorMp3ControlFrameOffsetMs(bytes)).toBeCloseTo((1152 / 44100) * 1000, 6)
  })

  it('skips ID3 artwork, preserves native grids/cues, and invalidates changed audio headers', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-traktor-time-basis-'))
    const filePath = path.join(tempRoot, 'Apple.mp3')
    const id3 = Buffer.alloc(80_010)
    id3.write('ID3', 0)
    id3[3] = 4
    id3[7] = 4
    id3[8] = 113
    id3[9] = 0 // 80000 bytes of ID3 payload
    await fs.writeFile(filePath, Buffer.concat([id3, makeFrames()]))
    const track = {
      id: 'apple',
      filePath,
      bpm: 135.000504,
      durationSec: 131.004074,
      cues: [
        { kind: 'grid' as const, positionMs: 73.127575, bpm: 135.000504 },
        { kind: 'hotCue' as const, positionMs: 73.127575, slot: 0 }
      ]
    }
    const tracks = await hydrateTraktorTrackTimeBases([track])
    expect(tracks[0].timeBasisOffsetMs).toBe(26.122)
    expect(tracks[0].cues).toBe(track.cues)
    const snapshot: ExternalLibrarySnapshot = {
      kind: 'traktor',
      rootPath: tempRoot,
      libraryPath: '',
      tracks,
      playlists: [],
      warnings: []
    }
    const browser = buildExternalLibraryBrowserTracks(snapshot, 1).tracks[0]
    expect(browser.timeBasisOffsetMs).toBe(26.122)
    expect(browser.beatGridMap?.clips[0].anchorSec).toBeCloseTo(0.073127575, 6)
    expect(browser.hotCues?.[0].sec).toBeCloseTo(0.073127575, 6)
    const noXing = makeFrames()
    noXing.fill(0, 36, 40)
    await fs.writeFile(filePath, noXing)
    expect((await hydrateTraktorTrackTimeBases([track]))[0].timeBasisOffsetMs).toBe(0)
    expect(track).not.toHaveProperty('timeBasisOffsetMs')
  })
})
