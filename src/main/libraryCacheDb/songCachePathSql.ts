/** 查询与表达式索引必须复用完全相同的 SQL。SQLite 字符串中的反斜杠不转义。 */
export const normalizedSongCachePathSql = (expression: string): string =>
  `REPLACE(LOWER(${expression}), '/', '\\')`

export const SONG_CACHE_INFO_PATH_SQL = normalizedSongCachePathSql(
  "CASE WHEN json_valid(info_json) THEN json_extract(info_json, '$.filePath') END"
)
