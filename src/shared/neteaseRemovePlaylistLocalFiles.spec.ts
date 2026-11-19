import { describe, expect, it } from 'vitest'
import {
  normalizeNeteaseRemovePlaylistLocalFilesPref,
  resolveNeteaseRemovePlaylistLocalFilesDecision,
  shouldAskNeteaseRemovePlaylistLocalFiles
} from './neteaseRemovePlaylistLocalFiles'

describe('normalizeNeteaseRemovePlaylistLocalFilesPref', () => {
  it('keeps known prefs and falls back to ask', () => {
    expect(normalizeNeteaseRemovePlaylistLocalFilesPref('delete')).toBe('delete')
    expect(normalizeNeteaseRemovePlaylistLocalFilesPref('keep')).toBe('keep')
    expect(normalizeNeteaseRemovePlaylistLocalFilesPref('ask')).toBe('ask')
    expect(normalizeNeteaseRemovePlaylistLocalFilesPref(undefined)).toBe('ask')
    expect(normalizeNeteaseRemovePlaylistLocalFilesPref('nope')).toBe('ask')
  })
})

describe('shouldAskNeteaseRemovePlaylistLocalFiles', () => {
  it('only asks when the pref is ask and some tracks are downloaded', () => {
    expect(shouldAskNeteaseRemovePlaylistLocalFiles({ pref: 'ask', downloadedCount: 2 })).toBe(true)
    expect(shouldAskNeteaseRemovePlaylistLocalFiles({ pref: 'ask', downloadedCount: 0 })).toBe(
      false
    )
    expect(shouldAskNeteaseRemovePlaylistLocalFiles({ pref: 'delete', downloadedCount: 2 })).toBe(
      false
    )
    expect(shouldAskNeteaseRemovePlaylistLocalFiles({ pref: 'keep', downloadedCount: 2 })).toBe(
      false
    )
  })
})

describe('resolveNeteaseRemovePlaylistLocalFilesDecision', () => {
  it('never deletes local files when none are downloaded', () => {
    expect(
      resolveNeteaseRemovePlaylistLocalFilesDecision({
        pref: 'delete',
        downloadedCount: 0,
        alsoDeleteLocal: true,
        remember: true
      })
    ).toEqual({ deleteLocal: false, nextPref: null })
  })

  it('follows a remembered delete or keep pref', () => {
    expect(
      resolveNeteaseRemovePlaylistLocalFilesDecision({ pref: 'delete', downloadedCount: 3 })
    ).toEqual({ deleteLocal: true, nextPref: null })
    expect(
      resolveNeteaseRemovePlaylistLocalFilesDecision({ pref: 'keep', downloadedCount: 3 })
    ).toEqual({ deleteLocal: false, nextPref: null })
  })

  it('uses the checkbox answers when asking, and saves them only if remembered', () => {
    expect(
      resolveNeteaseRemovePlaylistLocalFilesDecision({
        pref: 'ask',
        downloadedCount: 2,
        alsoDeleteLocal: true,
        remember: true
      })
    ).toEqual({ deleteLocal: true, nextPref: 'delete' })
    expect(
      resolveNeteaseRemovePlaylistLocalFilesDecision({
        pref: 'ask',
        downloadedCount: 2,
        alsoDeleteLocal: false,
        remember: true
      })
    ).toEqual({ deleteLocal: false, nextPref: 'keep' })
    expect(
      resolveNeteaseRemovePlaylistLocalFilesDecision({
        pref: 'ask',
        downloadedCount: 2,
        alsoDeleteLocal: true,
        remember: false
      })
    ).toEqual({ deleteLocal: true, nextPref: null })
  })
})
