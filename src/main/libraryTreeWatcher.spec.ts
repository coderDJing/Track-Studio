import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./store', () => ({
  default: { databaseDir: '', settingConfig: {} }
}))
vi.mock('./utils', () => ({
  ensureEnglishCoreLibraries: vi.fn(),
  getCoreFsDirName: (name: string) => name,
  getLibrary: vi.fn()
}))
vi.mock('./libraryTreeDb', () => ({ syncLibraryTreeFromDisk: vi.fn() }))
vi.mock('./services/cacheMaintenance', () => ({ pruneOrphanedSongListCaches: vi.fn() }))
vi.mock('./log', () => ({ log: { error: vi.fn() } }))

import {
  beginLibraryTreeWatcherBulkOperation,
  bindLibraryTreeContentChangeListener,
  isIgnoredWatchPath,
  notifyLibraryFsChanged,
  stopLibraryTreeWatcher
} from './libraryTreeWatcher'

describe('libraryTreeWatcher bulk content changes', () => {
  afterEach(() => {
    bindLibraryTreeContentChangeListener(null)
    stopLibraryTreeWatcher()
    vi.useRealTimers()
  })

  it('flushes one final content change only after the outer bulk operation ends', async () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    bindLibraryTreeContentChangeListener(listener)

    const releaseOuter = beginLibraryTreeWatcherBulkOperation()
    const releaseInner = beginLibraryTreeWatcherBulkOperation()
    notifyLibraryFsChanged('C:\\music\\playlist\\first.mp3')
    notifyLibraryFsChanged('C:\\music\\playlist\\second.mp3')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(listener).not.toHaveBeenCalled()

    releaseInner()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(listener).not.toHaveBeenCalled()

    releaseOuter()
    await vi.advanceTimersByTimeAsync(399)
    expect(listener).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toHaveLength(2)
  })
})

describe('isIgnoredWatchPath', () => {
  it('ignores any path that has a dot-prefixed segment', () => {
    expect(isIgnoredWatchPath('NeteaseLibrary/.store/123.flac')).toBe(true)
    expect(isIgnoredWatchPath('NeteaseLibrary/.preview-cache/a.mp3')).toBe(true)
    expect(isIgnoredWatchPath('.netease-session')).toBe(true)
    expect(isIgnoredWatchPath('FilterLibrary/playlist/.part-tmp/a.mp3')).toBe(true)
  })

  it('does not ignore ordinary library files', () => {
    expect(isIgnoredWatchPath('FilterLibrary/playlist/song.mp3')).toBe(false)
    expect(isIgnoredWatchPath('NeteaseLibrary')).toBe(false)
    expect(isIgnoredWatchPath('')).toBe(false)
  })
})
