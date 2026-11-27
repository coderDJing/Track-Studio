import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ export: vi.fn(), import: vi.fn(async () => {}) }))
vi.mock('./icloudLibrary', () => ({
  openIcloudExport: mocks.export,
  copyIcloudDropToLocal: mocks.import
}))
import {
  dropIcloudOnPlaylist,
  dropLocalSongsOnIcloud,
  ICLOUD_DRAG_MIME,
  parseIcloudDragPayload
} from './icloudDrag'
const payload = { version: 1, rootToken: 'selected-root', paths: ['Album/song.mp3'] }
function event(mime: string, value: unknown) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      types: [mime],
      getData: (key: string) => (key === mime ? JSON.stringify(value) : '')
    }
  } as unknown as DragEvent
}
beforeEach(() => vi.clearAllMocks())
describe('copy-only music drag protocol', () => {
  it('exports the actual local payload, not stale global drag state', () => {
    expect(
      dropLocalSongsOnIcloud(
        event('application/x-song-drag', {
          type: 'song',
          sourceSongListUUID: 'source',
          paths: ['/playlist/actual.mp3']
        }),
        ['/stale.mp3']
      )
    ).toBe(true)
    expect(mocks.export).toHaveBeenCalledWith('source', ['/playlist/actual.mp3'])
  })
  it('exports into the folder explicitly under the pointer with current root authorization', () => {
    expect(
      dropLocalSongsOnIcloud(
        event('application/x-song-drag', {
          sourceSongListUUID: 'source',
          paths: ['/playlist/actual.mp3']
        }),
        [],
        'Album',
        'root-token'
      )
    ).toBe(true)
    expect(mocks.export).toHaveBeenCalledWith(
      'source',
      ['/playlist/actual.mp3'],
      'Album',
      'root-token'
    )
  })
  it('imports into the exact ordinary playlist drop target with its root-bound cloud payload', async () => {
    expect(
      await dropIcloudOnPlaylist(
        event(ICLOUD_DRAG_MIME, payload),
        'target-uuid',
        'songList',
        'CuratedLibrary'
      )
    ).toBe(true)
    expect(mocks.import).toHaveBeenCalledWith('target-uuid', payload)
  })
  it.each([
    ['folder', 'CuratedLibrary'],
    ['songList', 'MixtapeLibrary'],
    ['songList', 'RecycleBin']
  ])(
    'never routes cloud songs to unsupported %s/%s targets or a move handler',
    async (type, library) => {
      expect(
        await dropIcloudOnPlaylist(event(ICLOUD_DRAG_MIME, payload), 'wrong', type, library)
      ).toBe(true)
      expect(mocks.import).not.toHaveBeenCalled()
    }
  )
  it.each([['../escape.mp3'], ['/absolute.mp3'], ['bad\0name'], []].map((paths) => ({ paths })))(
    'rejects an invalid cloud path set %j',
    ({ paths }) => {
      expect(parseIcloudDragPayload(JSON.stringify({ ...payload, paths }))).toBeNull()
    }
  )
  it('deduplicates selected paths and requires root identity', () => {
    expect(
      parseIcloudDragPayload(JSON.stringify({ ...payload, paths: ['a.mp3', 'a.mp3'] }))?.paths
    ).toEqual(['a.mp3'])
    expect(parseIcloudDragPayload(JSON.stringify({ ...payload, rootToken: '' }))).toBeNull()
  })
  it('does not intercept unrelated file or playlist drags', async () => {
    expect(
      await dropIcloudOnPlaylist(event('Files', []), 'target', 'songList', 'FilterLibrary')
    ).toBe(false)
    expect(dropLocalSongsOnIcloud(event('application/x-song-drag', { paths: ['a.mp3'] }), [])).toBe(
      false
    )
    expect(mocks.export).not.toHaveBeenCalled()
  })
})
