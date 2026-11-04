import { normalizeSongHotCues } from '@shared/hotCues'
import { resolveSongCueTimelineSec } from '@shared/songCueTimeBasis'
import { normalizeSongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import type { MixtapeArrangementSnapshot } from '@shared/mixtapeArrangement'
import { buildTrackRuntimeTempoSnapshot } from './trackRuntimeTempoSnapshot'
import { createTrackTimeMap } from './trackTimeMapFactory'
import { buildMixtapeTrackLoopSections } from './mixtapeTrackLoop'
import type { MixtapeTrack } from './types'

export type CueBoundary = number | 'start' | 'end'
export type MixtapeCueOverlapSettings = { startCue: CueBoundary; endCue: CueBoundary; bpm: number }
export type MixtapeCueOverlapRow = {
  id: string
  title: string
  startSec: number
  durationSec: number
  inSec: number
  outSec: number
  missingStart: boolean
  missingEnd: boolean
  error: 'duration' | 'grid' | 'cueOrder' | 'negativeStart' | null
}
export type MixtapeCueOverlapPlan = {
  rows: MixtapeCueOverlapRow[]
  valid: boolean
  missingStartCount: number
  missingEndCount: number
  snapshot: MixtapeArrangementSnapshot
}

export const isCueBoundarySlot = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) < 8

