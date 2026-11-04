import { afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSetContentGeneration } from './generation'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true })
})
const create = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-set-generation-'))
  directories.push(directory)
  const db = new Database(path.join(directory, 'library.sqlite'))
  db.pragma('journal_mode = WAL')
  for (const table of [
    'library_nodes',
    'set_items',
    'song_cache',
    'unified_display_waveform_cache',
    'waveform_surface_cache',
    'meta'
  ])
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, payload BLOB)`)
  return db
}

it('detects all content writes while unchanged checks do not read cache tables', () => {
  const db = create()
  try {
    let previous = readSetContentGeneration(db)
    const statements: string[] = []
    const reader = new Database(db.name, {
      readonly: true,
      verbose: (sql: string) => statements.push(sql)
    })
    try {
      readSetContentGeneration(reader)
      statements.length = 0
      for (let n = 0; n < 100; n++) readSetContentGeneration(reader)
      expect(
        statements.every((sql) => /temp\.frkb_set_sync_generation|data_version/.test(sql))
      ).toBe(true)
      expect(statements).toHaveLength(200)
    } finally {
      reader.close()
    }
    for (const table of [
      'library_nodes',
      'set_items',
      'song_cache',
      'unified_display_waveform_cache',
      'waveform_surface_cache'
    ]) {
      // A waveform replacement must invalidate the scan even if its file stat/timestamp is unchanged.
      for (const sql of [
        `INSERT INTO ${table} VALUES ('row', x'01')`,
        `UPDATE ${table} SET payload = x'02' WHERE id = 'row'`,
        `DELETE FROM ${table} WHERE id = 'row'`
      ]) {
        db.exec(sql)
        const next = readSetContentGeneration(db)
        expect(next).not.toBe(previous)
        expect(readSetContentGeneration(db)).toBe(next)
        previous = next
      }
    }
    db.exec("INSERT INTO meta VALUES ('sync-base', x'01')")
    expect(readSetContentGeneration(db)).toBe(previous)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'frkb_set_sync_%'").all()
    ).toEqual([])
  } finally {
    db.close()
  }
})

it('detects external commits and distinct connections, but permits a rolled-back edit', () => {
  const db = create()
  const external = new Database(db.name)
  try {
    const before = readSetContentGeneration(db)
    expect(() =>
      db.transaction(() => {
        db.exec("INSERT INTO song_cache VALUES ('cue', x'01')")
        throw new Error('rollback')
      })()
    ).toThrow('rollback')
    expect(readSetContentGeneration(db)).toBe(before)
    external.exec("INSERT INTO song_cache VALUES ('cue-cleared', x'00')")
    expect(readSetContentGeneration(db)).not.toBe(before)
    expect(readSetContentGeneration(external)).not.toBe(readSetContentGeneration(db))
  } finally {
    external.close()
    db.close()
  }
})
