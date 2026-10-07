import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  preparePioneerUsbWrite,
  applyPioneerUsbWrite,
  executePioneerUsbWrite,
  withPioneerUsbRead,
  withPioneerUsbExclusive
} from './usbWrite'
import { UsbPdbEditor } from './usbPdbEditor'
import { pdbEntry, pdbFixture, pdbPlaylist, pdbTrack } from './usbPdbFixtures'
import type { PioneerUsbWriteRequest } from '../../../shared/pioneerUsbWrite'

// Exercise the public token protocol on ordinary temporary files. The only
// replaced boundaries are physical USB discovery and process discovery.
const gate = vi.hoisted(() => ({
  usb: true,
  rekordbox: false,
  usbChecks: 0,
  processChecks: 0,
  identity: 'fixture-volume'
}))
vi.mock('./windowsUsbWriteProbe', () => ({
  probeWindowsUsbWriteRoot: vi.fn(async () => {
    gate.usbChecks++
    return { eligible: gate.usb, identity: gate.identity }
  }),
  isWindowsProcessRunning: vi.fn(async () => {
    gate.processChecks++
    return gate.rekordbox
  })
}))
vi.mock('./deviceDetection', () => ({
  isPioneerUsbWriteRoot: vi.fn(async () => {
    gate.usbChecks++
    return gate.usb
  })
}))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const execFile = vi.fn()
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: async () => {
      gate.processChecks++
      return { stdout: gate.rekordbox ? '"rekordbox.exe","123"' : '', stderr: '' }
    }
  })
  return { ...actual, execFile }
})

