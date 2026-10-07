import { beforeEach, describe, expect, it, vi } from 'vitest'
import { probeRekordboxDesktopLibraryWriteAvailability } from './detect'

const { helper } = vi.hoisted(() => ({ helper: vi.fn() }))
vi.mock('./helper', () => ({ runRekordboxDesktopHelper: helper }))
beforeEach(() => vi.resetAllMocks())

describe('fresh desktop write availability', () => {
  it('queries current config and process without opening the DB for collection counts', async () => {
    helper.mockResolvedValue({ writable: true, status: 'available', checkedAt: 123 })
    expect(await probeRekordboxDesktopLibraryWriteAvailability()).toMatchObject({
      writable: true,
      status: 'available',
      checkedAt: 123
    })
    expect(helper).toHaveBeenCalledExactlyOnceWith('probe-write', {})
  })

  it('does not reuse an available status when rekordbox starts or the DB disappears', async () => {
    helper
      .mockResolvedValueOnce({ writable: true, status: 'available' })
      .mockResolvedValueOnce({ writable: false, status: 'busy', rekordboxPid: 9 })
      .mockResolvedValueOnce({ writable: false, status: 'unavailable' })
    expect((await probeRekordboxDesktopLibraryWriteAvailability()).writable).toBe(true)
    expect(await probeRekordboxDesktopLibraryWriteAvailability()).toMatchObject({
      writable: false,
      status: 'busy',
      rekordboxPid: 9
    })
    expect((await probeRekordboxDesktopLibraryWriteAvailability()).status).toBe('unavailable')
    expect(helper).toHaveBeenCalledTimes(3)
  })

  it('fails closed on helper errors and malformed responses', async () => {
    helper.mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce(undefined)
    expect(await probeRekordboxDesktopLibraryWriteAvailability()).toMatchObject({
      writable: false,
      status: 'unknown',
      errorMessage: 'Disconnected'
    })
    expect((await probeRekordboxDesktopLibraryWriteAvailability()).writable).toBe(false)
  })
})
