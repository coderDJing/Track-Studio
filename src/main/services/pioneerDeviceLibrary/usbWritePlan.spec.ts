import { describe, expect, it } from 'vitest'
import { planUsbWrite } from './usbWritePlan'
import type { UsbLibrarySnapshot } from './usbWriteModel'

const snapshot = (offset = 0): UsbLibrarySnapshot => ({
  tracks: [1, 2, 3].map((id) => ({
    id: id + offset,
    filePath: `/Contents/${id}.mp3`,
    analyzePath: `/PIONEER/USBANLZ/${id}/ANLZ0000.DAT`,
    artworkPath: ''
  })),
  playlists: [
    { id: 10 + offset, parentId: 0, name: 'A', isFolder: false },
    { id: 20 + offset, parentId: 0, name: 'B', isFolder: false }
  ],
  entries: [
    { playlistId: 10 + offset, trackId: 1 + offset, entryIndex: 1 },
    { playlistId: 10 + offset, trackId: 2 + offset, entryIndex: 2 },
    { playlistId: 20 + offset, trackId: 2 + offset, entryIndex: 1 }
  ]
})

describe('USB cross-library write planning', () => {
  it('maps paths and hierarchy instead of assuming identical IDs', () => {
    const plan = planUsbWrite(
      { deviceLibrary: snapshot(), oneLibrary: snapshot(100) },
      'deviceLibrary',
      { kind: 'reorder', playlistId: 10, trackIds: [2, 1] }
    )
    expect(plan.oneLibrary?.reorders).toEqual([{ playlistId: 110, trackIds: [102, 101] }])
  })
  it('adds a reference to the target while retaining the source and audio records', () => {
    const plan = planUsbWrite(
      { deviceLibrary: snapshot(), oneLibrary: snapshot(100) },
      'deviceLibrary',
      { kind: 'add-to-playlist', playlistId: 20, trackIds: [1] }
    )
    expect(plan.oneLibrary?.additions).toEqual([{ playlistId: 120, trackIds: [101] }])
    expect(plan.deviceLibrary?.deleteTrackIds).toEqual([])
    expect(plan.deviceLibrary?.removals).toEqual([])
  })
  it('deletes only affected exclusive tracks and preserves collection-only songs', () => {
    const plan = planUsbWrite(
      { deviceLibrary: snapshot(), oneLibrary: snapshot(100) },
      'deviceLibrary',
      { kind: 'delete-playlist', playlistId: 10, deleteExclusiveTracks: true }
    )
    expect(plan.deviceLibrary?.deleteTrackIds).toEqual([1])
    expect(plan.oneLibrary?.deleteTrackIds).toEqual([101])
  })
  it('retains audio referenced solely by a playlist in the companion library', () => {
    const other = snapshot(100)
    other.entries.push({ playlistId: 120, trackId: 101, entryIndex: 2 })
    const plan = planUsbWrite({ deviceLibrary: snapshot(), oneLibrary: other }, 'deviceLibrary', {
      kind: 'delete-playlist',
      playlistId: 10,
      deleteExclusiveTracks: true
    })
    expect(plan.deviceLibrary?.deleteTrackIds).toEqual([])
  })
  it('global delete removes records even when another playlist references the song', () => {
    const plan = planUsbWrite(
      { deviceLibrary: snapshot(), oneLibrary: snapshot(100) },
      'deviceLibrary',
      { kind: 'delete-tracks', trackIds: [2] }
    )
    expect(plan.deviceLibrary?.deleteTrackIds).toEqual([2])
    expect(plan.oneLibrary?.deleteTrackIds).toEqual([102])
  })
  it('retains Bank-referenced audio during exclusive playlist deletion across either library', () => {
    const other = snapshot(100)
    other.protectedTrackIds = [101]
    const snapshots = { deviceLibrary: snapshot(), oneLibrary: other }
    const playlist = planUsbWrite(snapshots, 'deviceLibrary', {
      kind: 'delete-playlist',
      playlistId: 10,
      deleteExclusiveTracks: true
    })
    expect(playlist.deviceLibrary?.deleteTrackIds).toEqual([])
    expect(playlist.oneLibrary?.deleteTrackIds).toEqual([])
    const global = planUsbWrite(snapshots, 'deviceLibrary', {
      kind: 'delete-tracks',
      trackIds: [1]
    })
    expect(global.deviceLibrary?.deleteTrackIds).toEqual([1])
    expect(global.oneLibrary?.deleteTrackIds).toEqual([101])
  })
  it('global delete removes every duplicate audio reference in both libraries', () => {
    const source = snapshot()
    const companion = snapshot(100)
    source.tracks.push({ ...source.tracks[1], id: 4 })
    companion.tracks.push({ ...companion.tracks[1], id: 104 })
    const plan = planUsbWrite({ deviceLibrary: source, oneLibrary: companion }, 'deviceLibrary', {
      kind: 'delete-tracks',
      trackIds: [2]
    })
    expect(plan.deviceLibrary?.deleteTrackIds).toEqual([2, 4])
    expect(plan.oneLibrary?.deleteTrackIds).toEqual([102, 104])
  })
  it('fails closed when companion membership changed or target identity is ambiguous', () => {
    const other = snapshot(100)
    other.entries.push({ playlistId: 110, trackId: 103, entryIndex: 3 })
    expect(() =>
      planUsbWrite({ deviceLibrary: snapshot(), oneLibrary: other }, 'deviceLibrary', {
        kind: 'reorder',
        playlistId: 10,
        trackIds: [2, 1]
      })
    ).toThrow('成员不一致')
    other.playlists.push({ id: 130, parentId: 0, name: 'A', isFolder: false })
    expect(() =>
      planUsbWrite({ deviceLibrary: snapshot(), oneLibrary: other }, 'deviceLibrary', {
        kind: 'delete-playlist',
        playlistId: 10,
        deleteExclusiveTracks: false
      })
    ).toThrow('唯一对应')
  })
})
