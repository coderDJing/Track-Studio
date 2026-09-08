import { describe, expect, it } from 'vitest'
import {
  findPlayingSongIndexInList,
  isPlaybackDeleteAllAboveBlockedLibraryType,
  resolvePlaybackDeleteAllAboveTarget
} from './playbackDeleteAllAbove'

const song = (filePath: string, extra?: { setItemId?: string; mixtapeItemId?: string }) => ({
  filePath,
  ...extra
})

describe('playbackDeleteAllAbove', () => {
  it('blocks set and mixtape lists', () => {
    expect(isPlaybackDeleteAllAboveBlockedLibraryType('setList')).toBe(true)
    expect(isPlaybackDeleteAllAboveBlockedLibraryType('mixtapeList')).toBe(true)
    expect(isPlaybackDeleteAllAboveBlockedLibraryType('songList')).toBe(false)
  })

  it('prefers object identity, then item ids, then file path', () => {
    const current = song('C:/a.mp3', { setItemId: 'set-2' })
    const list = [song('C:/a.mp3', { setItemId: 'set-1' }), current, song('C:/b.mp3')]
    expect(findPlayingSongIndexInList(list, current)).toBe(1)
    expect(findPlayingSongIndexInList(list, song('C:/other.mp3', { setItemId: 'set-1' }))).toBe(0)
    expect(findPlayingSongIndexInList(list, song('C:/B.mp3'), true)).toBe(2)
    expect(findPlayingSongIndexInList(list, song('C:/B.mp3'), false)).toBe(-1)
  })

  it('returns tracks before the playing song and keeps the playing song', () => {
    const playing = song('C:/keep.mp3')
    const target = resolvePlaybackDeleteAllAboveTarget({
      listUuid: 'list-1',
      libraryType: 'songList',
      caseInsensitiveFilePath: true,
      playingSong: playing,
      listData: [song('C:/a.mp3'), song('C:/b.mp3'), playing]
    })
    expect(target?.playingIndex).toBe(2)
    expect(target?.songs.map((item) => item.filePath)).toEqual(['C:/a.mp3', 'C:/b.mp3'])
  })

  it('hides the action for the first track, missing song, or blocked libraries', () => {
    const first = song('C:/a.mp3')
    expect(
      resolvePlaybackDeleteAllAboveTarget({
        listUuid: 'list-1',
        libraryType: 'songList',
        caseInsensitiveFilePath: true,
        playingSong: first,
        listData: [first, song('C:/b.mp3')]
      })
    ).toBeNull()
    expect(
      resolvePlaybackDeleteAllAboveTarget({
        listUuid: 'list-1',
        libraryType: 'setList',
        caseInsensitiveFilePath: true,
        playingSong: song('C:/b.mp3'),
        listData: [song('C:/a.mp3'), song('C:/b.mp3')]
      })
    ).toBeNull()
    expect(
      resolvePlaybackDeleteAllAboveTarget({
        listUuid: '',
        caseInsensitiveFilePath: true,
        playingSong: song('C:/b.mp3'),
        listData: [song('C:/a.mp3'), song('C:/b.mp3')]
      })
    ).toBeNull()
  })
})
