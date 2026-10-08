import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { probeExternalLibraries } from './detect'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.resolve('test-source-probe', name) }
}))
vi.mock('node:fs/promises', () => ({
  default: { access: vi.fn(), readdir: vi.fn().mockRejectedValue(new Error('absent')) }
}))
afterEach(() => vi.clearAllMocks())

describe('external library source probe', () => {
  it('shares concurrent probes, prefers the music library, and refreshes after completion', async () => {
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
    ).toBe(false)
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
})
