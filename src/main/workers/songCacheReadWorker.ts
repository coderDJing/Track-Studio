import { parentPort } from 'node:worker_threads'
import { readSongCacheRows } from '../libraryCacheDb/songCacheRead'
import type { SqliteDatabase } from '../libraryDb'

parentPort?.on('message', (request: { id: number; databasePath: string; roots: string[] }) => {
  let db: SqliteDatabase | null = null
  try {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    // 不建库、不迁移；连接随请求关闭，切换资料库时不持有旧库文件。
    db = new Database(request.databasePath, { readonly: true, fileMustExist: true })
    const rows = readSongCacheRows(db, request.roots)
    parentPort?.postMessage({ id: request.id, rows })
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    db?.close()
  }
})
