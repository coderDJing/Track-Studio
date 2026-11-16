/**
 * 整张歌单导入前的体积估算。
 *
 * 只用来给确认框一个量级（「97 首 · 约 3.9GB（lossless）」），
 * 不请求 CDN，也不保证和最终落盘字节数完全一致。
 *
 * 优先用已有时长 × 该档的实测码率/均值；已经下到 `.store` 的用实际文件大小
 * （导入会复用这一份，不会按新档位再压一遍）。
 * 时长缺失时退回草案 9.5 的单曲均值。
 */
import type { NeteaseLevel } from './client'

/** 没有时长时用的单曲均值（草案 9.5） */
export const MEAN_BYTES_BY_LEVEL: Record<NeteaseLevel, number> = {
  jymaster: 77 * 1024 * 1024,
  hires: 40 * 1024 * 1024,
  lossless: 40 * 1024 * 1024,
  exhigh: 11 * 1024 * 1024,
  standard: Math.round(4.4 * 1024 * 1024)
}

/** 按 4 分钟单曲把均值摊成每秒字节，这样有时长的曲子可以按比例估 */
const ASSUMED_MEAN_DURATION_SEC = 240

const BITRATE_BYTES_PER_SEC: Record<NeteaseLevel, number> = {
  // 标准 / 极高是固定码率；无损 / 母带用均值反推
  standard: 128_000 / 8,
  exhigh: 320_000 / 8,
  lossless: MEAN_BYTES_BY_LEVEL.lossless / ASSUMED_MEAN_DURATION_SEC,
  hires: MEAN_BYTES_BY_LEVEL.hires / ASSUMED_MEAN_DURATION_SEC,
  jymaster: MEAN_BYTES_BY_LEVEL.jymaster / ASSUMED_MEAN_DURATION_SEC
}

export type ImportEstimateTrack = {
  songId: string
  durationMs?: number
  /** 已下载且文件还在盘上时的实际字节数；没有就按档位估 */
  actualSizeBytes?: number
}

export type ImportEstimate = {
  trackCount: number
  estimatedBytes: number
  level: NeteaseLevel
}

export function estimateTrackBytes(track: ImportEstimateTrack, level: NeteaseLevel): number {
  const actual = Number(track.actualSizeBytes) || 0
  if (actual > 0) return actual
  const durationMs = Number(track.durationMs) || 0
  if (durationMs > 0) {
    return Math.max(1, Math.round((durationMs / 1000) * BITRATE_BYTES_PER_SEC[level]))
  }
  return MEAN_BYTES_BY_LEVEL[level]
}

export function estimateImportSize(
  tracks: ImportEstimateTrack[],
  level: NeteaseLevel
): ImportEstimate {
  const list = Array.isArray(tracks) ? tracks : []
  let estimatedBytes = 0
  for (const track of list) {
    estimatedBytes += estimateTrackBytes(track, level)
  }
  return {
    trackCount: list.length,
    estimatedBytes,
    level
  }
}

export function formatEstimateBytes(bytes: number): string {
  const value = Number(bytes) || 0
  if (value <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  const raw = size >= 10 || unit === 0 ? String(Math.round(size)) : size.toFixed(1)
  const rounded = raw.endsWith('.0') ? raw.slice(0, -2) : raw
  return `${rounded}${units[unit]}`
}
