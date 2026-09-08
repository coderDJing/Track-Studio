import { describe, expect, it } from 'vitest'
import { normalizeRecycleBinRecordPathKey, normalizeRecycleBinStoredPath } from './recycleBinDb'

describe('recycle bin persisted paths', () => {
  it('stores relative paths with portable separators', () => {
    expect(normalizeRecycleBinStoredPath('RecycleBin\\Song.mp3')).toBe('RecycleBin/Song.mp3')
    expect(normalizeRecycleBinStoredPath('RecycleBin/Song.mp3')).toBe('RecycleBin/Song.mp3')
  })

  it('preserves absolute paths from either supported platform', () => {
    expect(normalizeRecycleBinStoredPath('C:\\Music\\Song.mp3')).toBe('C:\\Music\\Song.mp3')
    expect(normalizeRecycleBinStoredPath('/Users/me/Music/Song.mp3')).toBe(
      '/Users/me/Music/Song.mp3'
    )
  })

  it('uses Windows case rules and macOS case-sensitive rules', () => {
    expect(normalizeRecycleBinRecordPathKey('RecycleBin\\Song.mp3', 'win32')).toBe(
      'recyclebin/song.mp3'
    )
    expect(normalizeRecycleBinRecordPathKey('RecycleBin\\Song.mp3', 'darwin')).toBe(
      'RecycleBin/Song.mp3'
    )
    expect(normalizeRecycleBinRecordPathKey('RecycleBin/song.mp3', 'darwin')).not.toBe(
      normalizeRecycleBinRecordPathKey('RecycleBin/Song.mp3', 'darwin')
    )
  })
})
