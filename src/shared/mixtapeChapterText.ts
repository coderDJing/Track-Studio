export type MixtapeChapterMuteSegment = {
  startSec?: number
  endSec?: number
}

export type MixtapeChapterTrackInput = {
  startSec?: number
  /**
   * Precomputed audible timeline entry, already mapped through playback
   * (tempo, master grid, and loops). `null` omits the track. When omitted,
   * `startSec` is used as a fallback clip-origin time.
   */
  entrySec?: number | null
  title?: string
  artist?: string
  filePath?: string
}

const MUTE_EPSILON = 0.0001

export const resolveMixtapeChapterTitle = (track: MixtapeChapterTrackInput): string => {
  const title = String(track.title || '').trim()
  if (title) return title
  const filePath = String(track.filePath || '')
  const fileName = filePath.split(/[\\/]/).pop() || ''
  const stem = fileName.replace(/\.[^.]+$/, '').trim()
  return stem || 'Track'
}

export const formatMixtapeChapterTimestamp = (sec: number): string => {
  const safe = Number.isFinite(sec) ? Math.max(0, Math.round(sec)) : 0
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const paddedSeconds = String(seconds).padStart(2, '0')
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
  }
  return `${minutes}:${paddedSeconds}`
}

export const formatMixtapeChapterLine = (
  timestamp: string,
  title: string,
  artist: string
): string => {
  const name = artist ? `${title} - ${artist}` : title
  return `${timestamp} ${name}`
}

export const resolveMutedIntroOffsetSec = (
  segments: MixtapeChapterMuteSegment[] | undefined
): number => {
  if (!Array.isArray(segments) || !segments.length) return 0
  const normalized = segments
    .map((segment) => ({
      startSec: Number(segment?.startSec),
      endSec: Number(segment?.endSec)
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.startSec) &&
        Number.isFinite(segment.endSec) &&
        segment.endSec > Math.max(0, segment.startSec) + MUTE_EPSILON
    )
    .map((segment) => ({
      startSec: Math.max(0, segment.startSec),
      endSec: segment.endSec
    }))
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec)
  if (!normalized.length) return 0

  let coveredUntil = 0
  for (const segment of normalized) {
    if (segment.startSec > coveredUntil + MUTE_EPSILON) break
    if (segment.endSec > coveredUntil) coveredUntil = segment.endSec
  }
  return coveredUntil
}

export const resolveMixtapeChapterEntrySec = (track: MixtapeChapterTrackInput): number | null => {
  if (track.entrySec === null) return null
  const raw = Number(track.entrySec ?? track.startSec)
  return Number.isFinite(raw) ? Math.max(0, raw) : 0
}

export const buildMixtapeChapterText = (tracks: MixtapeChapterTrackInput[]): string => {
  const rows = tracks
    .map((track, index) => {
      const entrySec = resolveMixtapeChapterEntrySec(track)
      if (entrySec === null) return null
      return {
        entrySec,
        order: index,
        title: resolveMixtapeChapterTitle(track),
        artist: String(track.artist || '').trim()
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => left.entrySec - right.entrySec || left.order - right.order)

  return rows
    .map((row, index) => {
      const sec = index === 0 ? 0 : Math.max(0, row.entrySec)
      return formatMixtapeChapterLine(formatMixtapeChapterTimestamp(sec), row.title, row.artist)
    })
    .join('\n')
}
