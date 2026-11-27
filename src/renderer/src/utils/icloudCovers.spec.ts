import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { createIcloudCovers } from './icloudCovers'
import type { ISongInfo } from 'src/types/globals'
import type { IcloudPicture } from '@shared/icloudLibrary'
const song = (filePath: string) => ({ filePath }) as ISongInfo
const picture: IcloudPicture = { format: 'image/png', data: 'cGljdHVyZQ==', hash: 'same' }
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}
const create = vi.fn(() => `blob:cover-${Math.random()}`),
  revoke = vi.fn()
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(create)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke)
  vi.clearAllMocks()
})
afterEach(() => vi.restoreAllMocks())
function setup() {
  let token = 'root'
  const resident = new Set(['a', 'b', 'c'])
  const tasks: { id: string; finish: (v: IcloudPicture | null) => void }[] = []
  const read = vi.fn(
    (_p: string, _t: string, id: string) =>
      new Promise<IcloudPicture | null>((finish) => tasks.push({ id, finish }))
  )
  const cancel = vi.fn()
  const resize = vi.fn(async (data: Uint8Array, format: string) => ({ data, format }))
  const covers = createIcloudCovers({
    resolve: (p) => (resident.has(p) ? { relative: p, token } : null),
    read,
    cancel,
    resize
  })
  return {
    covers,
    read,
    cancel,
    resize,
    tasks,
    resident,
    root: (value: string) => {
      token = value
    }
  }
}
it('only requests visible resident tracks, at most two even when hover requests more', async () => {
  const x = setup()
  x.covers.setVisibleSongs(['a', 'b', 'c', 'cloud'].map(song))
  expect(x.read).toHaveBeenCalledTimes(2)
  const hover = x.covers.fetchCoverUrl('c')
  await x.covers.fetchCoverUrl('cloud')
  await x.covers.fetchCoverUrl('not-visible')
  expect(x.read).toHaveBeenCalledTimes(2)
  x.tasks[0].finish(picture)
  await flush()
  expect(x.read).toHaveBeenCalledTimes(3)
  expect(x.covers.getCoverUrl('a')).toMatch(/^blob:/)
  expect(x.resize).toHaveBeenCalledTimes(1)
  x.tasks[1].finish(null)
  x.tasks[2].finish(null)
  await expect(hover).resolves.toBeNull()
  await flush()
  x.covers.clear()
  expect(revoke).toHaveBeenCalled()
})
it('does not publish a retired request after leaving and reentering the viewport', async () => {
  const x = setup()
  x.covers.setVisibleSongs([song('a')])
  x.covers.setVisibleSongs([])
  x.covers.setVisibleSongs([song('a')])
  expect(x.cancel).toHaveBeenCalledWith(x.tasks[0].id)
  x.tasks[0].finish(picture)
  await flush()
  expect(x.covers.getCoverUrl('a')).toBeUndefined()
  x.tasks[1].finish(picture)
  await flush()
  expect(x.covers.getCoverUrl('a')).toMatch(/^blob:/)
  x.covers.clear()
})
it('discards old root/directory responses and revokes all URLs on clear', async () => {
  const x = setup()
  x.covers.setVisibleSongs([song('a')])
  x.root('new-root')
  x.tasks[0].finish(picture)
  await flush()
  expect(create).not.toHaveBeenCalled()
  x.covers.refreshVisible()
  x.covers.clear()
  x.tasks[1].finish(picture)
  await flush()
  expect(create).not.toHaveBeenCalled()
})
it('refreshes newly downloaded visible tracks and retains unchanged image URLs without blinking', async () => {
  const x = setup()
  x.resident.delete('a')
  x.covers.setVisibleSongs([song('a')])
  expect(x.read).not.toHaveBeenCalled()
  x.resident.add('a')
  x.covers.refreshVisible()
  x.tasks[0].finish(picture)
  await flush()
  const first = x.covers.getCoverUrl('a')
  x.covers.refreshVisible(true)
  expect(x.covers.getCoverUrl('a')).toBe(first)
  expect(x.read).toHaveBeenCalledTimes(2)
  x.tasks[1].finish(picture)
  await flush()
  expect(x.covers.getCoverUrl('a')).toBe(first)
  expect(create).toHaveBeenCalledTimes(1)
  expect(revoke).not.toHaveBeenCalled()
  x.covers.refreshVisible(true)
  x.tasks[2].finish({ ...picture, hash: 'changed' })
  await flush()
  expect(x.covers.getCoverUrl('a')).not.toBe(first)
  expect(revoke).toHaveBeenCalledWith(first)
  x.covers.clear()
})
it('clears cached cover when a resident song becomes unknown instead of reading it again', async () => {
  const x = setup()
  x.covers.setVisibleSongs([song('a')])
  x.tasks[0].finish(picture)
  await flush()
  x.resident.delete('a')
  x.covers.setVisibleSongs([song('a')])
  expect(x.covers.getCoverUrl('a')).toBeUndefined()
  expect(x.read).toHaveBeenCalledTimes(1)
  expect(revoke).toHaveBeenCalled()
})

it('discards a resized image if root authorization changes during image decoding', async () => {
  const x = setup()
  let finish!: (value: { data: Uint8Array; format: string }) => void
  x.resize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  x.covers.setVisibleSongs([song('a')])
  x.tasks[0].finish(picture)
  await flush()
  x.root('replacement')
  finish({ data: new Uint8Array([1]), format: 'image/png' })
  await flush()
  expect(create).not.toHaveBeenCalled()
  expect(x.covers.getCoverUrl('a')).toBeUndefined()
  x.covers.clear()
})
