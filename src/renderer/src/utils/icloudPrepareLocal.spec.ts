import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { icloudState } from './icloudLibrary'
import { cloudPlaybackStates, cancelCloudPlayback } from './icloudPlayback'
import { cancelIcloudLocalAction, prepareIcloudSongsForLocalAction } from './icloudPrepareLocal'
import type { ISongInfo } from 'src/types/globals'

const invoke = vi.fn()
const song = (name: string, token = 'root'): ISongInfo =>
  ({
    filePath: `icloud-song:${name}`,
    fileName: name,
    title: name,
    icloudOrigin: { relativePath: name, rootToken: token, key: `icloud-song:${name}` }
  }) as ISongInfo

beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  icloudState.value = {
    supported: true,
    visible: true,
    available: true,
    configured: true,
    folder: 'drive',
    rootToken: 'root'
  }
  cloudPlaybackStates.value = {}
  invoke.mockImplementation(async (channel: string, relative: string) => {
    if (channel === 'icloud:prepare-local')
      return { ok: true, value: { relative, filePath: `/tmp/icloud/${relative}` } }
    if (channel === 'icloud:prepare-play')
      return { ok: true, value: `frkb-preview://icloud/?ticket=${relative}` }
    return { ok: true, value: true }
  })
})

afterEach(() => {
  cancelIcloudLocalAction()
  cancelCloudPlayback()
  cloudPlaybackStates.value = {}
  icloudState.value = null
  vi.unstubAllGlobals()
})

it('localizes only the selected songs one by one and returns real local paths', async () => {
  const prepared = await prepareIcloudSongsForLocalAction([song('a.mp3'), song('b.mp3')])
  expect(prepared?.map((item) => item.filePath)).toEqual(['/tmp/icloud/a.mp3', '/tmp/icloud/b.mp3'])
  expect(
    invoke.mock.calls
      .filter(([channel]) => channel === 'icloud:prepare-local')
      .map((call) => call[1])
  ).toEqual(['a.mp3', 'b.mp3'])
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:prepare-play')).toBe(false)
  expect(cloudPlaybackStates.value['icloud-song:a.mp3']?.state).toBe('ready')
})

it('aborts the whole batch on cancel and does not return a partial success', async () => {
  const pending: Array<(result: unknown) => void> = []
  invoke.mockImplementation((channel: string) => {
    if (channel !== 'icloud:prepare-local') return { ok: true, value: true }
    return new Promise((resolve) => pending.push(resolve))
  })
  const work = prepareIcloudSongsForLocalAction([song('a.mp3'), song('b.mp3')])
  await vi.waitFor(() => expect(pending.length).toBe(1))
  expect(cancelIcloudLocalAction('icloud-song:a.mp3')).toBe(true)
  pending[0]({ ok: true, value: { relative: 'a.mp3', filePath: '/tmp/icloud/a.mp3' } })
  await expect(work).resolves.toBe(null)
  expect(invoke.mock.calls.filter(([channel]) => channel === 'icloud:prepare-local')).toHaveLength(
    1
  )
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:cancel')).toBe(true)
  expect(cloudPlaybackStates.value['icloud-song:a.mp3']).toMatchObject({
    state: 'failed',
    error: 'cancelled'
  })
})

it('surfaces a timeout without pretending the operation succeeded', async () => {
  invoke.mockResolvedValue({ ok: false, error: 'timeout' })
  await expect(prepareIcloudSongsForLocalAction([song('cloud.mp3')])).resolves.toBe(null)
  expect(cloudPlaybackStates.value['icloud-song:cloud.mp3']).toMatchObject({
    state: 'failed',
    error: 'timeout'
  })
})

it('does not cancel an unrelated playing track when no local action is pending', () => {
  expect(cancelIcloudLocalAction('icloud-song:other.mp3')).toBe(false)
  expect(invoke.mock.calls.some(([channel]) => channel === 'icloud:cancel')).toBe(false)
})
