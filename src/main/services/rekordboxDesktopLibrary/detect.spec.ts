import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runHelper } = vi.hoisted(() => ({ runHelper: vi.fn() }))
vi.mock('./helper', () => ({ runRekordboxDesktopHelper: runHelper }))

const available = { available: true, dbPath: 'D:/PIONEER/Master/master.db' }
const unavailable = {
  available: false,
  errorCode: 'REKORDBOX_DB_BUSY',
  errorMessage: 'database is locked'
}

describe('Rekordbox library detection', () => {
  beforeEach(() => {
    vi.resetModules()
    runHelper.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  it('rechecks immediately after an unavailable response instead of caching the failure', async () => {
    runHelper.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(available)
    const { probeRekordboxDesktopLibrary } = await import('./detect')
    expect((await probeRekordboxDesktopLibrary()).available).toBe(false)
    expect((await probeRekordboxDesktopLibrary()).available).toBe(true)
    expect(runHelper).toHaveBeenCalledTimes(2)
  })

  it('rechecks after a helper exception and retains its actual cause', async () => {
    runHelper.mockRejectedValueOnce(new Error('helper terminated')).mockResolvedValueOnce(available)
    const { requireRekordboxDesktopLibraryProbe } = await import('./detect')
    await expect(requireRekordboxDesktopLibraryProbe()).rejects.toThrow('helper terminated')
    expect((await requireRekordboxDesktopLibraryProbe()).dbPath).toBe(available.dbPath)
  })

  it('shares concurrent checks and only caches successful responses for one minute', async () => {
    runHelper.mockResolvedValue(available)
    const { probeRekordboxDesktopLibrary } = await import('./detect')
    await Promise.all([probeRekordboxDesktopLibrary(), probeRekordboxDesktopLibrary()])
    await probeRekordboxDesktopLibrary()
    expect(runHelper).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_001)
    await probeRekordboxDesktopLibrary()
    expect(runHelper).toHaveBeenCalledTimes(2)
  })

  it('checks the source path without opening the database even after a DB read failed', async () => {
    runHelper.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(available)
    const { requireRekordboxDesktopLibraryProbe, requireRekordboxDesktopSourceDbPath } =
      await import('./detect')
    await expect(requireRekordboxDesktopLibraryProbe()).rejects.toThrow(
      '[REKORDBOX_DB_BUSY] database is locked'
    )
    expect(await requireRekordboxDesktopSourceDbPath()).toBe(available.dbPath)
    expect(await requireRekordboxDesktopSourceDbPath()).toBe(available.dbPath)
    expect(runHelper.mock.calls).toEqual([
      ['probe', { openDatabase: true }],
      ['probe', { openDatabase: false }]
    ])
  })

  it('keeps source-path failures specific and allows the next check to recover', async () => {
    runHelper
      .mockResolvedValueOnce({
        available: false,
        errorCode: 'REKORDBOX_NOT_FOUND',
        errorMessage: 'Configured master.db does not exist'
      })
      .mockResolvedValueOnce(available)
    const { requireRekordboxDesktopSourceDbPath } = await import('./detect')
    await expect(requireRekordboxDesktopSourceDbPath()).rejects.toThrow(
      '[REKORDBOX_NOT_FOUND] Configured master.db does not exist'
    )
    expect(await requireRekordboxDesktopSourceDbPath()).toBe(available.dbPath)
  })
})
