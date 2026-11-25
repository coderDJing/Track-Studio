import type { ISongInfo } from 'src/types/globals'
import { normalizeSongBeatGridQuality } from '@shared/beatGridQuality'
import { t } from '@renderer/utils/translate'

export type BeatGridQualityBadge = {
  /** 徽标标签；列表里只显示圆点，这个标签用于气泡开头。 */
  badgeText: string
  /** 气泡里的人话说明：说后果和该干什么，不说指标名。 */
  detailText: string
}

/** 1:23 这种形式：网格是可分段出问题的，用户要知道往哪听。 */
const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * 解析歌曲网格的「待检查」徽标。
 *
 * 只有网格本身有问题时才返回；正常网格不占任何位置。
 */
export const resolveBeatGridQualityBadge = (
  song: ISongInfo | null | undefined
): BeatGridQualityBadge | null => {
  const quality = normalizeSongBeatGridQuality(song?.beatGridQuality)
  if (!quality) return null
  // 列表里只有一个圆点，气泡文字必须自带「这是什么」的说明，否则用户
  // 只看到一个颜色，却不知道它代表什么。
  const label = t('tracks.beatGridQualityLabel')
  if (quality.reason === 'degraded') {
    return {
      badgeText: label,
      detailText: `${label} · ${t('tracks.beatGridQualityDegraded')}`
    }
  }
  const sinceSec = quality.sinceSec
  const specific =
    typeof sinceSec === 'number' && sinceSec > 0
      ? t('tracks.beatGridQualityDriftFrom', { time: formatClock(sinceSec) })
      : t('tracks.beatGridQualityDrift')
  return { badgeText: label, detailText: `${label} · ${specific}` }
}

/**
 * 该单元格是否带「待检查」徽标。
 *
 * 徽标只在 BPM 列出现——网格质量本来就属于 BPM/网格这一列的信息范畴，
 * BPM 列被隐藏时徽标也跟着走。
 */
export const hasBeatGridQualityBadge = (
  song: ISongInfo | null | undefined,
  colKey: string
): boolean => colKey === 'bpm' && resolveBeatGridQualityBadge(song) !== null