export const buildMixtapeCueOverlapPlan = (params: {
  tracks: MixtapeTrack[]
  settings: MixtapeCueOverlapSettings
  resolveSourceDuration: (track: MixtapeTrack) => number
}): MixtapeCueOverlapPlan => {
  const { settings } = params
  const bpm = Number(settings.bpm)
  const settingsValid =
    Number.isFinite(bpm) &&
    bpm > 1 &&
    bpm <= 999 &&
    (settings.startCue === 'start' || isCueBoundarySlot(settings.startCue)) &&
    (settings.endCue === 'end' || isCueBoundarySlot(settings.endCue)) &&
    !(isCueBoundarySlot(settings.startCue) && settings.startCue === settings.endCue)
  const ordered = params.tracks
    .map((track, index) => ({ track, index }))
    .sort(
      (a, b) =>
        (Number(a.track.mixOrder) || a.index + 1) - (Number(b.track.mixOrder) || b.index + 1)
    )
  const rows: MixtapeCueOverlapRow[] = []
  if (settingsValid)
    for (const { track } of ordered) {
      const sourceDurationSec = params.resolveSourceDuration(track)
      const sourceBpm = Number(track.gridBaseBpm ?? track.originalBpm ?? track.bpm)
      const row: MixtapeCueOverlapRow = {
        id: track.id,
        title: track.title,
        startSec: 0,
        durationSec: 0,
        inSec: 0,
        outSec: 0,
        missingStart: false,
        missingEnd: false,
        error: null
      }
      if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) row.error = 'duration'
      else if (
        !Number.isFinite(sourceBpm) ||
        sourceBpm <= 1 ||
        !normalizeSongBeatGridMapV2(track.beatGridMap, { allowSingleClip: true })
      )
        row.error = 'grid'
      else {
        // 预览使用独立的平坦主 BPM，不改动当前工程的主 BPM 状态。
        const points = [
          { sec: 0, bpm },
          { sec: Math.max(1, sourceDurationSec), bpm }
        ]
        const basis = buildTrackRuntimeTempoSnapshot({
          track: { ...track, bpm, startSec: 0 },
          sourceDurationSec,
          rawPoints: points
        })
        const input = {
          ...basis.timeMapInput,
          mappingMode: 'masterGrid' as const,
          trackStartSec: 0,
          masterGridPoints: points,
          masterGridPhaseOffsetSec: 0,
          masterGridFallbackBpm: bpm
        }
        const timeMap = createTrackTimeMap(input)
        const baseMap = createTrackTimeMap({
          ...input,
          loopSegments: undefined,
          loopSegment: undefined
        })
        const sections = buildMixtapeTrackLoopSections(
          baseMap.durationSec,
          track.loopSegments ?? track.loopSegment
        )
        const cues = normalizeSongHotCues(track.hotCues)
        const snapPoint = (map: typeof timeMap, sec: number) => {
          const line = map.resolveNearestGridLine(sec, Number.POSITIVE_INFINITY)
          if (!line) return sec
          // 音频边界可能位于两拍之间，最近一拍也可能刚好落在文件范围外。
          // 保留该虚拟拍点（没有裁切/移动音频），通过工程起点对齐真实拍线。
          const beatSec = 60 / bpm
          return Number((line.sec + Math.round((sec - line.sec) / beatSec) * beatSec).toFixed(4))
        }
        const resolveCue = (boundary: CueBoundary, end: boolean) => {
          const cue = isCueBoundarySlot(boundary)
            ? cues.find((item) => item.slot === boundary)
            : undefined
          if (!cue)
            return {
              sec: snapPoint(timeMap, end ? timeMap.durationSec : 0),
              missing: typeof boundary === 'number'
            }
          const timelineSec = resolveSongCueTimelineSec(cue.sec, cue, track.timeBasisOffsetMs) ?? 0
          const sourceSec = Math.max(
            0,
            timelineSec - Math.max(0, Number(track.timeBasisOffsetMs) || 0) / 1000
          )
          if (sourceSec > sourceDurationSec + 0.0001) {
            row.error = 'cueOrder'
            return { sec: 0, missing: false }
          }
          // 先在未展开 Loop 的拍线上吸附，再选择首/末次出现的位置。
          const baseSec = snapPoint(baseMap, baseMap.mapSourceToLocal(sourceSec))
          const occurrences = sections.flatMap((section, index) => {
            const finalEnd =
              index === sections.length - 1 && Math.abs(baseSec - baseMap.durationSec) <= 0.0001
            return baseSec >= section.baseStartSec - 0.0001 &&
              (baseSec < section.baseEndSec - 0.0001 || finalEnd)
              ? [section.displayStartSec + baseSec - section.baseStartSec]
              : []
          })
          return {
            sec:
              (end ? occurrences.at(-1) : occurrences[0]) ??
              (baseSec < 0 ? baseSec : timeMap.durationSec + baseSec - baseMap.durationSec),
            missing: false
          }
        }
        const start = resolveCue(settings.startCue, false),
          end = resolveCue(settings.endCue, true)
        row.inSec = start.sec
        row.outSec = end.sec
        row.durationSec = timeMap.durationSec
        row.missingStart = start.missing
        row.missingEnd = end.missing
        if (end.sec <= start.sec + 0.0001) row.error = 'cueOrder'
      }
      const previous = rows.at(-1)
      row.startSec = Number(
        (previous
          ? previous.startSec + previous.outSec - row.inSec
          : Math.max(0, Number(track.startSec) || 0)
        ).toFixed(4)
      )
      if (row.startSec < 0 && !row.error) row.error = 'negativeStart'
      rows.push(row)
    }
  const duration = Number(
    Math.max(1, ...rows.map((row) => row.startSec + row.durationSec)).toFixed(4)
  )
  return {
    rows,
    valid: settingsValid && rows.length >= 2 && rows.every((row) => !row.error),
    missingStartCount: rows.filter((row) => row.missingStart).length,
    missingEndCount: rows.filter((row) => row.missingEnd).length,
    snapshot: {
      entries: rows.map((row) => ({ itemId: row.id, startSec: row.startSec })),
      bpmEnvelope: [
        { sec: 0, bpm },
        { sec: duration, bpm }
      ],
      bpmEnvelopeDurationSec: duration,
      gridPhaseOffsetSec: 0
    }
  }
}

export const formatCueOverlapTime = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export const formatCueOverlapPointTime = (seconds: number) => {
  const totalMs = Math.round(Math.abs(seconds) * 1000)
  const totalSec = Math.floor(totalMs / 1000)
  return `${seconds < 0 && totalMs > 0 ? '−' : ''}${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}.${String(totalMs % 1000).padStart(3, '0')}`
}
