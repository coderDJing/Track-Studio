import { describe, expect, it, vi } from 'vitest'
import type { IcloudEntry, IcloudMetadataItem } from '@shared/icloudLibrary'
import { createIcloudMetadataLoader } from './icloudMetadata'
const entry = (name: string, residency: IcloudEntry['residency'] = 'local'): IcloudEntry => ({
  name,
  relativePath: name,
  residency,
  directory: false
})
describe('incremental iCloud metadata loading', () => {
  it('does not request cloud, unknown or directory files, and bounds each resident batch to 16', async () => {
    const read = vi.fn(async (paths: string[]) =>
        paths.map((relativePath) => ({ relativePath, metadata: { artist: 'Real artist' } }))
      ),
      apply = vi.fn()
    const loader = createIcloudMetadataLoader({ read, apply, cancel: vi.fn() })
    await loader.load(
      [
        entry('cloud.wav', 'cloud'),
        entry('unknown.wav', 'unknown'),
        { ...entry('folder'), directory: true }
      ],
      'root'
    )
    expect(read).not.toHaveBeenCalled()
    await loader.load(
      Array.from({ length: 33 }, (_, i) => entry(`${i}.wav`)),
      'root'
    )
    expect(read.mock.calls.map(([paths]) => paths.length)).toEqual([16, 16, 1])
    expect(apply).toHaveBeenCalledTimes(33)
  })
  it('cancels old directories/root identities and ignores late results without clearing the new row', async () => {
    let resolve!: (value: IcloudMetadataItem[]) => void
    const read = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              resolve = r
            })
        )
        .mockResolvedValueOnce([{ relativePath: 'same.wav', metadata: { artist: 'new' } }]),
      apply = vi.fn(),
      cancel = vi.fn()
    const loader = createIcloudMetadataLoader({ read, apply, cancel })
    const old = loader.load([entry('same.wav')], 'old-root')
    await loader.load([entry('same.wav')], 'new-root')
    resolve([{ relativePath: 'same.wav', metadata: { artist: 'stale' } }])
    await old
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls).toEqual([['same.wav', { artist: 'new' }]])
  })
  it('refreshes downloaded songs on demand, ignores unsolicited rows and clears stale metadata on failure', async () => {
    const read = vi
        .fn()
        .mockResolvedValueOnce([
          { relativePath: 'downloaded.wav', metadata: { bpm: 128 } },
          { relativePath: 'other.wav', metadata: { bpm: 999 } }
        ])
        .mockRejectedValueOnce(new Error('evicted')),
      apply = vi.fn()
    const loader = createIcloudMetadataLoader({ read, apply, cancel: vi.fn() })
    await loader.load([entry('downloaded.wav')], 'root')
    await loader.load([entry('downloaded.wav')], 'root')
    expect(apply.mock.calls).toEqual([
      ['downloaded.wav', { bpm: 128 }],
      ['downloaded.wav', undefined]
    ])
  })
})
