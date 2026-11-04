import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureRekordboxDesktopWriteAvailable } from './rekordboxDesktopWriteAvailability'

const { dialog, invoke } = vi.hoisted(() => ({ dialog: vi.fn(), invoke: vi.fn() }))
vi.mock('@renderer/components/confirmDialog', () => ({ default: dialog }))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('desktop live write warning', () => {
  it('does not show a dialog when Rekordbox is closed', async () => {
    invoke.mockResolvedValue({ writable: true, status: 'available', rekordboxPid: 0 })
    expect(await ensureRekordboxDesktopWriteAvailable('edit')).toBe(true)
    expect(dialog).not.toHaveBeenCalled()
  })

  it('requires confirmation when Rekordbox is running', async () => {
    invoke.mockResolvedValue({ writable: false, status: 'busy', rekordboxPid: 123 })
    dialog.mockResolvedValueOnce('cancel').mockResolvedValueOnce('confirm')
    expect(await ensureRekordboxDesktopWriteAvailable('edit')).toBe(false)
    expect(await ensureRekordboxDesktopWriteAvailable('edit')).toBe(true)
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'rekordboxDesktop.liveWriteTitle',
        content: ['rekordboxDesktop.liveWriteWarning', 'rekordboxDesktop.liveWriteRefresh']
      })
    )
  })

  it('continues to block unavailable or unidentified busy states', async () => {
    invoke
      .mockResolvedValueOnce({ writable: false, status: 'busy', rekordboxPid: 0 })
      .mockResolvedValueOnce({ writable: false, status: 'unavailable', rekordboxPid: 0 })
    expect(await ensureRekordboxDesktopWriteAvailable('edit')).toBe(false)
    expect(await ensureRekordboxDesktopWriteAvailable('edit')).toBe(false)
    expect(dialog).toHaveBeenCalledWith(expect.objectContaining({ confirmShow: false }))
  })
})
