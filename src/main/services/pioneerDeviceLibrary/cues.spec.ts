import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enrichPioneerTracksWithCueData, normalizePioneerCueDump } from './cues'
import { readPioneerCuesInWorker } from './workerPool'
import type { IPioneerPlaylistTrack } from '../../../types/globals'

vi.mock('../../log', () => ({ log: { error: vi.fn() } }))
vi.mock('./workerPool', () => ({ readPioneerCuesInWorker: vi.fn() }))

const rootPath = path.resolve('cue-read-fixture')
const makeTrack = (trackId = 1): IPioneerPlaylistTrack => ({
  rowKey: `pioneer:10:${trackId}:${trackId}`,
  playlistId: 10,
  playlistName: 'Fixture',
  trackId,
  entryIndex: trackId,
  title: 'Fixture track',
  artist: '',
  album: '',
  label: '',
  genre: '',
  filePath: path.join(rootPath, 'Contents', `${trackId}.mp3`),
  fileName: `${trackId}.mp3`,
  fileFormat: 'MP3',
  container: 'MP3',
  duration: '03:00',
  durationSec: 180,
  analyzePath: `/PIONEER/USBANLZ/${trackId}/ANLZ0000.DAT`,
  hotCues: [{ slot: 0, sec: 99, comment: 'Stale cached cue' }],
  memoryCues: [{ sec: 100 }]
})

beforeEach(() => vi.clearAllMocks())

describe('native cue dump normalization', () => {
  it('preserves quantized beat counts for Hot and Memory loops', () => {
    const ratio = { loopNumerator: 8, loopDenominator: 1 }
    const dump = normalizePioneerCueDump({
      hotCues: [{ slot: 1, timeSec: 30.029, isLoop: true, loopTimeSec: 33.34, ...ratio }],
      memoryCues: [
        { timeSec: 40, isLoop: true, loopTimeSec: 41, loopNumerator: 1, loopDenominator: 2 }
      ]
    })
    expect(dump.hotCues?.[0]).toMatchObject(ratio)
    expect(dump.memoryCues?.[0]).toMatchObject({ loopNumerator: 1, loopDenominator: 2 })
    expect(
      normalizePioneerCueDump({ hotCues: [{ slot: 0, timeSec: 1, ...ratio }] }).hotCues?.[0]
        .loopNumerator
    ).toBeUndefined()
  })
  it('preserves cue comment whitespace when preparing unrelated cue edits', () => {
    const dump = normalizePioneerCueDump({
      hotCues: [{ slot: 0, timeSec: 1, comment: '  Native comment  ' }],
      memoryCues: [{ timeSec: 2, comment: '  ' }]
    })
    expect(dump.hotCues?.[0].comment).toBe('  Native comment  ')
    expect(dump.memoryCues?.[0].comment).toBe('  ')
  })
  it('passes actual active-loop status alongside extended comment and color metadata', () => {
    const dump = normalizePioneerCueDump({
      memoryCues: [
        {
          timeSec: 1,
          isLoop: true,
          loopTimeSec: 2,
          activeLoop: true,
          comment: 'Native comment',
          colorIndex: 2,
          colorHex: '#ff0000'
        }
      ]
    })
    expect(dump.memoryCues?.[0]).toMatchObject({
      sec: 1,
      loopEndSec: 2,
      activeLoop: true,
      comment: 'Native comment',
      colorIndex: 2,
      color: '#ff0000'
    })
  })

  it('preserves explicitly inactive loops and keeps missing status unknown', () => {
    const inactive = normalizePioneerCueDump({
      memoryCues: [{ timeSec: 1, isLoop: true, loopTimeSec: 2, activeLoop: false }]
    })
    const unknown = normalizePioneerCueDump({
      memoryCues: [{ timeSec: 1, isLoop: true, loopTimeSec: 2 }]
    })
    expect(inactive.memoryCues?.[0].activeLoop).toBe(false)
    expect(unknown.memoryCues?.[0].activeLoop).toBeUndefined()
  })

  it('distinguishes successfully read empty cue lists from failed or missing analysis', () => {
    expect(normalizePioneerCueDump({ hotCues: [], memoryCues: [] })).toEqual({
      hotCues: [],
      memoryCues: []
    })
    expect(
      normalizePioneerCueDump({ hotCues: [], memoryCues: [], error: 'cue file not found' })
    ).toEqual({})
    expect(normalizePioneerCueDump(undefined)).toEqual({})
  })
})

