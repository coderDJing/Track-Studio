import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDemoAnalysisSeedVersions } from './demoAnalysisSeedVersions'

const SEED_PATH = path.resolve(process.cwd(), 'resources/demoAnalysis/demo-analysis-seed.sqlite')

const describeWithSeed = fs.existsSync(SEED_PATH) ? describe : describe.skip

describeWithSeed('随包示例分析缓存', () => {
  it('meta 版本与当前算法版本完全一致', () => {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(SEED_PATH, { readonly: true, fileMustExist: true })
    try {
      const rows = db
        .prepare<{ key?: unknown; value?: unknown }>('SELECT key, value FROM demo_seed_meta')
        .all()
      const meta: Record<string, number> = {}
      for (const row of rows) {
        meta[String(row.key)] = Number(row.value)
      }
      expect(meta).toEqual(getDemoAnalysisSeedVersions())

      const songCount = db
        .prepare<{ count?: unknown }>('SELECT COUNT(1) AS count FROM demo_song_cache')
        .get()
      expect(Number(songCount?.count)).toBe(3)
    } finally {
      db.close()
    }
  })
})
