import type { ISongInfo } from '../../types/globals'

export type SongCacheWriteDecision = {
  info: ISongInfo | null
  reason?: string
}

export type SongCacheWriteOptions = {
  /** 代次检查；在同步事务内再次执行。 */
  shouldPersist?: () => boolean
  /** 在 migration 之后、实际 DB 事务内读取最新 entry 并决定写什么。 */
  decide?: (context: {
    info: ISongInfo | null
    size: number | null
    mtimeMs: number | null
  }) => SongCacheWriteDecision
  /** 跳过的原因（unchanged/manual/stale/generation）；DB 错误不会写。 */
  result?: { reason?: string }
}
