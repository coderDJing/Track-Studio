import { isWindowsPathPlatform, normalizeFilePathForComparison } from '../shared/filePathComparison'

export const mainFilePathKey = (
  value: string | null | undefined,
  platform: string = process.platform
) => normalizeFilePathForComparison(value, isWindowsPathPlatform(platform))

export const uniqueMainFilePaths = (values: readonly string[]): string[] => {
  const paths = new Map<string, string>()
  for (const value of values) {
    const key = mainFilePathKey(value)
    if (key && !paths.has(key)) paths.set(key, value)
  }
  return [...paths.values()]
}

// 同一 JS 比较规则也用于 SQL，避免 SQLite LOWER 只处理 ASCII 大小写。
// 每个连接独立注册；不改写数据库中的原路径。
export const registerFilePathComparison = (
  db: {
    function: (
      name: string,
      options: { deterministic: boolean },
      callback: (...args: unknown[]) => string
    ) => unknown
  },
  platform: string = process.platform
) => {
  db.function('frkb_file_path_key', { deterministic: true }, (value: unknown) =>
    mainFilePathKey(typeof value === 'string' ? value : '', platform)
  )
  // 索引明确记录大小写规则，跨平台打开库时可以识别并重建派生索引。
  db.function(
    'frkb_file_path_key_mode',
    { deterministic: true },
    (value: unknown, caseInsensitive: unknown) =>
      normalizeFilePathForComparison(typeof value === 'string' ? value : '', caseInsensitive === 1)
  )
}
