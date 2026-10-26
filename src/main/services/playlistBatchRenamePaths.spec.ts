import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  batchRenamePathKey,
  createBatchRenameSourceLookup,
  isBatchRenameCaseAlias
} from './playlistBatchRenamePaths'
import { getMergeFilePathKey, uniqueTargetFilePath } from './libraryMerge/planFiles'

const mocks = vi.hoisted(() => ({ stat: vi.fn(), lstat: vi.fn() }))
vi.mock('node:fs/promises', () => ({
  stat: mocks.stat,
  default: { lstat: mocks.lstat }
}))

const fileStat = (ino: number, dev = 1) => ({ ino, dev, isFile: () => true })

beforeEach(() => {
  mocks.stat.mockReset()
  mocks.lstat.mockReset().mockResolvedValue(null)
})

describe('batch rename source identity', () => {
  it('folds Windows separators and case while preserving macOS case', () => {
    expect(batchRenamePathKey('D:/Music/Ä.mp3', 'win32')).toBe(
      batchRenamePathKey('d:\\music\\ä.mp3', 'win32')
    )
    expect(batchRenamePathKey('/Music/A.mp3', 'darwin')).not.toBe(
      batchRenamePathKey('/Music/a.mp3', 'darwin')
    )
  })

  it('recognizes macOS case aliases only when device and inode agree', async () => {
    mocks.stat.mockResolvedValueOnce(fileStat(5)).mockResolvedValueOnce(fileStat(5))
    expect(await isBatchRenameCaseAlias('/Music/A.mp3', '/Music/a.mp3', 'darwin')).toBe(true)
    mocks.stat.mockResolvedValueOnce(fileStat(5)).mockResolvedValueOnce(fileStat(6))
    expect(await isBatchRenameCaseAlias('/Music/A.mp3', '/Music/a.mp3', 'darwin')).toBe(false)
    mocks.stat.mockResolvedValueOnce(fileStat(5, 1)).mockResolvedValueOnce(fileStat(5, 2))
    expect(await isBatchRenameCaseAlias('/Music/A.mp3', '/Music/a.mp3', 'darwin')).toBe(false)
  })

  it('does not confuse missing targets or unrelated names with aliases', async () => {
    mocks.stat.mockRejectedValue(new Error('missing'))
    expect(await isBatchRenameCaseAlias('/Music/A.mp3', '/Music/a.mp3', 'darwin')).toBe(false)
    mocks.stat.mockClear()
    expect(await isBatchRenameCaseAlias('/Music/A.mp3', '/Music/B.mp3', 'darwin')).toBe(false)
    expect(mocks.stat).not.toHaveBeenCalled()
  })

  it('resolves a selected source by its actual inode on a case insensitive macOS volume', async () => {
    mocks.stat.mockResolvedValue(fileStat(7))
    const find = createBatchRenameSourceLookup(['/Music/Track.mp3'], 'darwin')
    expect(await find('/Music/Track.mp3')).toBe('/Music/Track.mp3')
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(await find('/Music/track.mp3')).toBe('/Music/Track.mp3')
  })

  it('keeps two case distinct sources separate and resolves aliases to the correct one', async () => {
    mocks.stat.mockImplementation(async (value: string) =>
      fileStat(value === '/Music/TRACK.mp3' ? 11 : 12)
    )
    const find = createBatchRenameSourceLookup(['/Music/TRACK.mp3', '/Music/Track.mp3'], 'darwin')
    expect(await find('/Music/TRACK.mp3')).toBe('/Music/TRACK.mp3')
    expect(await find('/Music/Track.mp3')).toBe('/Music/Track.mp3')
    expect(await find('/Music/track.mp3')).toBe('/Music/Track.mp3')
    expect(await find('/Music/other.mp3')).toBeUndefined()
  })
})

describe('library merge source and destination identity', () => {
  it('preserves case distinct macOS source mappings', () => {
    expect(getMergeFilePathKey('/Library/A.mp3', 'darwin')).not.toBe(
      getMergeFilePathKey('/Library/a.mp3', 'darwin')
    )
    expect(getMergeFilePathKey('D:/Library/A.mp3', 'win32')).toBe(
      getMergeFilePathKey('d:\\library\\a.mp3', 'win32')
    )
  })

  it('reserves case colliding destination names separately for cross platform safety', async () => {
    const reserved = new Set<string>()
    const first = await uniqueTargetFilePath('/target', 'Track.mp3', 'Source', reserved)
    const second = await uniqueTargetFilePath('/target', 'track.mp3', 'Source', reserved)
    expect(path.basename(first)).toBe('Track.mp3')
    expect(path.basename(second)).toBe('track (from Source).mp3')
  })
})
