import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { withPioneerUsbExclusive, withPioneerUsbRead } from './usbWrite'

const roots: string[] = []
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-usb-lock-test-'))
  roots.push(root)
  return root
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('serializes ejection with writes and prevents reads during the device operation', async () => {
  const root = await fixture()
  const release = deferred()
  const eject = withPioneerUsbExclusive(root, () => release.promise)
  await expect(withPioneerUsbExclusive(root, async () => 'write')).rejects.toThrow('正在写入')
  await expect(withPioneerUsbRead(root, async () => 'read')).rejects.toThrow('正在写入')
  release.resolve()
  await eject
  expect(await withPioneerUsbExclusive(root, async () => 'write')).toBe('write')
})

it('discards a read that spans a completed device mutation', async () => {
  const root = await fixture()
  const started = deferred()
  const release = deferred()
  const read = withPioneerUsbRead(root, async () => {
    started.resolve()
    await release.promise
    return 'mixed snapshot'
  })
  await started.promise
  await withPioneerUsbExclusive(root, async () => {})
  release.resolve()
  await expect(read).rejects.toThrow('已更新')
})

it('blocks interrupted commits but permits durable committed data awaiting backup cleanup', async () => {
  const root = await fixture()
  const folder = path.join(root, 'PIONEER', 'rekordbox', '.frkb-write-transaction')
  await fs.mkdir(folder, { recursive: true })
  const journal = path.join(folder, 'journal.json')
  await fs.writeFile(journal, JSON.stringify({ version: 1, status: 'committing', entries: [] }))
  await expect(withPioneerUsbRead(root, async () => 'read')).rejects.toThrow('未完成')
  await fs.writeFile(journal, JSON.stringify({ version: 1, status: 'committed', entries: [] }))
  expect(await withPioneerUsbRead(root, async () => 'committed read')).toBe('committed read')
})
