import path from 'node:path'
import { stat } from 'node:fs/promises'
import { mainFilePathKey } from '../filePathComparison'

export const batchRenamePathKey = (value: string, platform: string = process.platform) =>
  mainFilePathKey(path.resolve(value || ''), platform)

// macOS 可挂载大小写敏感或不敏感卷；仅大小写不同的候选必须核对实际文件身份。
export const isBatchRenameCaseAlias = async (
  source: string,
  target: string,
  platform: string = process.platform
): Promise<boolean> => {
  if (batchRenamePathKey(source, platform) === batchRenamePathKey(target, platform)) return true
  if (batchRenamePathKey(source, 'win32') !== batchRenamePathKey(target, 'win32')) return false
  const [from, to] = await Promise.all([
    stat(source).catch(() => null),
    stat(target).catch(() => null)
  ])
  return Boolean(
    from?.isFile() && to?.isFile() && from.ino > 0 && from.ino === to.ino && from.dev === to.dev
  )
}

export const createBatchRenameSourceLookup = (
  paths: readonly string[],
  platform: string = process.platform
) => {
  const exact = new Map(paths.map((value) => [batchRenamePathKey(value, platform), value]))
  const folded = new Map<string, string[]>()
  for (const value of paths) {
    const key = batchRenamePathKey(value, 'win32')
    const entries = folded.get(key) || []
    entries.push(value)
    folded.set(key, entries)
  }
  return async (target: string): Promise<string | undefined> => {
    const match = exact.get(batchRenamePathKey(target, platform))
    if (match !== undefined) return match
    for (const source of folded.get(batchRenamePathKey(target, 'win32')) || []) {
      if (await isBatchRenameCaseAlias(source, target, platform)) return source
    }
    return undefined
  }
}
