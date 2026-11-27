import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { copyIcloudSongs, cancelIcloudTransfer, icloudTransfer } from './icloudLibrary'
const invoke = vi.fn()
beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal('window', { electron: { ipcRenderer: { on: vi.fn(), invoke } } })
  Object.assign(icloudTransfer, { busy: false, results: [], error: '' })
  invoke.mockImplementation(
    async (
      channel: string,
      input: { paths: string[]; rootToken: string; cloudDirectory: string } | string
    ) => ({
      ok: true,
      value:
        channel === 'icloud:authorize-destination'
          ? { token: 'next-token', rootToken: 'root', directory: input }
          : channel === 'icloud:copy'
            ? (input as { paths: string[] }).paths.map((source) => ({ source, status: 'copied' }))
            : true
    })
  )
})
afterEach(() => vi.unstubAllGlobals())
it('copies every selected track in bounded authorized batches with aggregate progress, no silent 500 truncation', async () => {
  const paths = Array.from({ length: 1201 }, (_, i) => `${i}.wav`),
    results = await copyIcloudSongs('to-cloud', 'local', paths, 'root', 'Album', 'first-token')
  const batches = invoke.mock.calls.filter(([channel]) => channel === 'icloud:copy')
  expect(batches.map(([, input]) => input.paths.length)).toEqual([500, 500, 201])
  expect(results).toHaveLength(1201)
  expect(icloudTransfer.progress).toMatchObject({ done: 1201, total: 1201 })
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'icloud:authorize-destination')
  ).toHaveLength(2)
  expect(batches[1][1].destinationToken).toBe('next-token')
})
it('cancel stops later batches and retains already completed results', async () => {
  const normal = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const result = await normal(channel, ...args)
    if (channel === 'icloud:copy') cancelIcloudTransfer()
    return result
  })
  const result = await copyIcloudSongs(
    'to-local',
    'local',
    Array.from({ length: 1100 }, (_, i) => `${i}.wav`),
    'root'
  )
  expect(result).toHaveLength(500)
  expect(invoke.mock.calls.filter(([channel]) => channel === 'icloud:copy')).toHaveLength(1)
  expect(icloudTransfer.error).toBe('cancelled')
  expect(icloudTransfer.busy).toBe(false)
})
