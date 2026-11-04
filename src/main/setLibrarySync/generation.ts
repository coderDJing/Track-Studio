import type { SqliteDatabase } from '../libraryDb'

const generations = new WeakMap<SqliteDatabase, number>()
let nextConnection = 0
const tables = [
  'library_nodes',
  'set_items',
  'song_cache',
  'unified_display_waveform_cache',
  'waveform_surface_cache'
] as const

/**
 * Track content writes without reading waveform rows (whose payloads can span many GB).
 * TEMP triggers belong only to this connection and never change the library schema on disk.
 * data_version also detects commits by other connections, including external tag/cache writers.
 */
export function readSetContentGeneration(db: SqliteDatabase): string {
  let connection = generations.get(db)
  if (connection === undefined) {
    db.exec('CREATE TEMP TABLE frkb_set_sync_generation (version INTEGER NOT NULL)')
    db.exec('INSERT INTO frkb_set_sync_generation VALUES (0)')
    for (const table of tables) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        db.exec(`CREATE TEMP TRIGGER frkb_set_sync_${table}_${operation}
          AFTER ${operation} ON main.${table}
          BEGIN UPDATE frkb_set_sync_generation SET version = version + 1; END`)
      }
    }
    connection = ++nextConnection
    generations.set(db, connection)
  }
  const version = db
    .prepare<{ version: number }>('SELECT version FROM temp.frkb_set_sync_generation')
    .get()!.version
  const external = db.pragma('data_version', { simple: true })
  return `${connection}:${version}:${external}`
}
