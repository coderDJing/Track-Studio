/** 查询与表达式索引必须复用同一 SQL；macOS 保留大小写。 */
export const normalizedSongCachePathSql = (
  expression: string,
  caseInsensitive = process.platform === 'win32'
): string =>
  `REPLACE(frkb_file_path_key_mode(${expression}, ${caseInsensitive ? 1 : 0}), '/', '\\')`

const INFO_PATH = "CASE WHEN json_valid(info_json) THEN json_extract(info_json, '$.filePath') END"
export const SONG_CACHE_INFO_PATH_SQL = normalizedSongCachePathSql(INFO_PATH)

// 旧版 macOS 索引无条件 LOWER。只在表达式不符时重建派生索引，避免新查询退化为全表扫描。
export const ensureSongCachePathIndexes = (
  db: {
    prepare: (sql: string) => { get: (name: string) => unknown }
    exec: (sql: string) => unknown
  },
  caseInsensitive = process.platform === 'win32'
) => {
  const normalize = (expression: string) => normalizedSongCachePathSql(expression, caseInsensitive)
  const indexes = [
    { name: 'idx_song_cache_file_normalized', expressions: [normalize('file_path')] },
    {
      name: 'idx_song_cache_root_file_normalized',
      expressions: [normalize('list_root'), normalize('file_path')]
    },
    { name: 'idx_song_cache_info_file_path_normalized', expressions: [normalize(INFO_PATH)] }
  ]
  for (const index of indexes) {
    const existing = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(index.name)
    const expected = `(${index.expressions.join(',')})`.replace(/\s+/g, '')
    if (
      existing &&
      typeof existing === 'object' &&
      'sql' in existing &&
      typeof existing.sql === 'string' &&
      !existing.sql.replace(/\s+/g, '').includes(expected)
    ) {
      db.exec(`DROP INDEX ${index.name}`)
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${index.name} ON song_cache(${index.expressions.join(',')})`
    )
  }
}
