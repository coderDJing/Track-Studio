import fs = require('fs-extra')
import path = require('path')
import { isENOSPCError } from './nodeErrorUtils'

// This module intentionally stays separate from utils.ts.
// scanSongs is loaded by songListScanWorker via node:worker_threads, while utils.ts has
// Electron IPC/session imports at module load time. Merging these helpers into utils.ts
// makes the worker load Electron-only dependencies and fail before scanning starts.
type InterruptedDecision = 'resume' | 'cancel'

/** 子目录并发上限。libuv 线程池默认 4，开太大只会排队，还会抢走 stat 的额度。 */
const DIRECTORY_SCAN_CONCURRENCY = 8

/**
 * 递归枚举目录下的指定后缀文件。
 *
 * 子目录并发展开（上限 DIRECTORY_SCAN_CONCURRENCY），但拼接时严格按目录项顺序回填，
 * 因此输出顺序与串行版本逐字一致——歌单序号初始化、封面扫描都依赖这个顺序。
 */
export const collectFilesWithExtensions = async (dir: string, extensions: string[] = []) => {
  const allowedExts = new Set(
    extensions.map((ext) => String(ext || '').toLowerCase()).filter(Boolean)
  )

  let active = 0
  const waiters: Array<() => void> = []
  const acquire = async (): Promise<void> => {
    if (active < DIRECTORY_SCAN_CONCURRENCY) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  // 有等待者时直接移交许可（不减 active），否则会短暂超发并突破并发上限。
  const release = (): void => {
    const next = waiters.shift()
    if (next) {
      next()
      return
    }
    active -= 1
  }

  const walk = async (current: string): Promise<string[]> => {
    let entries: fs.Dirent[]
    await acquire()
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return []
    } finally {
      release()
    }

    const subDirFiles = new Map<number, string[]>()
    const pending: Array<Promise<void>> = []
    for (const [index, entry] of entries.entries()) {
      if (!entry.isDirectory()) continue
      const childPath = path.join(current, entry.name)
      pending.push(
        walk(childPath).then((files) => {
          subDirFiles.set(index, files)
        })
      )
    }
    if (pending.length > 0) await Promise.all(pending)

    const files: string[] = []
    for (const [index, entry] of entries.entries()) {
      if (entry.isDirectory()) {
        const nested = subDirFiles.get(index)
        if (nested) {
          for (const file of nested) files.push(file)
        }
        continue
      }
      if (!entry.isFile()) continue
      if (!allowedExts.has(path.extname(entry.name).toLowerCase())) continue
      files.push(path.join(current, entry.name))
    }
    return files
  }

  try {
    const stats = await fs.stat(dir)
    if (stats.isFile()) {
      return allowedExts.has(path.extname(dir).toLowerCase()) ? [dir] : []
    }
    return await walk(dir)
  } catch {
    return []
  }
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  options: {
    concurrency?: number
    onProgress?: (done: number, total: number) => void
    onInterrupted?: (payload: {
      total: number
      done: number
      running: number
      pending: number
      successSoFar: number
      failedSoFar: number
    }) => Promise<InterruptedDecision>
    stopOnENOSPC?: boolean
    yieldEvery?: number
  } = {}
): Promise<{
  results: Array<T | Error>
  success: number
  failed: number
  hasENOSPC: boolean
  skipped: number
}> {
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 16))
  const yieldEvery = Math.max(0, Math.floor(options.yieldEvery ?? 0))
  const total = tasks.length
  const results: Array<T | Error> = new Array(total)
  let nextIndex = 0
  let inFlight = 0
  let completed = 0
  let hasENOSPC = false
  let interrupted = false
  let cancelled = false
  let skipped = 0

  const retryQueue: number[] = []

  let gateResolve: (() => void) | null = null
  let gate: Promise<void> | null = null
  const closeGate = () => {
    if (gateResolve) gateResolve()
    gateResolve = null
    gate = null
  }
  const openGate = () => {
    if (!gate) {
      gate = new Promise<void>((resolve) => {
        gateResolve = resolve
      })
    }
  }

  const maybeYieldToEventLoop = async () => {
    if (yieldEvery <= 0 || completed === 0 || completed % yieldEvery !== 0) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  const getNextTaskIndex = async (): Promise<number | null> => {
    if (cancelled) return null
    if (interrupted && gate) {
      await gate
      if (cancelled) return null
    }
    if (retryQueue.length > 0) {
      return retryQueue.shift() as number
    }
    if (nextIndex < total) {
      const idx = nextIndex
      nextIndex += 1
      return idx
    }
    return null
  }

  async function handleENOSPC(idx: number) {
    hasENOSPC = true
    retryQueue.push(idx)
    if (options.stopOnENOSPC !== false) {
      if (!interrupted) {
        interrupted = true
        openGate()
        if (typeof options.onInterrupted === 'function') {
          const successSoFar = results.filter(
            (result) => result !== undefined && !(result instanceof Error)
          ).length
          const failedSoFar = results.filter((result) => result instanceof Error).length
          const decision = await options.onInterrupted({
            total,
            done: completed,
            running: inFlight,
            pending: total - completed - inFlight,
            successSoFar,
            failedSoFar
          })
          if (decision === 'resume') {
            interrupted = false
            closeGate()
          } else {
            cancelled = true
            skipped += total - completed - inFlight
            closeGate()
          }
        }
      }
    }
  }

  async function worker() {
    while (true) {
      const idx = await getNextTaskIndex()
      if (idx === null) break
      inFlight += 1
      try {
        const value = await tasks[idx]()
        results[idx] = value === undefined ? (true as unknown as T) : value
        completed += 1
        options.onProgress?.(completed, total)
        await maybeYieldToEventLoop()
      } catch (error: unknown) {
        if (isENOSPCError(error)) {
          await handleENOSPC(idx)
          if (cancelled) {
            results[idx] = error instanceof Error ? error : new Error(String(error))
            completed += 1
            options.onProgress?.(completed, total)
            await maybeYieldToEventLoop()
          }
        } else {
          results[idx] = error instanceof Error ? error : new Error(String(error))
          completed += 1
          options.onProgress?.(completed, total)
          await maybeYieldToEventLoop()
        }
      } finally {
        inFlight -= 1
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker())
  await Promise.all(workers)

  const failed = results.filter((result) => result instanceof Error).length
  const success = results.filter(
    (result) => result !== undefined && !(result instanceof Error)
  ).length
  return { results, success, failed, hasENOSPC, skipped }
}
