// Run: pnpm exec vitest run src/shared/netease.spec.ts
import { describe, expect, it } from 'vitest'
import {
  buildNeteasePendingPath,
  isNeteasePendingPath,
  parseNeteasePendingSongId,
  parseNeteaseSongId,
  isNeteasePreviewUrl
} from './netease'

describe('netease pending path', () => {
  it('用没有斜杠的占位路径表示待下载的 SET 条目，避免被当成磁盘路径', () => {
    expect(buildNeteasePendingPath('1901371647')).toBe('netease-pending:1901371647')
    expect(isNeteasePendingPath('netease-pending:1901371647')).toBe(true)
    expect(parseNeteasePendingSongId('netease-pending:1901371647')).toBe('1901371647')
    expect(isNeteasePendingPath('frkb-preview://?netease=1901371647')).toBe(false)
    expect(isNeteasePreviewUrl('netease-pending:1901371647')).toBe(false)
    expect(parseNeteaseSongId('netease-pending:1901371647')).toBeNull()
    expect(parseNeteasePendingSongId('')).toBeNull()
  })
})
