import fs from 'node:fs'
import path from 'node:path'
export type UsbOneLibraryRow = Record<string, unknown>
// 包自身 exports 未公开 types；在边界声明实际使用的最小 API，避免 any。
export type UsbOneLibraryDatabase = {
  pragma: (sql: string, options?: { simple?: boolean }) => unknown
  prepare: <Params extends unknown[] = unknown[], Row = UsbOneLibraryRow>(
    sql: string
  ) => {
    get: (...params: Params) => Row | undefined
    all: (...params: Params) => Row[]
    run: (...params: Params) => { changes: number; lastInsertRowid: number | bigint }
  }
  exec: (sql: string) => unknown
  transaction: (callback: () => void) => { (): void; immediate: () => void }
  close: () => unknown
}
export type UsbOneLibraryDatabaseConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }
) => UsbOneLibraryDatabase
export type UsbOneLibraryColumn = {
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

// Pioneer 设备数据库的公开互操作密钥，与 FRKB 配置/用户凭据无关。
export const USB_ONE_LIBRARY_KEY =
  'r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls'

export const quoteUsbSqlIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`

export function openUsbOneLibraryDatabase(
  databasePath: string,
  readonly: boolean
): UsbOneLibraryDatabase {
  const header = Buffer.alloc(16)
  const fd = fs.openSync(databasePath, 'r')
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) {
      throw new Error('OneLibrary 数据库文件不完整')
    }
    if (header.equals(Buffer.from('SQLite format 3\0'))) {
      throw new Error('OneLibrary 必须保持 SQLCipher 加密，拒绝写入明文数据库')
    }
  } finally {
    fs.closeSync(fd)
  }
  const Constructor = require('better-sqlite3-multiple-ciphers') as UsbOneLibraryDatabaseConstructor
  let lastError: unknown
  // 匹配现有读取链路；每次仅解锁已有文件，不 rekey、不迁移 cipher profile。
  for (const legacy of [null, 4]) {
    const db = new Constructor(databasePath, { readonly, fileMustExist: true, timeout: 5000 })
    try {
      db.pragma("cipher = 'sqlcipher'")
      if (legacy !== null) db.pragma(`legacy = ${legacy}`)
      db.pragma(`key = '${USB_ONE_LIBRARY_KEY}'`)
      db.prepare('SELECT count(*) FROM sqlite_master').get()
      db.pragma('foreign_keys = ON')
      db.pragma('busy_timeout = 5000')
      return db
    } catch (error) {
      lastError = error
      db.close()
    }
  }
  throw new Error(
    `无法解锁 OneLibrary: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

export function assertUsbOneLibraryStagedCopy(databasePath: string, rootPath: string): void {
  const actual = fs.realpathSync(databasePath)
  const canonical = path.join(fs.realpathSync(rootPath), 'PIONEER', 'rekordbox', 'exportLibrary.db')
  const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  if (
    key(actual) === key(canonical) ||
    (fs.existsSync(canonical) && key(actual) === key(fs.realpathSync(canonical)))
  ) {
    throw new Error('OneLibrary 写入适配器只能修改暂存副本')
  }
  if (fs.statSync(actual).nlink !== 1) throw new Error('OneLibrary 暂存文件不能是硬链接')
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${actual}${suffix}`
    if (!fs.existsSync(sidecar)) continue
    const stat = fs.lstatSync(sidecar)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('OneLibrary 暂存 SQLite sidecar 不能是链接或非普通文件')
    }
    if (suffix === '-journal' || (suffix === '-wal' && stat.size > 0)) {
      throw new Error(`OneLibrary 暂存副本存在未合并的 SQLite ${suffix} 文件`)
    }
  }
}

export const usbOneLibraryRows = (
  db: UsbOneLibraryDatabase,
  sql: string,
  ...params: unknown[]
): UsbOneLibraryRow[] => db.prepare<unknown[], UsbOneLibraryRow>(sql).all(...params)

export function usbOneLibrarySchema(db: UsbOneLibraryDatabase): Map<string, UsbOneLibraryColumn[]> {
  const tables = usbOneLibraryRows(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  )
  return new Map(
    tables.map((table) => {
      const name = String(table.name)
      const columns = db
        .prepare<[], UsbOneLibraryColumn>(`PRAGMA table_info(${quoteUsbSqlIdentifier(name)})`)
        .all()
      return [name, columns]
    })
  )
}

export function requireUsbOneLibraryColumns(
  schema: Map<string, UsbOneLibraryColumn[]>,
  table: string,
  required: string[]
): void {
  const columns = schema.get(table)
  if (
    !columns ||
    required.some(
      (name) => !columns.some((column) => column.name.toLowerCase() === name.toLowerCase())
    )
  ) {
    throw new Error(`不支持的 OneLibrary 表结构: ${table} (${required.join(', ')})`)
  }
}

export function validateUsbOneLibraryIntegrity(db: UsbOneLibraryDatabase): void {
  const integrity = usbOneLibraryRows(db, 'PRAGMA integrity_check')
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
    throw new Error('OneLibrary 数据库完整性检查失败')
  }
  if (usbOneLibraryRows(db, 'PRAGMA foreign_key_check').length) {
    throw new Error('OneLibrary 外键检查失败')
  }
}
