import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUsbSongEditResolver, editPioneerUsbSong } from './usbSongEditing'
import { optionalUsbFileHash } from './usbWriteFiles'
import type {
  PioneerUsbSongEditRequest,
  PioneerUsbSongEditResult
} from '../../../shared/pioneerUsbEditing'
import type { UsbSnapshotMap } from './usbWritePlan'

const { read, execute } = vi.hoisted(() => ({
  read: vi.fn(),
  execute: vi.fn()
}))
vi.mock('./workerPool', () => ({ readPioneerCuesInWorker: read }))
vi.mock('./usbWrite', () => ({ executePioneerUsbWrite: execute }))
vi.mock('../../log', () => ({ log: { error: vi.fn() } }))
vi.mock('../songHotCueEvents', () => ({ emitSongHotCuesUpdated: vi.fn() }))
vi.mock('../songMemoryCueEvents', () => ({ emitSongMemoryCuesUpdated: vi.fn() }))
vi.mock('../songGridEvents', () => ({ emitSongGridUpdated: vi.fn() }))
let directory = ''
let request: PioneerUsbSongEditRequest
let snapshots: UsbSnapshotMap
const native = () => ({
  hotCues: [
    {
      slot: 1,
      timeSec: 30,
      isLoop: true,
      loopTimeSec: 34,
      loopNumerator: 8,
      loopDenominator: 1,
      comment: '  keep native spacing  '
    }
  ],
  memoryCues: [
    {
      timeSec: 40,
      isLoop: true,
      loopTimeSec: 44,
      activeLoop: true,
      loopNumerator: 8,
      loopDenominator: 1,
      comment: '  memory  '
    }
  ]
})
beforeEach(async () => {
  vi.resetAllMocks()
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-song-edit-test-'))
  await fs.mkdir(path.join(directory, 'PIONEER'), { recursive: true })
  await fs.mkdir(path.join(directory, 'stage'))
  await fs.writeFile(path.join(directory, 'PIONEER', 'ANLZ0000.DAT'), 'private-copy-fixture')
  request = {
    source: { rootPath: directory, libraryType: 'oneLibrary', trackId: 7 },
    filePath: path.join(directory, 'Contents', '7.mp3'),
    edit: { kind: 'set-hot-cue', cue: { slot: 0, sec: 12 } }
  }
  snapshots = {
    oneLibrary: {
      tracks: [
        {
          id: 7,
          filePath: '/Contents/7.mp3',
          analyzePath: '/PIONEER/ANLZ0000.DAT',
          artworkPath: ''
        }
      ],
      playlists: [],
      entries: []
    }
  }
  read.mockImplementation(async (files: string[], progress: (item: unknown) => void) => {
    expect(files[0]).toContain(path.join('stage', 'cue-source'))
    expect(await fs.readFile(files[0], 'utf8')).toBe('private-copy-fixture')
    progress({ dump: native() })
  })
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})
const resolve = async () => {
  const result: PioneerUsbSongEditResult = { filePath: request.filePath }
  const operation = await createUsbSongEditResolver(request, result, vi.fn())(
    directory,
    snapshots,
    optionalUsbFileHash,
    path.join(directory, 'stage')
  )
  return { operation, result }
}

describe('USB player edits use fresh native cues in the commit snapshot', () => {
  it('adds one Hot Cue while preserving an unrelated loop, active memory loop and exact comments', async () => {
    const { operation, result } = await resolve()
    expect(operation.kind).toBe('set-cues')
    expect(result.hotCues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slot: 0, sec: 12 }),
        expect.objectContaining({
          slot: 1,
          loopNumerator: 8,
          loopDenominator: 1,
          comment: '  keep native spacing  '
        })
      ])
    )
    expect(result.memoryCues?.[0]).toMatchObject({
      sec: 40,
      activeLoop: true,
      comment: '  memory  '
    })
    expect(await fs.readFile(path.join(directory, 'PIONEER', 'ANLZ0000.DAT'), 'utf8')).toBe(
      'private-copy-fixture'
    )
  })
  it('deletes one Hot Cue without normalizing other native metadata', async () => {
    request.edit = { kind: 'delete-hot-cue', slot: 0 }
    const { result } = await resolve()
    expect(result.hotCues?.[0].comment).toBe('  keep native spacing  ')
    expect(result.memoryCues?.[0].comment).toBe('  memory  ')
  })
  it('adds a memory point without replacing an active memory loop', async () => {
    request.edit = { kind: 'add-memory-cue', cue: { sec: 20 } }
    const { result } = await resolve()
    expect(result.memoryCues).toHaveLength(2)
    expect(result.memoryCues?.[1]).toMatchObject({ sec: 40, activeLoop: true })
    expect(result.hotCues?.[0].comment).toBe('  keep native spacing  ')
  })
  it('rejects a changed track identity before reading or modifying any file', async () => {
    request.filePath = path.join(directory, 'Contents', 'other.mp3')
    await expect(resolve()).rejects.toThrow('歌曲已变化')
    expect(read).not.toHaveBeenCalled()
  })
  it('rejects incomplete native cue reads instead of treating them as an empty list', async () => {
    read.mockImplementation(async (_files, progress) => progress({ dump: { hotCues: [] } }))
    await expect(resolve()).rejects.toThrow('完整读取')
  })
  it('resolves grid moves without reading or overwriting cues', async () => {
    request.edit = { kind: 'shift-grid', offsetMs: -5 }
    expect((await resolve()).operation).toEqual({ kind: 'shift-grid', trackId: 7, offsetMs: -5 })
    expect(read).not.toHaveBeenCalled()
  })
  it('rejects an invalid cue before preparing a write', async () => {
    request.edit = { kind: 'set-hot-cue', cue: { slot: 9, sec: 12 } }
    expect((await editPioneerUsbSong(request, 1)).ok).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
  it('serializes fresh preparation and commit for rapid edits on the same drive', async () => {
    let finish: ((value: unknown) => void) | undefined
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    execute.mockResolvedValue({ ok: true, result: {} })
    const first = editPioneerUsbSong(request, 1)
    const second = editPioneerUsbSong({ ...request, edit: { kind: 'delete-hot-cue', slot: 1 } }, 1)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    finish?.({ ok: true, result: {} })
    await Promise.all([first, second])
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
