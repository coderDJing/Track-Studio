import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rekordboxRuntimeEvents } from '../rekordboxRuntimeDownload'

const { runHelper, hasPresence } = vi.hoisted(() => ({
  runHelper: vi.fn(),
  hasPresence: vi.fn()
}))
vi.mock('./helper', () => ({ runRekordboxDesktopHelper: runHelper }))
vi.mock('./presence', () => ({ hasRekordboxDesktopPresence: hasPresence }))
vi.mock('../rekordboxRuntimeDownload', async () => {
  const { EventEmitter } = await import('node:events')
  return { rekordboxRuntimeEvents: new EventEmitter() }
})

const available = { available: true, dbPath: 'D:/PIONEER/Master/master.db' }
const unavailable = {
  available: false,
  errorCode: 'REKORDBOX_DB_BUSY',
  errorMessage: 'database is locked'
}
const missingRuntime = {
  available: false,
  errorCode: 'PYTHON_RUNTIME_MISSING',
  errorMessage: '未找到 Rekordbox Desktop Runtime 的 Python 运行时。'
}

describe('Rekordbox library detection', () => {
  beforeEach(() => {
    vi.resetModules()
    rekordboxRuntimeEvents.removeAllListeners()
    runHelper.mockReset()
    hasPresence.mockReset()
    // 默认视为本机已装 Rekordbox，保持既有 fixture 的旧语义。
    hasPresence.mockResolvedValue(true)
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

  it('reports NOT_FOUND when the runtime is missing and no local Rekordbox exists', async () => {
    hasPresence.mockResolvedValue(false)
    runHelper.mockResolvedValue(missingRuntime)
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    const probe = await probeRekordboxDesktopLibrary()

    expect(probe.available).toBe(false)
    expect(probe.errorCode).toBe('REKORDBOX_NOT_FOUND')
    expect(probe.supported).toBe(true)
    expect(hasPresence).toHaveBeenCalledTimes(1)
  })

  it('keeps the missing-runtime error for the download entry when Rekordbox exists', async () => {
    hasPresence.mockResolvedValue(true)
    runHelper.mockResolvedValue(missingRuntime)
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    const probe = await probeRekordboxDesktopLibrary()

    expect(probe.errorCode).toBe('PYTHON_RUNTIME_MISSING')
    expect(hasPresence).toHaveBeenCalledTimes(1)
  })

  it('gates a PYREKORDBOX_UNAVAILABLE payload the same way', async () => {
    hasPresence.mockResolvedValue(false)
    runHelper.mockResolvedValue({
      available: false,
      errorCode: 'PYREKORDBOX_UNAVAILABLE',
      errorMessage: 'pyrekordbox import failed'
    })
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    const probe = await probeRekordboxDesktopLibrary()
    expect(probe.errorCode).toBe('REKORDBOX_NOT_FOUND')
  })

  it('gates a thrown missing-runtime error without local evidence', async () => {
    hasPresence.mockResolvedValue(false)
    runHelper.mockRejectedValue(
      Object.assign(new Error('no runtime'), { code: 'PYTHON_RUNTIME_MISSING' })
    )
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    const probe = await probeRekordboxDesktopLibrary()
    expect(probe.errorCode).toBe('REKORDBOX_NOT_FOUND')
    expect(hasPresence).toHaveBeenCalledTimes(1)
  })

  it('treats a presence-check failure conservatively and does not prompt download', async () => {
    hasPresence.mockRejectedValue(new Error('presence scan failed'))
    runHelper.mockResolvedValue(missingRuntime)
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    const probe = await probeRekordboxDesktopLibrary()
    expect(probe.errorCode).toBe('REKORDBOX_NOT_FOUND')
  })

  it('does not consult presence for unsupported platforms', async () => {
    runHelper.mockRejectedValue(
      Object.assign(new Error('unsupported platform'), { code: 'UNSUPPORTED_PLATFORM' })
    )
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    const probe = await probeRekordboxDesktopLibrary()
    expect(probe.supported).toBe(false)
    expect(probe.errorCode).toBe('UNSUPPORTED_PLATFORM')
    expect(hasPresence).not.toHaveBeenCalled()
  })

  it('does not consult presence for unrelated database errors', async () => {
    runHelper.mockResolvedValue(unavailable)
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    const probe = await probeRekordboxDesktopLibrary()
    expect(probe.errorCode).toBe('REKORDBOX_DB_BUSY')
    expect(hasPresence).not.toHaveBeenCalled()
  })

  it('does not consult presence for a successful probe', async () => {
    runHelper.mockResolvedValue(available)
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    expect((await probeRekordboxDesktopLibrary()).available).toBe(true)
    expect(hasPresence).not.toHaveBeenCalled()
  })

  it('checks presence only once for concurrent probes', async () => {
    hasPresence.mockResolvedValue(false)
    runHelper.mockResolvedValue(missingRuntime)
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    const [first, second] = await Promise.all([
      probeRekordboxDesktopLibrary(),
      probeRekordboxDesktopLibrary()
    ])

    expect(first.errorCode).toBe('REKORDBOX_NOT_FOUND')
    expect(second.errorCode).toBe('REKORDBOX_NOT_FOUND')
    expect(hasPresence).toHaveBeenCalledTimes(1)
    expect(runHelper).toHaveBeenCalledTimes(1)
  })

  it('does not cache NOT_FOUND and re-evaluates presence immediately', async () => {
    hasPresence.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    runHelper.mockResolvedValue(missingRuntime)
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    expect((await probeRekordboxDesktopLibrary()).errorCode).toBe('REKORDBOX_NOT_FOUND')
    // 用户随后安装了 Rekordbox：下一次探测必须立刻给出组件错误（下载入口）。
    expect((await probeRekordboxDesktopLibrary()).errorCode).toBe('PYTHON_RUNTIME_MISSING')
    expect(hasPresence).toHaveBeenCalledTimes(2)
  })

  it('recovers immediately once the helper becomes available after NOT_FOUND', async () => {
    hasPresence.mockResolvedValue(false)
    runHelper.mockResolvedValueOnce(missingRuntime).mockResolvedValueOnce(available)
    const { probeRekordboxDesktopLibrary } = await import('./detect')

    expect((await probeRekordboxDesktopLibrary()).errorCode).toBe('REKORDBOX_NOT_FOUND')
    expect((await probeRekordboxDesktopLibrary()).available).toBe(true)
    expect(runHelper).toHaveBeenCalledTimes(2)
  })
})
