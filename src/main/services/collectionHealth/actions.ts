import type {
  CollectionHealthActionFailure,
  CollectionHealthActionResponse,
  CollectionHealthMetadataUpdate,
  CollectionHealthTrackRef
} from '../../../shared/collectionHealth'
import type { ITrackMetadataUpdatePayload } from '../../../types/globals'
import { log } from '../../log'
import { readTrackMetadata, updateTrackMetadata } from '../metadataEditor'
import { updateSongCacheEntry } from '../cacheMaintenance'
import { notifyCollectionHealthTracksChanged, resolveCollectionHealthTrack } from './scan'

type ErrorLike = { message?: unknown; code?: unknown; stderr?: unknown }

const summarizeError = (err: unknown): string => {
  if (err && typeof err === 'object') {
    const error = err as ErrorLike
    if (typeof error.stderr === 'string' && error.stderr.trim()) return error.stderr.trim()
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim()
    if (typeof error.code === 'string' && error.code.trim()) return error.code.trim()
  }
  const text = String(err ?? '').trim()
  return text || 'UNKNOWN'
}

const buildFullPayload = (
  filePath: string,
  album: string,
  detail: NonNullable<Awaited<ReturnType<typeof readTrackMetadata>>>
): ITrackMetadataUpdatePayload => ({
  filePath,
  title: detail.title,
  artist: detail.artist,
  album,
  albumArtist: detail.albumArtist,
  trackNo: detail.trackNo,
  trackTotal: detail.trackTotal,
  discNo: detail.discNo,
  discTotal: detail.discTotal,
  year: detail.year,
  genre: detail.genre,
  composer: detail.composer,
  lyricist: detail.lyricist,
  label: detail.label,
  isrc: detail.isrc,
  comment: detail.comment,
  lyrics: detail.lyrics,
  coverDataUrl: detail.cover?.dataUrl
})

/**
 * 批量统一专辑标签：ffmpeg 重写会清空未指定标签，所以每首都先读完整详情再整份写回；
 * 单首失败只记录，不影响其余曲目。
 */
export async function unifyAlbumTags(
  params: {
    requestId: number
    album: string
    tracks: CollectionHealthTrackRef[]
  },
  onProgress?: (done: number, total: number) => void
): Promise<CollectionHealthActionResponse | null> {
  const targetAlbum = String(params.album ?? '').trim()
  if (!targetAlbum) return null
  const seen = new Set<string>()
  const targets = [] as NonNullable<ReturnType<typeof resolveCollectionHealthTrack>>[]
  for (const ref of params.tracks) {
    const track = resolveCollectionHealthTrack(params.requestId, ref)
    if (!track) continue
    if (seen.has(track.absFilePath.toLowerCase())) continue
    seen.add(track.absFilePath.toLowerCase())
    targets.push(track)
  }
  if (!targets.length) return null

  const failed: CollectionHealthActionFailure[] = []
  const updates: CollectionHealthMetadataUpdate[] = []
  const total = targets.length
  let done = 0
  onProgress?.(0, total)
  for (const track of targets) {
    try {
      const detail = await readTrackMetadata(track.absFilePath)
      if (!detail) {
        failed.push({ filePath: track.absFilePath, error: 'READ_FAILED' })
        continue
      }
      const result = await updateTrackMetadata(
        buildFullPayload(track.absFilePath, targetAlbum, detail)
      )
      track.album = targetAlbum
      updates.push({ song: result.songInfo, oldFilePath: result.renamedFrom })
      try {
        await updateSongCacheEntry(result.songInfo.filePath, result.songInfo, result.renamedFrom)
      } catch (error) {
        log.error('[collection-health] album unify cache update failed', {
          filePath: track.absFilePath,
          error: summarizeError(error)
        })
      }
    } catch (error) {
      failed.push({ filePath: track.absFilePath, error: summarizeError(error) })
    } finally {
      done += 1
      onProgress?.(done, total)
    }
  }

  const snapshot = notifyCollectionHealthTracksChanged(params.requestId)
  if (!snapshot) return null
  return { snapshot, failed, updates }
}