const roots: string[] = []
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-usb-api-test-'))
  roots.push(root)
  const file = path.join(root, 'PIONEER', 'rekordbox', 'export.pdb')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    pdbFixture([
      { type: 0, rows: [pdbTrack(1), pdbTrack(2)] },
      { type: 7, rows: [pdbPlaylist(10, 'Playlist')] },
      { type: 8, rows: [pdbEntry(10, 1, 1), pdbEntry(10, 2, 2)] }
    ])
  )
  const request: PioneerUsbWriteRequest = {
    rootPath: root,
    libraryType: 'deviceLibrary',
    operation: { kind: 'reorder', playlistId: 10, trackIds: [2, 1] }
  }
  return { root, file, request }
}
beforeEach(() => {
  gate.usb = true
  gate.rekordbox = false
  gate.usbChecks = 0
  gate.processChecks = 0
  gate.identity = 'fixture-volume'
})
afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe.skipIf(!['win32', 'darwin'].includes(process.platform))(
  'USB public write protocol',
  () => {
    it('holds one exclusive operation through immediate preparation and commit', async () => {
      const { root, file, request } = await fixture()
      const response = await executePioneerUsbWrite(request, 10, undefined, async () => {
        await expect(withPioneerUsbRead(root, async () => 'read')).rejects.toThrow('正在写入')
        await expect(withPioneerUsbExclusive(root, async () => 'eject')).rejects.toThrow('正在写入')
      })
      expect(response.ok).toBe(true)
      expect(gate.usbChecks).toBe(2)
      expect(gate.processChecks).toBe(2)
      expect(
        new UsbPdbEditor(await fs.readFile(file))
          .snapshot()
          .entries.sort((a, b) => a.entryIndex - b.entryIndex)
          .map((entry) => entry.trackId)
      ).toEqual([2, 1])
      expect(await fs.readdir(path.dirname(file))).toEqual(['export.pdb'])
    })

    it('still rejects a process starting during preparation and changes to its read set', async () => {
      const { file, request } = await fixture()
      const original = await fs.readFile(file)
      const running = await executePioneerUsbWrite(request, 11, undefined, async () => {
        gate.rekordbox = true
      })
      expect(running.ok).toBe(false)
      if (!running.ok) expect(running.error).toContain('rekordbox')
      expect(await fs.readFile(file)).toEqual(original)
      gate.rekordbox = false
      const external = Buffer.concat([original, Buffer.from('external-edit')])
      const changed = await executePioneerUsbWrite(request, 11, undefined, async () => {
        await fs.writeFile(file, external)
      })
      expect(changed.ok).toBe(false)
      if (!changed.ok) expect(changed.error).toContain('发生变化')
      expect(await fs.readFile(file)).toEqual(external)
    })

    it('rejects immediate deletion and discards superseded previews', async () => {
      const { file, request } = await fixture()
      const original = await fs.readFile(file)
      const deletion = await executePioneerUsbWrite(
        {
          ...request,
          operation: { kind: 'delete-tracks', trackIds: [1] }
        },
        12
      )
      expect(deletion.ok).toBe(false)
      if (!deletion.ok) expect(deletion.error).toContain('删除确认')
      expect(gate.usbChecks).toBe(0)
      expect(await fs.readFile(file)).toEqual(original)
      const preview = await preparePioneerUsbWrite(request, 12)
      if (!preview.ok) throw new Error(preview.error)
      expect((await executePioneerUsbWrite(request, 12)).ok).toBe(true)
      expect((await applyPioneerUsbWrite(preview.result.token, 12)).ok).toBe(false)
    })

    it.skipIf(process.platform !== 'win32')(
      'rejects a different mounted device even with identical library bytes',
      async () => {
        const { file, request } = await fixture()
        const original = await fs.readFile(file)
        const immediate = await executePioneerUsbWrite(request, 13, undefined, async () => {
          gate.identity = 'different-volume'
        })
        expect(immediate.ok).toBe(false)
        if (!immediate.ok) expect(immediate.error).toContain('设备发生变化')
        expect(await fs.readFile(file)).toEqual(original)
        const preview = await preparePioneerUsbWrite(request, 13)
        if (!preview.ok) throw new Error(preview.error)
        gate.identity = 'another-volume'
        const applied = await applyPioneerUsbWrite(preview.result.token, 13)
        expect(applied.ok).toBe(false)
        if (!applied.ok) expect(applied.error).toContain('设备发生变化')
        expect(await fs.readFile(file)).toEqual(original)
      }
    )

    it('prepares without modifying source files, binds the token to its owner and consumes it once', async () => {
      const { root, file, request } = await fixture()
      const original = await fs.readFile(file)
      const preview = await preparePioneerUsbWrite(request, 20)
      expect(preview.ok).toBe(true)
      if (!preview.ok) throw new Error(preview.error)
      expect(preview.result.summary.changedFileCount).toBe(1)
      expect(await fs.readFile(file)).toEqual(original)
      expect((await fs.readdir(root)).sort()).toEqual(['PIONEER'])
      expect((await applyPioneerUsbWrite(preview.result.token, 21)).ok).toBe(false)
      expect(await fs.readFile(file)).toEqual(original)
      expect((await applyPioneerUsbWrite(preview.result.token, 20)).ok).toBe(true)
      expect(
        new UsbPdbEditor(await fs.readFile(file))
          .snapshot()
          .entries.sort((left, right) => left.entryIndex - right.entryIndex)
          .map((entry) => entry.trackId)
      ).toEqual([2, 1])
      expect((await applyPioneerUsbWrite(preview.result.token, 20)).ok).toBe(false)
    })

    it('invalidates an older preview when the same owner prepares another operation', async () => {
      const { file, request } = await fixture()
      const first = await preparePioneerUsbWrite(request, 30)
      const second = await preparePioneerUsbWrite(request, 30)
      if (!first.ok || !second.ok) throw new Error('fixture preview failed')
      expect((await applyPioneerUsbWrite(first.result.token, 30)).ok).toBe(false)
      expect((await applyPioneerUsbWrite(second.result.token, 30)).ok).toBe(true)
      expect(
        new UsbPdbEditor(await fs.readFile(file))
          .snapshot()
          .entries.sort((left, right) => left.entryIndex - right.entryIndex)
          .map((entry) => entry.trackId)
      ).toEqual([2, 1])
    })

    it('rechecks physical device identity and rekordbox activity before applying', async () => {
      const { file, request } = await fixture()
      const original = await fs.readFile(file)
      const first = await preparePioneerUsbWrite(request, 40)
      if (!first.ok) throw new Error(first.error)
      gate.usb = false
      const disconnected = await applyPioneerUsbWrite(first.result.token, 40)
      expect(disconnected.ok).toBe(false)
      if (!disconnected.ok) expect(disconnected.error).toContain('USB')
      gate.usb = true
      const second = await preparePioneerUsbWrite(request, 40)
      if (!second.ok) throw new Error(second.error)
      gate.rekordbox = true
      const running = await applyPioneerUsbWrite(second.result.token, 40)
      expect(running.ok).toBe(false)
      if (!running.ok) expect(running.error).toContain('rekordbox')
      expect(await fs.readFile(file)).toEqual(original)
    })

    it('rejects an expired preview and a changed source without modifying the current source', async () => {
      const { file, request } = await fixture()
      const original = await fs.readFile(file)
      const expired = await preparePioneerUsbWrite(request, 50)
      if (!expired.ok) throw new Error(expired.error)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 11 * 60 * 1000)
      const response = await applyPioneerUsbWrite(expired.result.token, 50)
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error).toContain('过期')
      expect(await fs.readFile(file)).toEqual(original)
      vi.useRealTimers()
      const stale = await preparePioneerUsbWrite(request, 50)
      if (!stale.ok) throw new Error(stale.error)
      const external = Buffer.concat([original, Buffer.from('external-edit')])
      await fs.writeFile(file, external)
      const changed = await applyPioneerUsbWrite(stale.result.token, 50)
      expect(changed.ok).toBe(false)
      if (!changed.ok) expect(changed.error).toContain('发生变化')
      expect(await fs.readFile(file)).toEqual(external)
    })
  }
)
