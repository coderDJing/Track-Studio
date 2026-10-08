import { Worker, isMainThread } from 'node:worker_threads'
import { resolveMainWorkerPath } from '../workerPath'
import { readSongCacheRows, type SongCacheDbRow } from '../libraryCacheDb/songCacheRead'
import type { SqliteDatabase } from '../libraryDb'

type PendingRead = {
  resolve: (rows: SongCacheDbRow[][]) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let sequence = 0
let idleTimer: NodeJS.Timeout | null = null
const pending = new Map<number, PendingRead>()

const clearIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

const ensureWorker = (): Worker => {
  if (worker) return worker
  const current = new Worker(resolveMainWorkerPath(__dirname, 'songCacheReadWorker.js'))
  worker = current
  const fail = (error: Error) => {
    if (worker !== current) return
    worker = null
    clearIdleTimer()
    for (const read of pending.values()) read.reject(error)
    pending.clear()
    void current.terminate()
  }
  current.on('error', fail)
  current.on('exit', (code) => fail(new Error(`song cache read worker exited (${code})`)))
  current.on('message', (response: { id: number; rows?: SongCacheDbRow[][]; error?: string }) => {
    const read = pending.get(response.id)
    if (!read) return
    pending.delete(response.id)
    if (response.error) read.reject(new Error(response.error))
    else if (response.rows) read.resolve(response.rows)
    else read.reject(new Error('song cache read worker returned no rows'))
    if (pending.size === 0) {
      idleTimer = setTimeout(() => {
        if (worker !== current) return
        worker = null
        idleTimer = null
        void current.terminate()
      }, 30_000)
      idleTimer.unref()
      current.unref()
    }
  })
  return current
}

export const readSongCacheOffMainThread = (
  db: SqliteDatabase,
  roots: string[]
): Promise<SongCacheDbRow[][]> => {
  // 已在扫描 worker 内时直接读；事务内必须使用原连接，才能看见尚未提交的写入。
  if (!isMainThread || db.inTransaction || db.memory) {
    return Promise.resolve(readSongCacheRows(db, roots))
  }
  const current = ensureWorker()
  clearIdleTimer()
  current.ref()
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      current.postMessage({ id, databasePath: db.name, roots })
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
