import { describe, expect, it, vi } from 'vitest'
import {
  createWorkerPersistGuard,
  isSameAudioIdentity,
  normalizeAudioIdentity
} from './persistGuard'

describe('persistGuard', () => {
  it('matches audio identity only when size and mtime agree', () => {
    expect(isSameAudioIdentity({ size: 10, mtimeMs: 1000 }, { size: 10, mtimeMs: 1000 })).toBe(true)
    expect(isSameAudioIdentity({ size: 10, mtimeMs: 1000 }, { size: 11, mtimeMs: 1000 })).toBe(
      false
    )
    expect(isSameAudioIdentity({ size: 10, mtimeMs: 1000 }, { size: 10, mtimeMs: 1010 })).toBe(
      false
    )
    expect(isSameAudioIdentity(null, { size: 10, mtimeMs: 1000 })).toBe(false)
  })

  it('rejects an invalid identity snapshot', () => {
    expect(normalizeAudioIdentity({ size: Number.NaN, mtimeMs: 1 })).toBeNull()
    expect(normalizeAudioIdentity(undefined)).toBeNull()
    expect(normalizeAudioIdentity({ size: 1, mtimeMs: 'x' })).toBeNull()
  })

  it('drops commit rights when the file changed after the job started', async () => {
    const guard = await createWorkerPersistGuard({
      isCurrentJob: () => true,
      expectedAudioIdentity: { size: 10, mtimeMs: 1000 },
      readCurrentAudioIdentity: async () => ({ size: 10, mtimeMs: 2000 })
    })
    expect(guard()).toBe(false)
  })

  it('drops commit rights when a newer grid request superseded the job', async () => {
    const readCurrent = vi.fn(async () => ({ size: 10, mtimeMs: 1000 }))
    const guard = await createWorkerPersistGuard({
      isCurrentJob: () => false,
      expectedAudioIdentity: { size: 10, mtimeMs: 1000 },
      readCurrentAudioIdentity: readCurrent
    })
    expect(guard()).toBe(false)
  })

  it('allows commit while the job owns the request and the audio is unchanged', async () => {
    const guard = await createWorkerPersistGuard({
      isCurrentJob: () => true,
      expectedAudioIdentity: { size: 10, mtimeMs: 1000 },
      readCurrentAudioIdentity: async () => ({ size: 10, mtimeMs: 1000 })
    })
    expect(guard()).toBe(true)
  })
})
