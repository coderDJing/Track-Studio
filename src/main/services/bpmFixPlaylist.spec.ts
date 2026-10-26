// Run: pnpm exec vitest run src/main/services/bpmFixPlaylist.spec.ts
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerFilePathComparison } from '../filePathComparison'
import { assertBpmFixPlaylistTrack } from './bpmFixPlaylist'

const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../libraryDb', () => ({ getLibraryDb: () => state.db }))
vi.mock('../libraryTreeDb', () => ({ findLibraryNodeByPath: () => ({ uuid: 'playlist' }) }))
vi.mock('../store', () => ({ default: { databaseDir: '/audit', settingConfig: {} } }))
vi.mock('./playlistViewSnapshotService', () => ({
  invalidatePlaylistViewSnapshotsByPaths: vi.fn(),
  beginPlaylistViewSnapshotMutationByPaths: vi.fn()
}))
vi.mock('../cloudSyncScheduler', () => ({ scheduleCuratedLibrarySyncIfUnderCurated: vi.fn() }))
vi.mock('./globalSongSearch', () => ({ markGlobalSongSearchDirty: vi.fn() }))
vi.mock('./playlistTrackNumbers', () => ({ compactSongListTrackNumbersByFilePaths: vi.fn() }))
let db: DatabaseSync | undefined
afterEach(() => db?.close())

describe.each(['win32', 'darwin'] as const)('%s BPM-fix playlist identity', (platform) => {
  it.each(['set', 'mixtape'] as const)(
    'checks the exact physical source before a %s write',
    (kind) => {
      db = new DatabaseSync(':memory:')
      const connection = db
      state.db = connection
      registerFilePathComparison(
        {
          function: (name, options, callback) => {
            connection.function(name, options, callback)
          }
        },
        platform
      )
      const table = kind === 'set' ? 'set_items' : 'mixtape_items'
      connection.exec(`CREATE TABLE ${table} (id TEXT, playlist_uuid TEXT, file_path TEXT)`)
      const source = platform === 'win32' ? 'G:\\音乐\\Ä Track.mp3' : '/Volumes/音乐/Track.mp3'
      const alias = platform === 'win32' ? 'g:/音乐/ä track.mp3' : source
      connection.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run('item', 'playlist', source)
      const playlist = { root: '/audit/library/list', uuid: 'playlist', kind }
      expect(() => assertBpmFixPlaylistTrack(playlist, alias)).not.toThrow()
      expect(() => assertBpmFixPlaylistTrack(playlist, `${alias}.other`)).toThrow(
        'BPM_FIX_INVALID_PLAYLIST'
      )
      if (platform === 'darwin') {
        expect(() => assertBpmFixPlaylistTrack(playlist, source.replace('Track', 'track'))).toThrow(
          'BPM_FIX_INVALID_PLAYLIST'
        )
      }
    }
  )
})
