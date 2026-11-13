import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  baseModel: vi.fn(),
  rekordbox: vi.fn(),
  send: vi.fn(),
  error: vi.fn(),
  destroyed: false
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('../services/demucsBaseModelDownload', () => ({ ensureDemucsBaseModel: mocks.baseModel }))
vi.mock('../services/rekordboxRuntimeDownload', () => ({
  ensureRekordboxDesktopRuntime: mocks.rekordbox
}))
vi.mock('../log', () => ({ log: { error: mocks.error } }))
vi.mock('../window/mainWindow', () => ({
  default: {
    instance: {
      isDestroyed: () => mocks.destroyed,
      webContents: { isDestroyed: () => mocks.destroyed, send: mocks.send }
    }
  }
}))
vi.mock('../services/optionalComponentEvents', () => ({
  optionalComponentEvents: new EventEmitter(),
  getOptionalComponentStates: () => []
}))

import { registerOptionalComponentHandlers } from './optionalComponentHandlers'
import { optionalComponentEvents } from '../services/optionalComponentEvents'

describe('optional component IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.destroyed = false
    optionalComponentEvents.removeAllListeners()
    registerOptionalComponentHandlers()
  })

  it('startup state reads never download components', async () => {
    expect(await mocks.handlers.get('optional-component:states')?.()).toEqual([])
    expect(mocks.baseModel).not.toHaveBeenCalled()
    expect(mocks.rekordbox).not.toHaveBeenCalled()
  })

  it('routes only supported explicit component requests', async () => {
    const download = mocks.handlers.get('optional-component:download')!
    expect(await download(null, 'unknown')).toEqual({
      ok: false,
      error: 'Unknown optional component'
    })
    expect(mocks.baseModel).not.toHaveBeenCalled()
    expect(mocks.rekordbox).not.toHaveBeenCalled()
    for (const id of [
      'stem-model-htdemucs',
      'stem-model-mdx_extra_q',
      'rekordbox-desktop-runtime'
    ]) {
      expect(await download(null, id)).toEqual({ ok: true })
    }
    expect(mocks.baseModel.mock.calls).toEqual([['htdemucs'], ['mdx_extra_q']])
    expect(mocks.rekordbox).toHaveBeenCalledTimes(1)
  })

  it('returns installation errors and allows retry', async () => {
    mocks.rekordbox.mockRejectedValueOnce(new Error('download interrupted'))
    const download = mocks.handlers.get('optional-component:download')!
    expect(await download(null, 'rekordbox-desktop-runtime')).toEqual({
      ok: false,
      error: 'download interrupted'
    })
    expect(await download(null, 'rekordbox-desktop-runtime')).toEqual({ ok: true })
  })

  it('delivers state to a live window and skips a destroyed window', () => {
    const state = { id: 'rekordbox-desktop-runtime', status: 'downloading' }
    optionalComponentEvents.emit('state', state)
    expect(mocks.send).toHaveBeenCalledWith('optional-component:state', state)
    mocks.destroyed = true
    optionalComponentEvents.emit('state', state)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
})
