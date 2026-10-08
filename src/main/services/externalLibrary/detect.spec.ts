import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { probeExternalLibraries } from './detect'
import { readTraktorConfiguredRoots } from './traktorConfig'
import { isSeratoV4Library } from './seratoV4'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.resolve('test-source-probe', name) }
}))
vi.mock('node:fs/promises', () => ({
  default: { access: vi.fn(), readdir: vi.fn().mockRejectedValue(new Error('absent')) }
}))
vi.mock('./traktorConfig', () => ({ readTraktorConfiguredRoots: vi.fn().mockResolvedValue([]) }))
vi.mock('./seratoV4', () => ({
  getSeratoV4LibraryDir: () => path.resolve('test-source-probe/serato-v4/Library'),
  isSeratoV4Library: vi.fn().mockResolvedValue(false)
}))
afterEach(() => vi.clearAllMocks())

describe('external library source probe', () => {
  it('shares concurrent probes and refreshes after completion', async () => {
    const musicRoot = path.resolve('test-source-probe/music/_Serato_')
    vi.mocked(fs.access).mockImplementation(async (target) => {
      if (String(target) !== path.join(musicRoot, 'database V2')) throw new Error('absent')
    })
    const first = probeExternalLibraries()
    const second = probeExternalLibraries()
    expect(first).toBe(second)
    expect((await first)[0].sourcePath).toBe(musicRoot)
    expect(
      vi.mocked(fs.access).mock.calls.some(([target]) => /^[A-Z]:\\_Serato_/i.test(String(target)))
    ).toBe(process.platform === 'win32')
    vi.mocked(fs.access).mockRejectedValue(new Error('removed'))
    expect((await probeExternalLibraries())[0].available).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')(
    'finds a drive-root Serato library without launching a shell',
    async () => {
      vi.mocked(fs.access).mockImplementation(async (target) => {
        if (String(target) !== 'G:\\_Serato_\\Subcrates') throw new Error('absent')
      })
      expect((await probeExternalLibraries())[0].sourcePath).toBe('G:\\_Serato_')
    }
  )

  it('uses Traktor RootDirectory from the app configuration', async () => {
    const root = path.resolve('test-source-probe/custom-traktor')
    vi.mocked(readTraktorConfiguredRoots).mockResolvedValue([root])
    vi.mocked(fs.access).mockImplementation(async (target) => {
      if (String(target) !== path.join(root, 'collection.nml')) throw new Error('absent')
    })
    const traktor = (await probeExternalLibraries()).find((probe) => probe.kind === 'traktor')
    expect(traktor?.sourcePath).toBe(path.join(root, 'collection.nml'))
  })

  it('keeps the writable crate source when Serato 4 also has a database', async () => {
    const musicRoot = path.resolve('test-source-probe/music/_Serato_')
    vi.mocked(fs.access).mockImplementation(async (target) => {
      if (String(target) !== path.join(musicRoot, 'Subcrates')) throw new Error('absent')
    })
    vi.mocked(isSeratoV4Library).mockResolvedValue(true)
    const serato = (await probeExternalLibraries()).find((probe) => probe.kind === 'serato')
    expect(serato?.sourcePath).toBe(musicRoot)
    expect(isSeratoV4Library).not.toHaveBeenCalled()
  })

  it('uses the Serato 4 database only when no crate source exists', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('absent'))
    vi.mocked(isSeratoV4Library).mockResolvedValue(true)
    const serato = (await probeExternalLibraries()).find((probe) => probe.kind === 'serato')
    expect(serato?.sourcePath).toBe(path.resolve('test-source-probe/serato-v4/Library'))
  })
})
