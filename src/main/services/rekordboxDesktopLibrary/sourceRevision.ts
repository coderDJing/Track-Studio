import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { requireRekordboxDesktopSourceDbPath } from './detect'

export const getRekordboxDesktopSourceRevision = async (dbPath?: string): Promise<string> => {
  const sourceDbPath = dbPath ?? (await requireRekordboxDesktopSourceDbPath())
  const files = [sourceDbPath, `${sourceDbPath}-wal`, `${sourceDbPath}-journal`]
  const stamps = await Promise.all(
    files.map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath)
        return `${filePath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          if (filePath !== sourceDbPath) return `${filePath}:missing`
        }
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`检查 Rekordbox 库文件版本失败（${filePath}）：${detail}`, { cause: error })
      }
    })
  )
  return createHash('sha256').update(stamps.join('|')).digest('hex')
}
