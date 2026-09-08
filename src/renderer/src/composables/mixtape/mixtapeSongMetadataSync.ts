import { normalizeSongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import type { MixtapeRawItem, MixtapeTrack } from '@renderer/composables/mixtape/types'
import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

type ValueRef<T> = {
  value: T
}

type SongGridUpdatedPayload = {
  filePath?: string
  timeBasisOffsetMs?: number
  beatGridMap?: MixtapeTrack['beatGridMap'] | null
}

type SongMetadataSyncContext = {
  tracks: ValueRef<MixtapeTrack[]>
  mixtapeRawItems: ValueRef<MixtapeRawItem[]>
  normalizeMixtapeFilePath: (value: unknown) => string
  normalizeBpm: (value: unknown) => number | null
  normalizeFirstBeatMs: (value: unknown) => number
  normalizeDownbeatBeatOffset: (value: unknown) => number
  refreshMixtapeTrackDerivedUi: () => void
}

const normalizeMixtapeComparePath = (
  ctx: Pick<SongMetadataSyncContext, 'normalizeMixtapeFilePath'>,
  value: string | undefined | null
) =>
  normalizeFilePathForComparison(
    ctx.normalizeMixtapeFilePath(value),
    isCurrentRendererWindowsPathPlatform()
  )

const parseMixtapeRawItemInfoJson = (item: MixtapeRawItem): Record<string, unknown> => {
  if (!item?.infoJson) return {}
  try {
    const parsed = JSON.parse(String(item.infoJson))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const patchMixtapeRawItemsByFilePath = (
  ctx: Pick<SongMetadataSyncContext, 'mixtapeRawItems' | 'normalizeMixtapeFilePath'>,
  filePath: string,
  patch: (info: Record<string, unknown>) => Record<string, unknown> | null
) => {
  const normalizedTargetPath = normalizeMixtapeComparePath(ctx, filePath)
  if (!normalizedTargetPath || ctx.mixtapeRawItems.value.length === 0) return false
  let touched = false
  const nextRawItems = ctx.mixtapeRawItems.value.map((item) => {
    if (normalizeMixtapeComparePath(ctx, item.filePath) !== normalizedTargetPath) return item
    const nextInfo = patch(parseMixtapeRawItemInfoJson(item))
    if (!nextInfo) return item
    const nextInfoJson = JSON.stringify(nextInfo)
    if (String(item.infoJson || '') === nextInfoJson) return item
    touched = true
    return {
      ...item,
      infoJson: nextInfoJson
    }
  })
  if (touched) {
    ctx.mixtapeRawItems.value = nextRawItems
  }
  return touched
}

export const createMixtapeSongMetadataSync = (ctx: SongMetadataSyncContext) => {
  const handleSongKeyUpdated = (
    _e: unknown,
    eventPayload: { filePath?: string; keyText?: string }
  ) => {
    const filePath = ctx.normalizeMixtapeFilePath(eventPayload?.filePath)
    const keyText = typeof eventPayload?.keyText === 'string' ? eventPayload.keyText.trim() : ''
    if (!filePath || !keyText) return
    const normalizedTargetPath = normalizeMixtapeComparePath(ctx, filePath)
    let trackTouched = false
    const nextTracks = ctx.tracks.value.map((track) => {
      if (normalizeMixtapeComparePath(ctx, track.filePath) !== normalizedTargetPath) return track
      const currentKey = typeof track.key === 'string' ? track.key.trim() : ''
      const currentOriginalKey =
        typeof track.originalKey === 'string' ? track.originalKey.trim() : ''
      if (currentKey === keyText && currentOriginalKey) return track
      trackTouched = true
      return {
        ...track,
        key: keyText,
        originalKey: currentOriginalKey || keyText
      }
    })
    if (trackTouched) {
      ctx.tracks.value = nextTracks
    }
    patchMixtapeRawItemsByFilePath(ctx, filePath, (info) => {
      const currentKey = typeof info.key === 'string' ? info.key.trim() : ''
      const currentOriginalKey = typeof info.originalKey === 'string' ? info.originalKey.trim() : ''
      if (currentKey === keyText && currentOriginalKey) return null
      return {
        ...info,
        key: keyText,
        originalKey: currentOriginalKey || keyText
      }
    })
  }

  const handleSongGridUpdated = (_e: unknown, eventPayload: SongGridUpdatedPayload) => {
    const filePath = ctx.normalizeMixtapeFilePath(eventPayload?.filePath)
    if (!filePath) return
    const normalizedTargetPath = normalizeMixtapeComparePath(ctx, filePath)
    const hasTimeBasisOffsetMs =
      typeof eventPayload?.timeBasisOffsetMs === 'number' &&
      Number.isFinite(eventPayload.timeBasisOffsetMs)
    const timeBasisOffsetMs = hasTimeBasisOffsetMs
      ? ctx.normalizeFirstBeatMs(eventPayload?.timeBasisOffsetMs)
      : undefined
    const hasBeatGridMapPayload = Object.prototype.hasOwnProperty.call(eventPayload, 'beatGridMap')
    const nextBeatGridMap = normalizeSongBeatGridMapV2(eventPayload?.beatGridMap, {
      allowSingleClip: true
    })
    const hasBeatGridMap = nextBeatGridMap !== null
    const shouldClearBeatGridMap = hasBeatGridMapPayload && eventPayload?.beatGridMap === null
    if (!hasTimeBasisOffsetMs && !hasBeatGridMapPayload) {
      return
    }
    let trackTouched = false
    const nextTracks = ctx.tracks.value.map((track) => {
      if (normalizeMixtapeComparePath(ctx, track.filePath) !== normalizedTargetPath) return track
      const currentTimeBasisOffsetMs = Number(track.timeBasisOffsetMs)
      const timeBasisOffsetChanged =
        hasTimeBasisOffsetMs &&
        (!Number.isFinite(currentTimeBasisOffsetMs) ||
          Math.abs(currentTimeBasisOffsetMs - Number(timeBasisOffsetMs)) > 0.001)
      const beatGridMapChanged =
        (hasBeatGridMap && track.beatGridMap?.signature !== nextBeatGridMap.signature) ||
        (shouldClearBeatGridMap && track.beatGridMap !== undefined)
      if (!timeBasisOffsetChanged && !beatGridMapChanged) {
        return track
      }
      trackTouched = true
      const nextTrack: MixtapeTrack = {
        ...track,
        ...(hasTimeBasisOffsetMs ? { timeBasisOffsetMs } : {}),
        ...(hasBeatGridMap ? { beatGridMap: nextBeatGridMap } : {})
      }
      if (shouldClearBeatGridMap) {
        delete nextTrack.beatGridMap
      }
      return nextTrack
    })
    if (trackTouched) {
      ctx.tracks.value = nextTracks
    }
    // Mixtape 项目只保留项目局部数据；歌曲网格更新只更新当前内存视图，
    // 不再回写到 item 的 infoJson 形成第二份事实源。
    const rawTouched = false
    if (trackTouched || rawTouched) {
      ctx.refreshMixtapeTrackDerivedUi()
    }
  }

  const handleSongGridBatchUpdated = (_e: unknown, eventPayloads: SongGridUpdatedPayload[]) => {
    if (!Array.isArray(eventPayloads) || eventPayloads.length === 0) return
    const activeTrackPaths = new Set(
      ctx.tracks.value
        .map((track) => normalizeMixtapeComparePath(ctx, track.filePath))
        .filter(Boolean)
    )
    if (activeTrackPaths.size === 0) return
    for (const eventPayload of eventPayloads) {
      const normalizedTargetPath = normalizeMixtapeComparePath(ctx, eventPayload?.filePath)
      if (!normalizedTargetPath || !activeTrackPaths.has(normalizedTargetPath)) continue
      handleSongGridUpdated(undefined, eventPayload)
    }
  }

  return {
    handleSongKeyUpdated,
    handleSongGridUpdated,
    handleSongGridBatchUpdated
  }
}
