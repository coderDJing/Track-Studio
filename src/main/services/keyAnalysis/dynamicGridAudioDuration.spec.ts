import { describe, expect, it, vi } from 'vitest'
import { resolveDynamicGridAudioDurationSec } from './dynamicGridAudioDuration'

const probeDynamicGridAudioDuration = vi.hoisted(() =>
  vi.fn(async (_filePath: string, _candidate?: number) => 321)
)

vi.mock('../../workers/dynamicBeatGridScanner', () => ({
  probeDynamicGridAudioDuration
}))

describe('resolveDynamicGridAudioDurationSec', () => {
  it('passes the queued probe value only as a candidate and returns the verified duration', async () => {
    probeDynamicGridAudioDuration.mockClear()
    probeDynamicGridAudioDuration.mockResolvedValueOnce(120)

    await expect(
      resolveDynamicGridAudioDurationSec({ filePath: 'D:/music/a.mp3', probeDurationSec: 134 })
    ).resolves.toBe(120)
    expect(probeDynamicGridAudioDuration).toHaveBeenCalledWith('D:/music/a.mp3', 134)
  })

  it('does not return a candidate without verification', async () => {
    probeDynamicGridAudioDuration.mockClear()

    await expect(
      resolveDynamicGridAudioDurationSec({ filePath: 'D:/music/a.mka', probeDurationSec: 134 })
    ).resolves.toBe(321)
    expect(probeDynamicGridAudioDuration).toHaveBeenCalledTimes(1)
  })

  it('passes an unusable queued probe as an absent candidate', async () => {
    probeDynamicGridAudioDuration.mockClear()

    await expect(
      resolveDynamicGridAudioDurationSec({ filePath: 'D:/music/b.mp3', probeDurationSec: 0 })
    ).resolves.toBe(321)
    expect(probeDynamicGridAudioDuration).toHaveBeenCalledWith('D:/music/b.mp3', undefined)
  })

  it('returns undefined when the bounded verification rejects', async () => {
    probeDynamicGridAudioDuration.mockClear()
    probeDynamicGridAudioDuration.mockRejectedValueOnce(new Error('unsupported-duration'))

    await expect(
      resolveDynamicGridAudioDurationSec({ filePath: 'D:/music/c.mp3' })
    ).resolves.toBeUndefined()
  })
})
