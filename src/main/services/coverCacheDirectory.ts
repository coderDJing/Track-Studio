import fs from 'node:fs/promises'
import path from 'node:path'
import { setFileHidden } from './hiddenFileOperation'

const pending = new Map<string, Promise<void>>()
const prepared = new Set<string>()

export const prepareCoverCacheDirectory = (directory: string): Promise<void> => {
  const resolved = path.resolve(directory)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const existing = pending.get(key)
  if (existing) return existing
  const operation = (async () => {
    // 每次确认目录仍存在，清缓存后也能重建；隐藏属性仅首次准备或重建时设置。
    const created = await fs.mkdir(resolved, { recursive: true })
    if (created !== undefined || !prepared.has(key)) {
      prepared.delete(key)
      await setFileHidden(resolved)
      if (prepared.size >= 256) prepared.delete(prepared.values().next().value!)
      prepared.add(key)
    }
  })().finally(() => {
    pending.delete(key)
  })
  pending.set(key, operation)
  return operation
}
