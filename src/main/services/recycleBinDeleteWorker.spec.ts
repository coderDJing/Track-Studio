import { beforeEach, describe, expect, it, vi } from 'vitest'

const runPlaybackAwareBackgroundFileIoMock = vi.hoisted(() => vi.fn())

vi.mock('node:worker_threads', () => {
  type WorkerRequest = {
    id: number
    type: string
  }

  type WorkerResponse = {
    id: number
    result: unknown
  }

  class MockWorker {
    private readonly messageListeners = new Set<(response: WorkerResponse) => void>()

    on(event: string, listener: (response: WorkerResponse) => void): this {
      if (event === 'message') this.messageListeners.add(listener)
      return this
    }

    once(): this {
      return this
    }

    off(event: string, listener: (response: WorkerResponse) => void): this {
      if (event === 'message') this.messageListeners.delete(listener)
      return this
    }

    removeAllListeners(): this {
      this.messageListeners.clear()
      return this
    }

    postMessage(payload: WorkerRequest): void {
      const result =
        payload.type === 'scan'
          ? { rootExists: true, filePaths: [], directories: [] }
          : payload.type === 'delete'
            ? []
            : true
      queueMicrotask(() => {
        for (const listener of this.messageListeners) {
          listener({ id: payload.id, result })
        }
      })
    }

    terminate(): Promise<number> {
      return Promise.resolve(0)
    }
  }

  return { Worker: MockWorker }
})

vi.mock('../workerPath', () => ({
  resolveMainWorkerPath: () => 'mock-recycle-bin-worker.js'
}))

vi.mock('./playbackForegroundActivity', () => ({
  runPlaybackAwareBackgroundFileIo: runPlaybackAwareBackgroundFileIoMock
}))

import {
  deleteRecycleBinEntriesOffMainThread,
  removeRecycleBinDirectoriesOffMainThread,
  scanRecycleBinOffMainThread
} from './recycleBinDeleteWorker'

describe('recycle bin delete worker file I/O priority', () => {
  beforeEach(() => {
    runPlaybackAwareBackgroundFileIoMock.mockReset()
    runPlaybackAwareBackgroundFileIoMock.mockImplementation(
      async (_context: string, _payload: Record<string, unknown>, task: () => Promise<unknown>) =>
        task()
    )
  })

  it('允许用户发起的清空任务走前台磁盘通道', async () => {
    await scanRecycleBinOffMainThread('C:\\library\\RecycleBin', { priority: 'foreground' })
    await deleteRecycleBinEntriesOffMainThread(
      'C:\\library',
      [{ filePath: 'C:\\library\\RecycleBin\\track.mp3', listRoot: 'C:\\library\\RecycleBin' }],
      undefined,
      { priority: 'foreground' }
    )
    await removeRecycleBinDirectoriesOffMainThread(['C:\\library\\RecycleBin\\playlist'], {
      priority: 'foreground'
    })

    expect(runPlaybackAwareBackgroundFileIoMock).toHaveBeenNthCalledWith(
      1,
      'recycle-bin:scan',
      { rootPath: 'C:\\library\\RecycleBin' },
      expect.any(Function),
      { priority: 'foreground' }
    )
    expect(runPlaybackAwareBackgroundFileIoMock).toHaveBeenNthCalledWith(
      2,
      'recycle-bin:delete-batch',
      { count: 1 },
      expect.any(Function),
      { priority: 'foreground' }
    )
    expect(runPlaybackAwareBackgroundFileIoMock).toHaveBeenNthCalledWith(
      3,
      'recycle-bin:remove-directories',
      { count: 1 },
      expect.any(Function),
      { priority: 'foreground' }
    )
  })
})
