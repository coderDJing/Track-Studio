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
