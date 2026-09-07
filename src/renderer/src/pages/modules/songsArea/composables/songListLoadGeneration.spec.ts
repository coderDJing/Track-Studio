import { describe, expect, it } from 'vitest'
import {
  createSongListLoadGenerationGuard,
  isSongListViewPending,
  resolveDisplayedSongList,
  shouldHoldSongListLoading
} from './songListLoadGeneration'

describe('song list load generation guard', () => {
  it('rejects an in-flight load after the list membership changes', () => {
    let currentSongListUUID = 'playlist-a'
    const guard = createSongListLoadGenerationGuard(() => currentSongListUUID)
    const staleTicket = guard.begin(currentSongListUUID)

    guard.invalidate()

    expect(guard.isCurrent(staleTicket)).toBe(false)
  })

  it('only accepts the latest load for the same playlist', () => {
    const currentSongListUUID = 'playlist-a'
    const guard = createSongListLoadGenerationGuard(() => currentSongListUUID)
    const firstTicket = guard.begin(currentSongListUUID)
    const secondTicket = guard.begin(currentSongListUUID)

    expect(guard.isCurrent(firstTicket)).toBe(false)
    expect(guard.isCurrent(secondTicket)).toBe(true)
  })

  it('rejects a response after the active playlist changes', () => {
    let currentSongListUUID = 'playlist-a'
    const guard = createSongListLoadGenerationGuard(() => currentSongListUUID)
    const ticket = guard.begin(currentSongListUUID)

    currentSongListUUID = 'playlist-b'

    expect(guard.isCurrent(ticket)).toBe(false)
  })
})

describe('song list view pending', () => {
  it('treats a newly selected playlist as pending before its data is applied', () => {
    expect(isSongListViewPending('playlist-b', 'playlist-a')).toBe(true)
    expect(isSongListViewPending('playlist-b', '')).toBe(true)
  })

  it('is not pending after the current playlist has been applied', () => {
    expect(isSongListViewPending('playlist-a', 'playlist-a')).toBe(false)
  })

  it('is not pending when no playlist is selected', () => {
    expect(isSongListViewPending('', 'playlist-a')).toBe(false)
    expect(isSongListViewPending('', '')).toBe(false)
  })
})

describe('should hold song list loading', () => {
  it('does not flash loading while the new playlist is still pending', () => {
    expect(
      shouldHoldSongListLoading({
        songListUUID: 'playlist-b',
        appliedSongListUUID: 'playlist-a',
        visibleCount: 12,
        isRequesting: true
      })
    ).toBe(false)
  })

  it('does not flash loading on first open before the delayed flag', () => {
    expect(
      shouldHoldSongListLoading({
        songListUUID: 'playlist-a',
        appliedSongListUUID: '',
        visibleCount: 0,
        isRequesting: true
      })
    ).toBe(false)
  })

  it('shows loading after the delayed flag is set', () => {
    expect(
      shouldHoldSongListLoading({
        songListUUID: 'playlist-b',
        appliedSongListUUID: 'playlist-a',
        visibleCount: 12,
        isRequesting: true,
        loadingShow: true
      })
    ).toBe(true)
  })

  it('keeps loading when bouncing back after the visible list was wiped', () => {
    expect(
      shouldHoldSongListLoading({
        songListUUID: 'playlist-a',
        appliedSongListUUID: 'playlist-a',
        visibleCount: 0,
        isRequesting: true
      })
    ).toBe(true)
  })

  it('shows the existing list immediately when bouncing back with data still in memory', () => {
    expect(
      shouldHoldSongListLoading({
        songListUUID: 'playlist-a',
        appliedSongListUUID: 'playlist-a',
        visibleCount: 12,
        isRequesting: true
      })
    ).toBe(false)
  })

  it('allows a truly empty playlist to render after load settles', () => {
    expect(
      shouldHoldSongListLoading({
        songListUUID: 'playlist-a',
        appliedSongListUUID: 'playlist-a',
        visibleCount: 0,
        isRequesting: false
      })
    ).toBe(false)
  })
})

describe('resolve displayed song list', () => {
  const previousSongs = [{ id: 'a' }]
  const nextSongs = [{ id: 'b' }]

  it('keeps the leave snapshot only while the new playlist is still pending', () => {
    expect(resolveDisplayedSongList(previousSongs, nextSongs, 'playlist-b', 'playlist-a')).toEqual(
      previousSongs
    )
  })

  it('drops the leave snapshot once the current playlist data has been applied', () => {
    expect(resolveDisplayedSongList(previousSongs, nextSongs, 'playlist-b', 'playlist-b')).toEqual(
      nextSongs
    )
  })

  it('uses the current list when there is no leave snapshot', () => {
    expect(resolveDisplayedSongList(null, nextSongs, 'playlist-b', 'playlist-a')).toEqual(nextSongs)
  })
})
