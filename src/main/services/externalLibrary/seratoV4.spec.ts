import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { __seratoV4TestUtils, isSeratoV4Library, readSeratoV4Library } from './seratoV4'

vi.mock('electron', () => ({ app: { getPath: () => os.homedir() } }))

describe('Serato 4 library database', () => {
  let tempDir = ''

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  })

  it('resolves local and external macOS locations from Serato connection records', async () => {
    const paths = await __seratoV4TestUtils.resolveAssetPaths(
      [
        { id: 1, location_id: 3, portable_id: 'Users/dj/Music/local.mp3' },
        { id: 2, location_id: 4, portable_id: 'Music/external.mp3' }
      ],
      [
        {
          location_id: 3,
          database_uri: '/Users/dj/Library/Application Support/Serato/Library/root.sqlite'
        },
        {
          location_id: 4,
          database_uri: '/Volumes/DJ SSD/_Serato_/Library/location.sqlite'
        }
      ],
      'darwin'
    )
    expect(paths.get(1)).toBe('/Users/dj/Music/local.mp3')
    expect(paths.get(2)).toBe('/Volumes/DJ SSD/Music/external.mp3')
  })

  it('reads the current SQLite asset and crate membership', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-serato-v4-'))
    const libraryDir = path.join(tempDir, 'Serato', 'Library')
    const trackPath = path.join(tempDir, 'track.mp3')
    const externalTrackPath = path.join(tempDir, 'external.mp3')
    await fs.mkdir(libraryDir, { recursive: true })
    await fs.writeFile(trackPath, '')
    await fs.writeFile(externalTrackPath, '')
    const database = new Database(path.join(libraryDir, 'master.sqlite'))
    try {
      database.exec(`
        CREATE TABLE connection (location_id INTEGER, database_uri TEXT);
        CREATE TABLE asset (id INTEGER, location_id INTEGER, portable_id TEXT, file_name TEXT,
          name TEXT, artist TEXT, album TEXT, genre TEXT, label TEXT, comments TEXT, key TEXT,
          bpm REAL, length_sec INTEGER, length_ms INTEGER, file_bit_rate REAL,
          file_sample_rate REAL, format TEXT, year TEXT, time_added INTEGER, is_missing INTEGER);
        CREATE TABLE space (id INTEGER, name TEXT);
        CREATE TABLE container (id INTEGER, parent_id INTEGER, name TEXT, type INTEGER,
          list_order INTEGER, space_id INTEGER);
        CREATE TABLE location_container (id INTEGER, container_id INTEGER);
        CREATE TABLE container_asset (asset_id INTEGER, location_container_id INTEGER,
          list_order INTEGER);
        CREATE TABLE smart_crate_rules (container_id INTEGER);
      `)
      const rootPath = path.parse(trackPath).root
      database
        .prepare('INSERT INTO connection VALUES (?, ?)')
        .run(3, path.join(rootPath, 'Serato', 'Library', 'root.sqlite'))
      database
        .prepare('INSERT INTO connection VALUES (?, ?)')
        .run(4, path.join(tempDir, '_Serato_', 'Library', 'location.sqlite'))
      database
        .prepare(
          'INSERT INTO asset VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          7,
          3,
          path.relative(rootPath, trackPath).replaceAll('\\', '/'),
          'track.mp3',
          'Track',
          'Artist',
          '',
          '',
          '',
          '',
          '',
          128,
          180,
          0,
          null,
          null,
          'mp3',
          '2025',
          1,
          0
        )
      database.prepare('INSERT INTO space VALUES (?, ?)').run(5, 'Serato Library')
      database
        .prepare(
          'INSERT INTO asset VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          8,
          4,
          'external.mp3',
          'external.mp3',
          'External',
          '',
          '',
          '',
          '',
          '',
          '',
          0,
          90,
          0,
          null,
          null,
          'mp3',
          '',
          1,
          0
        )
      database
        .prepare('INSERT INTO container VALUES (?, ?, ?, ?, ?, ?)')
        .run(5, 0, 'Serato Library', 0, 0, 5)
      database.prepare('INSERT INTO container VALUES (?, ?, ?, ?, ?, ?)').run(9, 5, 'Set', 1, 1, 5)
      database.prepare('INSERT INTO location_container VALUES (?, ?)').run(10, 9)
      database.prepare('INSERT INTO container_asset VALUES (?, ?, ?)').run(7, 10, 1)
      database.prepare('INSERT INTO container_asset VALUES (?, ?, ?)').run(8, 10, 2)
    } finally {
      database.close()
    }

    expect(await isSeratoV4Library(libraryDir)).toBe(true)
    const snapshot = await readSeratoV4Library(libraryDir)
    expect(snapshot.tracks).toMatchObject([
      { filePath: trackPath, title: 'Track', bpm: 128 },
      { filePath: externalTrackPath, title: 'External' }
    ])
    expect(snapshot.playlists).toMatchObject([
      { id: 'serato-v4:9', name: 'Set', trackIds: ['serato-v4-track:7', 'serato-v4-track:8'] }
    ])
  })
})
