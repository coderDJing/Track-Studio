import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * better-sqlite3 在本仓库是按 Electron ABI 编译的，普通 vitest（Node ABI）加载不了，
 * 因此这里不打真库，只用一个假 db 锁住「整批一次提交」这个真正要保住的行为。
 */
const mocks = vi.hoisted(() => {
  const state = {
    transactionCalls: 0,
    writeCalls: 0,
    failNextTransaction: false
  }
  const db = {
    prepare: () => ({
      all: () => [],
      get: () => undefined,
      run: () => {
        state.writeCalls += 1
        return { changes: 1 }
      }
    }),
    transaction: (fn: (...args: unknown[]) => unknown) => () => {
      state.transactionCalls += 1
      if (state.failNextTransaction) {
        state.failNextTransaction = false
        throw new Error('transaction failed')
      }
      return fn()
    }
  }
  const reset = () => {
    state.transactionCalls = 0
    state.writeCalls = 0
    state.failNextTransaction = false
  }
  return { state, db, reset }
})

vi.mock('./libraryDb', () => ({
  getLibraryDb: () => mocks.db,
  isSqliteRow: (value: unknown) => !!value && typeof value === 'object'
}))

vi.mock('./log', () => ({ log: { error: () => {} } }))

const { upsertRecycleBinRecord, upsertRecycleBinRecords } = await import('./recycleBinDb')
const { getMainThreadActivitySnapshot, resetMainThreadActivityTraceForTests } =
  await import('./services/mainProcessActivityTraceState')

afterEach(() => {
  mocks.reset()
  resetMainThreadActivityTraceForTests()
})

describe('recycle bin batch upsert', () => {
  it('folds a whole batch into a single transaction', () => {
    const written = upsertRecycleBinRecords([
      { filePath: 'RecycleBin/A.mp3', deletedAtMs: 1 },
      { filePath: 'RecycleBin/B.mp3', deletedAtMs: 2 },
      { filePath: 'RecycleBin/C.mp3', deletedAtMs: 3 }
    ])

    expect(written).toBe(3)
    // 逐条 upsert 会是 3 次提交；批量必须只剩 1 次。
    expect(mocks.state.transactionCalls).toBe(1)
    expect(mocks.state.writeCalls).toBe(6)
  })

  it('preserves the per-record commit count for the single-record entry point', () => {
    upsertRecycleBinRecord({ filePath: 'RecycleBin/Single.mp3', deletedAtMs: 1 })

    expect(mocks.state.transactionCalls).toBe(1)
  })

  it('falls back to per-record writes when the batch transaction fails', () => {
    mocks.state.failNextTransaction = true

    const written = upsertRecycleBinRecords([
      { filePath: 'RecycleBin/A.mp3', deletedAtMs: 1 },
      { filePath: 'RecycleBin/B.mp3', deletedAtMs: 2 },
      { filePath: 'RecycleBin/C.mp3', deletedAtMs: 3 }
    ])

    expect(written).toBe(3)
    expect(mocks.state.transactionCalls).toBe(4)
    expect(mocks.state.writeCalls).toBe(6)
  })

  it('is a no-op for empty input', () => {
    expect(upsertRecycleBinRecords([])).toBe(0)
    expect(mocks.state.transactionCalls).toBe(0)
    expect(mocks.state.writeCalls).toBe(0)
  })

  it('publishes the batch write as a traced main-thread activity', () => {
    const startedAtMs = Date.now()
    upsertRecycleBinRecords([{ filePath: 'RecycleBin/A.mp3', deletedAtMs: 1 }])

    const snapshot = getMainThreadActivitySnapshot(startedAtMs)
    const names = [...snapshot.slowest, ...snapshot.pending].map((record) => record.name)
    expect(names).toContain('sqlite:recycle-bin-record-batch-upsert')
  })
})
