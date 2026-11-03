import {
  formatSongHotCueTime,
  normalizeSongHotCues,
  resolveSongHotCueDisplayColor,
  resolveSongHotCueDisplayLabel
} from '@shared/hotCues'
import { normalizeSongMemoryCues, resolveSongMemoryCueDisplayColor } from '@shared/memoryCues'
import { resolveSongCueTimelineSec } from '@shared/songCueTimeBasis'
import { buildTrackRuntimeTempoSnapshot } from './trackRuntimeTempoSnapshot'
import { createTrackTimeMap } from './trackTimeMapFactory'
import { buildMixtapeTrackLoopSections } from './mixtapeTrackLoop'
import { resolveRoundedTrackLocalPx } from './timelinePixelMath'
import type { MixtapeTrack } from './types'
import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'

export type MixtapeTrackCueMarker = {
  key: string
  kind: 'hot' | 'memory'
  label: string
  color: string
  title: string
  localSec: number
  leftPx: number
  hotCue?: ISongHotCue
  memoryCue?: ISongMemoryCue
}

export const buildMixtapeTrackCueMarkers = (params: {
  track: MixtapeTrack
  sourceDurationSec: number
  pxPerSec: number
}): MixtapeTrackCueMarker[] => {
  const { track, sourceDurationSec, pxPerSec } = params
  if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) return []
  const hotCues = normalizeSongHotCues(track.hotCues)
  const memoryCues = normalizeSongMemoryCues(track.memoryCues)
  if (!hotCues.length && !memoryCues.length) return []
  const snapshot = buildTrackRuntimeTempoSnapshot({ track, sourceDurationSec })
  // 先映射到未重复的轨道时间，再按 Loop 的播放区段展开，不能只画首次出现的位置。
  const baseMap = createTrackTimeMap({
    ...snapshot.timeMapInput,
    loopSegments: undefined,
    loopSegment: undefined
  })
  const sections = buildMixtapeTrackLoopSections(
    snapshot.baseDurationSec,
    track.loopSegments ?? track.loopSegment
  )
  const offsetSec = Math.max(0, Number(track.timeBasisOffsetMs) || 0) / 1000
  const markers: MixtapeTrackCueMarker[] = []
  const cues = [
    ...hotCues.map((cue) => ({
      cue,
      kind: 'hot' as const,
      label: resolveSongHotCueDisplayLabel(cue),
      color: resolveSongHotCueDisplayColor(cue)
    })),
    ...memoryCues.map((cue, index) => ({
      cue,
      kind: 'memory' as const,
      label: `M${index + 1}`,
      color: resolveSongMemoryCueDisplayColor(cue)
    }))
  ]
  cues.forEach(({ cue, kind, label, color }, cueIndex) => {
    const timelineSec = resolveSongCueTimelineSec(cue.sec, cue, track.timeBasisOffsetMs)
    if (timelineSec === null) return
    const sourceSec = Math.max(0, timelineSec - offsetSec)
    if (sourceSec > sourceDurationSec + 0.0001) return
    const baseSec = baseMap.mapSourceToLocal(sourceSec)
    sections.forEach((section, sectionIndex) => {
      // 区段右端属于下一段；Loop 结束处不能额外画到下一次重复的起点。
      const isTrackEnd =
        sectionIndex === sections.length - 1 &&
        Math.abs(baseSec - snapshot.baseDurationSec) <= 0.0001
      if (
        baseSec < section.baseStartSec - 0.0001 ||
        (baseSec >= section.baseEndSec - 0.0001 && !isTrackEnd)
      )
        return
      const localSec = section.displayStartSec + baseSec - section.baseStartSec
      markers.push({
        key: `${kind}-${cueIndex}-${sectionIndex}`,
        kind,
        label,
        color,
        hotCue: kind === 'hot' ? cue : undefined,
        memoryCue: kind === 'memory' ? cue : undefined,
        title: [
          kind === 'hot' ? `Hot Cue ${label}` : `Memory Cue ${label}`,
          formatSongHotCueTime(cue.sec),
          cue.isLoop ? 'Loop' : '',
          cue.comment
        ]
          .filter(Boolean)
          .join(' · '),
        localSec,
        leftPx: resolveRoundedTrackLocalPx({
          trackStartSec: Number(track.startSec) || 0,
          localSec,
          pxPerSec
        })
      })
    })
  })
  return markers.sort((left, right) => left.localSec - right.localSec)
}
