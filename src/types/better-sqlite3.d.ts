declare module 'better-sqlite3' {
  namespace BetterSqlite3 {
    interface RunResult {
      changes: number
      lastInsertRowid: number | bigint
    }

    interface Statement<TResult = Record<string, unknown>> {
      run(...params: unknown[]): RunResult
      get(...params: unknown[]): TResult | undefined
      all(...params: unknown[]): TResult[]
      iterate(...params: unknown[]): IterableIterator<TResult>
      pluck(toggleState?: boolean): Statement<TResult>
    }

    interface Transaction<T extends (...args: unknown[]) => unknown> {
      (...args: Parameters<T>): ReturnType<T>
      default(...args: Parameters<T>): ReturnType<T>
      deferred(...args: Parameters<T>): ReturnType<T>
      immediate(...args: Parameters<T>): ReturnType<T>
      exclusive(...args: Parameters<T>): ReturnType<T>
    }

    interface Database {
      readonly name: string
      readonly memory: boolean
      readonly inTransaction: boolean
      prepare<TResult = Record<string, unknown>>(source: string): Statement<TResult>
      transaction<T extends (...args: unknown[]) => unknown>(fn: T): Transaction<T>
      pragma(source: string, options: { simple: true }): unknown
      pragma(source: string, options?: { simple?: boolean }): unknown
      exec(source: string): this
      close(): void
    }
  }

  interface DatabaseConstructor {
    new (filename: string, options?: Record<string, unknown>): BetterSqlite3.Database
  }

  const Database: DatabaseConstructor
  export = Database
}
