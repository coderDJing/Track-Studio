import { describe, expect, it } from 'vitest'
import { createPlaylistOptimisticRemovalGuard } from './playlistOptimisticRemovalGuard'

const normalizePath = (value: string | undefined | null) =>
  String(value || '')
    .replace(/\\/g, '/')
    .toLocaleLowerCase()

describe('playlist optimistic removal guard', () => {
  it('filters a stale refresh that tries to re-add an optimistically removed song', () => {
    const guard = createPlaylistOptimisticRemovalGuard(normalizePath)
    guard.block('list-a', ['D:\\Music\\deleted.mp3'])

    const filtered = guard.filterRefreshItems('list-a', [
      { filePath: 'D:/Music/kept.mp3' },
      { filePath: 'd:/music/deleted.mp3' }
    ])

    expect(filtered).toEqual([{ filePath: 'D:/Music/kept.mp3' }])
    expect(guard.isBlocked('list-a', 'D:/Music/deleted.mp3')).toBe(true)
  })

  it('releases the barrier when an authoritative refresh confirms the path is absent', () => {
    const guard = createPlaylistOptimisticRemovalGuard(normalizePath)
    guard.block('list-a', ['D:/Music/deleted.mp3'])

    expect(guard.filterRefreshItems('list-a', [{ filePath: 'D:/Music/kept.mp3' }])).toEqual([
      { filePath: 'D:/Music/kept.mp3' }
    ])
    expect(guard.isBlocked('list-a', 'D:/Music/deleted.mp3')).toBe(false)
  })

  it('releases failed deletion paths restored by the optimistic operation', () => {
    const guard = createPlaylistOptimisticRemovalGuard(normalizePath)
    guard.block('list-a', ['D:/Music/deleted.mp3'])
    guard.release('list-a', ['d:\\music\\deleted.mp3'])

    expect(guard.filterRefreshItems('list-a', [{ filePath: 'D:/Music/deleted.mp3' }])).toEqual([
      { filePath: 'D:/Music/deleted.mp3' }
    ])
  })

  it('keeps barriers isolated by playlist', () => {
    const guard = createPlaylistOptimisticRemovalGuard(normalizePath)
    guard.block('list-a', ['D:/Music/deleted.mp3'])

    expect(guard.filterRefreshItems('list-b', [{ filePath: 'D:/Music/deleted.mp3' }])).toEqual([
      { filePath: 'D:/Music/deleted.mp3' }
    ])
  })
})