describe('required cue reads for editing', () => {
  const readCues = vi.mocked(readPioneerCuesInWorker)
  const emitDump = (dump: Parameters<typeof normalizePioneerCueDump>[0]) => {
    readCues.mockImplementation(async (paths, progress) => {
      progress?.({ analyzeFilePath: paths[0], dump })
      return { total: paths.length }
    })
  }

  it('replaces stale cached cues with confirmed empty lists', async () => {
    emitDump({ hotCues: [], memoryCues: [] })
    const source = makeTrack()
    const result = await enrichPioneerTracksWithCueData(rootPath, [source], { requireCues: true })
    expect(result[0]).toMatchObject({ hotCues: [], memoryCues: [] })
    expect(source.hotCues).toEqual([{ slot: 0, sec: 99, comment: 'Stale cached cue' }])
  })

  it.each([
    null,
    { hotCues: [], memoryCues: [], error: 'analysis file unreadable' },
    { hotCues: [] },
    { hotCues: [{ slot: 0, timeSec: Number.NaN }], memoryCues: [] },
    { hotCues: [], memoryCues: [{ timeSec: 1, isLoop: true }] },
    {
      hotCues: [{ slot: 1, timeSec: 30, isLoop: true, loopTimeSec: 34, loopNumerator: 8 }],
      memoryCues: []
    },
    {
      hotCues: [
        {
          slot: 1,
          timeSec: 30,
          isLoop: true,
          loopTimeSec: 34,
          loopNumerator: 3,
          loopDenominator: 1
        }
      ],
      memoryCues: []
    },
    { hotCues: [{ slot: 8, timeSec: 1 }], memoryCues: [] },
    { hotCues: [], memoryCues: Array.from({ length: 11 }, (_, timeSec) => ({ timeSec })) },
    { hotCues: [], memoryCues: [{ timeSec: 1 }, { timeSec: 1.0001 }] }
  ])('rejects missing, failed, incomplete or invalid cue dumps: %j', async (dump) => {
    emitDump(dump)
    await expect(
      enrichPioneerTracksWithCueData(rootPath, [makeTrack()], { requireCues: true })
    ).rejects.toThrow()
  })

  it('rejects when one requested analysis path never emits a cue result', async () => {
    emitDump({ hotCues: [], memoryCues: [] })
    await expect(
      enrichPioneerTracksWithCueData(rootPath, [makeTrack(1), makeTrack(2)], {
        requireCues: true
      })
    ).rejects.toThrow('部分歌曲标点未读取完成')
  })

  it('rejects missing analysis paths before starting a worker', async () => {
    await expect(
      enrichPioneerTracksWithCueData(rootPath, [{ ...makeTrack(), analyzePath: undefined }], {
        requireCues: true
      })
    ).rejects.toThrow('歌曲缺少分析文件路径')
    expect(readCues).not.toHaveBeenCalled()
  })

  it('rejects analysis paths traversing outside the device before starting a worker', async () => {
    await expect(
      enrichPioneerTracksWithCueData(
        rootPath,
        [{ ...makeTrack(), analyzePath: '/../outside/ANLZ0000.DAT' }],
        { requireCues: true }
      )
    ).rejects.toThrow('设备文件路径包含非法目录')
    expect(readCues).not.toHaveBeenCalled()
  })

  it('resolves native device paths below the root and accepts an absolute path inside it', async () => {
    emitDump({ hotCues: [], memoryCues: [] })
    const absolute = path.join(rootPath, 'PIONEER', 'USBANLZ', '1', 'ANLZ0000.DAT')
    await enrichPioneerTracksWithCueData(rootPath, [makeTrack()], { requireCues: true })
    expect(readCues.mock.calls[0][0]).toEqual([absolute])
    await enrichPioneerTracksWithCueData(rootPath, [{ ...makeTrack(), analyzePath: absolute }], {
      requireCues: true
    })
    expect(readCues.mock.calls[1][0]).toEqual([absolute])
  })

  it('rejects a worker failure instead of returning cached cues', async () => {
    readCues.mockRejectedValue(new Error('worker crashed'))
    await expect(
      enrichPioneerTracksWithCueData(rootPath, [makeTrack()], { requireCues: true })
    ).rejects.toThrow('worker crashed')
  })

  it('preserves the regular list behavior on read failure', async () => {
    emitDump({ hotCues: [], memoryCues: [], error: 'analysis file unreadable' })
    const track = makeTrack()
    expect(await enrichPioneerTracksWithCueData(rootPath, [track])).toEqual([track])
    readCues.mockRejectedValue(new Error('worker crashed'))
    expect(await enrichPioneerTracksWithCueData(rootPath, [track])).toEqual([track])
  })

  it('shares a complete result for equivalent device paths without losing either track', async () => {
    const first = makeTrack(1)
    const second = { ...makeTrack(2), analyzePath: first.analyzePath?.replace(/\//g, '\\') }
    emitDump({ hotCues: [{ slot: 0, timeSec: 1 }], memoryCues: [] })
    const result = await enrichPioneerTracksWithCueData(rootPath, [first, second], {
      requireCues: true
    })
    expect(readCues.mock.calls[0][0]).toHaveLength(1)
    expect(result.map((track) => track.hotCues?.[0].sec)).toEqual([1, 1])
  })
})
