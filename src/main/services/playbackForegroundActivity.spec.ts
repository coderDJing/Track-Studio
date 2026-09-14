import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn() }
}))

import {
  getBackgroundFileIoDiagnosticSnapshot,
  runPlaybackAwareBackgroundFileIo
} from './playbackForegroundActivity'

describe('runPlaybackAwareBackgroundFileIo', () => {
  it('前台文件操作不会排在标准后台槽位之后', async () => {
    let releaseStandard: (() => void) | undefined
    let markStandardStarted: (() => void) | undefined
    const standardStarted = new Promise<void>((resolve) => {
      markStandardStarted = resolve
    })
    const holdStandard = new Promise<void>((resolve) => {
      releaseStandard = resolve
    })

    const standardTask = runPlaybackAwareBackgroundFileIo(
      'cover-cache:test',
      {},
      async () => {
        markStandardStarted?.()
        await holdStandard
      },
      { priority: 'background' }
    )
    await standardStarted

    await expect(
      runPlaybackAwareBackgroundFileIo('recycle-bin:test', {}, async () => 'moved', {
        priority: 'foreground'
      })
    ).resolves.toBe('moved')
    expect(getBackgroundFileIoDiagnosticSnapshot().inFlightByLane.standard).toBe(1)

    releaseStandard?.()
    await standardTask
    await new Promise<void>((resolve) => setImmediate(resolve))
  })
})
