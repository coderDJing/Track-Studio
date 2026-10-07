import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAndApplyPioneerUsbWrite } from './pioneerUsbWrite'
import type { PioneerUsbWriteRequest, PioneerUsbWriteSummary } from '@shared/pioneerUsbWrite'

const { invoke, confirm } = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn() }))
vi.mock('@renderer/components/confirmDialog', () => ({ default: confirm }))
vi.mock('@renderer/utils/translate', () => ({
  t: (key: string, values?: Record<string, unknown>) => `${key}:${JSON.stringify(values || {})}`
}))

const request: PioneerUsbWriteRequest = {
  rootPath: 'E:\\',
  libraryType: 'oneLibrary',
  operation: { kind: 'delete-tracks', trackIds: [7] }
}
const summary: PioneerUsbWriteSummary = {
  libraries: ['deviceLibrary', 'oneLibrary'],
  changedFileCount: 3,
  deletedTrackCount: 1,
  deletedFiles: ['Contents/7.mp3'],
  preservedSharedFileCount: 1
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  invoke.mockResolvedValueOnce({ ok: true, result: { token: 'prepared-token', summary } })
})
afterEach(() => vi.unstubAllGlobals())

describe('USB write preview confirmation', () => {
  it('shows the target drive and deletion count, then cancels without applying', async () => {
    confirm.mockResolvedValue('cancel')
    expect(await prepareAndApplyPioneerUsbWrite(request, 'Delete song')).toBeNull()
    expect(invoke).toHaveBeenCalledExactlyOnceWith('pioneer-device-library:prepare-write', request)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.arrayContaining([
          'Delete song',
          'pioneerUsb.previewDevice:{"path":"E:\\\\"}',
          'pioneerUsb.previewTracks:{"count":1}',
          'pioneerUsb.deleteWarning:{}'
        ])
      })
    )
  })

  it('saves an ordinary reorder silently through the queued write handler', async () => {
    invoke.mockReset().mockResolvedValue({ ok: true, result: summary })
    const ordinary: PioneerUsbWriteRequest = {
      ...request,
      operation: { kind: 'reorder', playlistId: 11, trackIds: [7, 8] }
    }
    expect(await prepareAndApplyPioneerUsbWrite(ordinary, 'Reorder')).toEqual(summary)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('pioneer-device-library:write', ordinary)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('applies only the approved preview token and returns the committed summary', async () => {
    confirm.mockResolvedValue('confirm')
    invoke.mockResolvedValueOnce({ ok: true, result: summary })
    expect(await prepareAndApplyPioneerUsbWrite(request, 'Delete song')).toEqual(summary)
    expect(invoke.mock.calls).toEqual([
      ['pioneer-device-library:prepare-write', request],
      ['pioneer-device-library:apply-write', 'prepared-token']
    ])
  })

  it('reports stale-preview rejection without retrying a write', async () => {
    confirm.mockResolvedValue('confirm')
    invoke.mockResolvedValueOnce({ ok: false, error: 'USB changed since preview' })
    expect(await prepareAndApplyPioneerUsbWrite(request, 'Delete song')).toBeNull()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: ['USB changed since preview'], confirmShow: false })
    )
  })
})
