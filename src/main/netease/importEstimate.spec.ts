// Run: pnpm exec vitest run src/main/netease/importEstimate.spec.ts
import { describe, expect, it } from 'vitest'
import {
  MEAN_BYTES_BY_LEVEL,
  estimateImportSize,
  estimateTrackBytes,
  formatEstimateBytes
} from './importEstimate'

describe('estimateImportSize', () => {
  it('已下载的曲子用实际文件大小，不按档位再估一遍', () => {
    expect(
      estimateTrackBytes({ songId: '1', durationMs: 240_000, actualSizeBytes: 12_345 }, 'lossless')
    ).toBe(12_345)
  })

  it('有时长时按该档码率/均值估算', () => {
    // 标准档 128kbps：10 秒 = 160000 字节
    expect(estimateTrackBytes({ songId: '1', durationMs: 10_000 }, 'standard')).toBe(160_000)
    // 极高档 320kbps：10 秒 = 400000 字节
    expect(estimateTrackBytes({ songId: '1', durationMs: 10_000 }, 'exhigh')).toBe(400_000)
  })

  it('没有时长时退回草案 9.5 的单曲均值', () => {
    expect(estimateTrackBytes({ songId: '1' }, 'lossless')).toBe(MEAN_BYTES_BY_LEVEL.lossless)
    expect(estimateTrackBytes({ songId: '1', durationMs: 0 }, 'jymaster')).toBe(
      MEAN_BYTES_BY_LEVEL.jymaster
    )
  })

  it('整张歌单把各首加起来，并带上档位', () => {
    const result = estimateImportSize(
      [
        { songId: '1', durationMs: 10_000 },
        { songId: '2', actualSizeBytes: 5_000_000 },
        { songId: '3' }
      ],
      'exhigh'
    )
    expect(result.trackCount).toBe(3)
    expect(result.level).toBe('exhigh')
    expect(result.estimatedBytes).toBe(400_000 + 5_000_000 + MEAN_BYTES_BY_LEVEL.exhigh)
  })

  it('体积文案用 1024 进位，大概齐到一位小数', () => {
    expect(formatEstimateBytes(0)).toBe('0B')
    expect(formatEstimateBytes(1024)).toBe('1KB')
    // 3.9GB：3.9 * 1024^3
    expect(formatEstimateBytes(Math.round(3.9 * 1024 * 1024 * 1024))).toBe('3.9GB')
  })
})
