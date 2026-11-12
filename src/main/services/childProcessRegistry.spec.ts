import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  logError: vi.fn()
}))

vi.mock('node:child_process', () => ({
  default: { spawnSync: mocks.spawnSync },
  spawnSync: mocks.spawnSync
}))

vi.mock('../log', () => ({
  log: { error: mocks.logError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))

import { terminateOwnedPidExact } from './childProcessRegistry'

describe('terminateOwnedPidExact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores invalid pids instead of touching an arbitrary process', () => {
    expect(terminateOwnedPidExact(0)).toBe(false)
    expect(terminateOwnedPidExact(-1)).toBe(false)
    expect(terminateOwnedPidExact(Number.NaN)).toBe(false)
    expect(terminateOwnedPidExact(1.5)).toBe(false)
    expect(mocks.spawnSync).not.toHaveBeenCalled()
    expect(vi.mocked(process.kill)).not.toHaveBeenCalled()
  })

  it('terminates exactly the recorded pid, never a name pattern', () => {
    if (process.platform === 'win32') {
      mocks.spawnSync.mockReturnValue({ status: 0 })
      expect(terminateOwnedPidExact(4242, 'dynamic-grid-sidecar')).toBe(true)
      expect(mocks.spawnSync).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '4242', '/T', '/F'],
        expect.objectContaining({ windowsHide: true })
      )
      return
    }
    expect(terminateOwnedPidExact(4242, 'dynamic-grid-sidecar')).toBe(true)
    expect(vi.mocked(process.kill)).toHaveBeenCalledWith(4242, 'SIGTERM')
  })

  it('reports failure without throwing when the pid is already gone', () => {
    if (process.platform === 'win32') {
      mocks.spawnSync.mockReturnValue({ status: 1 })
      expect(terminateOwnedPidExact(4242)).toBe(false)
      return
    }
    vi.mocked(process.kill).mockImplementation(() => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    expect(terminateOwnedPidExact(4242)).toBe(false)
  })
})
