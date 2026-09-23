import fs from 'node:fs/promises'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { resolveCanonicalSongBeatGridV2 } from '../../../shared/songAnalysisCompleteness'
import type { IPioneerPlaylistTrack, ISongInfo } from '../../../types/globals'

const EXTERNAL_ANALYSIS_HYDRATE_CONCURRENCY = 8

type ExternalCachedGridInfo = Pick<
  ISongInfo,
  'beatGridMap' | 'beatGridStatus' | 'timeBasisOffsetMs'
>

export const mergeExternalAnalysisIntoBrowserTrack = (
  track: IPioneerPlaylistTrack,
  info: ExternalCachedGridInfo | null | undefined
): IPioneerPlaylistTrack => {
  const grid = resolveCanonicalSongBeatGridV2(info)
  if (grid.kind !== 'grid') return track
  const timeBasisOffsetMs = Number(info?.timeBasisOffsetMs)
  return {
    ...track,
    bpm: grid.bpm,
    beatGridMap: grid.beatGridMap,
    timeBasisOffsetMs:
      Number.isFinite(timeBasisOffsetMs) && timeBasisOffsetMs >= 0
        ? timeBasisOffsetMs
        : track.timeBasisOffsetMs
  }
}

export const hydrateExternalLibraryTracksFromAnalysisCache = async (
  tracks: IPioneerPlaylistTrack[]
) => {
  const hydrated = tracks.map((track) => ({ ...track }))
  let cursor = 0
  const worker = async () => {
    while (cursor < hydrated.length) {
      const index = cursor
      cursor += 1
      const track = hydrated[index]
      const filePath = String(track?.filePath || '').trim()
      if (!track || !filePath) continue
      try {
        const stat = await fs.stat(filePath)
        const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntryByFilePath(filePath, {
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
        hydrated[index] = mergeExternalAnalysisIntoBrowserTrack(track, cached?.info)
      } catch {
        // 文件不可访问或缓存失效时保留 Serato/Traktor 原始 BPM。
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(EXTERNAL_ANALYSIS_HYDRATE_CONCURRENCY, hydrated.length) }, worker)
  )
  return hydrated
}
