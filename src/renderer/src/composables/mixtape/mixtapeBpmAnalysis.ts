import type { MixtapeTrack } from '@renderer/composables/mixtape/types'
import {
  RendererFilePathMap,
  RendererFilePathSet,
  rendererFilePathKey
} from '@renderer/utils/filePathComparison'
import { normalizeMixtapeFilePath } from '@renderer/composables/mixtape/mixtapeTrackSnapshot'
import { normalizeSongBeatGridDownbeatBeatOffset } from '@shared/songBeatGridMapV2'

type BpmAnalysisEntry = {
  bpm: number
  firstBeatMs: number
  downbeatBeatOffset?: number
  timeBasisOffsetMs?: number
}

const resolveBpmAnalysisMap = (results: unknown[]) => {
  const analysisMap = new RendererFilePathMap<BpmAnalysisEntry>()
  for (const item of results) {
    const payload =
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as {
            filePath?: unknown
            bpm?: unknown
            firstBeatMs?: unknown
            downbeatBeatOffset?: unknown
            timeBasisOffsetMs?: unknown
          })
        : null
    const filePath = normalizeMixtapeFilePath(payload?.filePath)
    const bpmValue = payload?.bpm
    if (!filePath || typeof bpmValue !== 'number' || !Number.isFinite(bpmValue) || bpmValue <= 0) {
      continue
    }
    const rawFirstBeatMs = Number(payload?.firstBeatMs)
    const firstBeatMs = Number.isFinite(rawFirstBeatMs) ? rawFirstBeatMs : 0
    const downbeatBeatOffset = normalizeSongBeatGridDownbeatBeatOffset(payload?.downbeatBeatOffset)
    const rawTimeBasisOffsetMs = Number(payload?.timeBasisOffsetMs)
    const timeBasisOffsetMs =
      Number.isFinite(rawTimeBasisOffsetMs) && rawTimeBasisOffsetMs >= 0
        ? Number(rawTimeBasisOffsetMs.toFixed(3))
        : undefined
    analysisMap.set(filePath, {
      bpm: bpmValue,
      firstBeatMs,
      downbeatBeatOffset: downbeatBeatOffset ?? undefined,
      timeBasisOffsetMs
    })
  }
  return analysisMap
}

export const buildMixtapeBpmTargets = (tracks: MixtapeTrack[]) => {
  const unique = new RendererFilePathSet()
  const targets: string[] = []
  for (const track of tracks) {
    const filePath = normalizeMixtapeFilePath(track.filePath)
    if (!filePath || unique.has(filePath)) continue
    const bpmValue = Number(track.gridBaseBpm ?? track.originalBpm ?? track.bpm)
    const firstBeatMsValue = Number(track.firstBeatMs)
    const downbeatBeatOffsetValue = Number(track.downbeatBeatOffset)
    const hasValidBpm = Number.isFinite(bpmValue) && bpmValue > 0
    const hasValidFirstBeatMs = Number.isFinite(firstBeatMsValue)
    const hasValidDownbeatBeatOffset = Number.isFinite(downbeatBeatOffsetValue)
    if (hasValidBpm && hasValidFirstBeatMs && hasValidDownbeatBeatOffset) continue
    unique.add(filePath)
    targets.push(filePath)
  }
  return targets
}

export const buildMixtapeBpmTargetKey = (filePaths: string[]) =>
  [...new RendererFilePathSet(filePaths)].map(rendererFilePathKey).sort().join('|')

export const resolveMissingBpmTrackCount = (tracks: MixtapeTrack[], bpmTargets: Set<string>) => {
  if (!bpmTargets.size) return 0
  const targets = new RendererFilePathSet(bpmTargets)
  return tracks.filter((track) => {
    const trackPath = normalizeMixtapeFilePath(track.filePath)
    if (!trackPath || !targets.has(trackPath)) return false
    const bpmValue = Number(track.gridBaseBpm ?? track.originalBpm ?? track.bpm)
    const firstBeatMsValue = Number(track.firstBeatMs)
    const downbeatBeatOffsetValue = Number(track.downbeatBeatOffset)
    const missingBpm = !Number.isFinite(bpmValue) || bpmValue <= 0
    const missingFirstBeat = !Number.isFinite(firstBeatMsValue)
    const missingDownbeatBeatOffset = !Number.isFinite(downbeatBeatOffsetValue)
    return missingBpm || missingFirstBeat || missingDownbeatBeatOffset
  }).length
}

export const applyBpmResultsToTracks = (tracks: MixtapeTrack[], results: unknown[]) => {
  const analysisMap = resolveBpmAnalysisMap(results)
  if (analysisMap.size === 0) {
    return {
      nextTracks: tracks,
      resolvedCount: 0,
      changedCount: 0
    }
  }

  let changedCount = 0
  const nextTracks = tracks.map((track) => {
    const trackPath = normalizeMixtapeFilePath(track.filePath)
    const trackAnalysis = trackPath ? analysisMap.get(trackPath) : undefined
    if (!trackAnalysis) return track
    const currentBpm = Number(track.gridBaseBpm ?? track.originalBpm ?? track.bpm)
    const hasCurrentFirstBeatMs =
      typeof track.firstBeatMs === 'number' && Number.isFinite(track.firstBeatMs)
    const hasCurrentDownbeatBeatOffset =
      typeof track.downbeatBeatOffset === 'number' && Number.isFinite(track.downbeatBeatOffset)
    const currentFirstBeatMs = hasCurrentFirstBeatMs ? Number(track.firstBeatMs) : 0
    const currentDownbeatBeatOffset = hasCurrentDownbeatBeatOffset
      ? Number(track.downbeatBeatOffset)
      : 0
    const currentTimeBasisOffsetMs = Number(track.timeBasisOffsetMs)
    const bpmChanged =
      !Number.isFinite(currentBpm) || Math.abs(trackAnalysis.bpm - currentBpm) > 0.0001
    const firstBeatChanged =
      !hasCurrentFirstBeatMs || Math.abs(trackAnalysis.firstBeatMs - currentFirstBeatMs) > 0.001
    const downbeatBeatOffsetChanged =
      trackAnalysis.downbeatBeatOffset !== undefined &&
      (!hasCurrentDownbeatBeatOffset ||
        trackAnalysis.downbeatBeatOffset !== currentDownbeatBeatOffset)
    const timeBasisOffsetChanged =
      trackAnalysis.timeBasisOffsetMs !== undefined &&
      (!Number.isFinite(currentTimeBasisOffsetMs) ||
        Math.abs(trackAnalysis.timeBasisOffsetMs - currentTimeBasisOffsetMs) > 0.001)
    if (!bpmChanged && !firstBeatChanged && !downbeatBeatOffsetChanged && !timeBasisOffsetChanged) {
      return track
    }
    changedCount += 1
    return {
      ...track,
      // BPM 分析结果代表音频本身的真实原始速度，必须覆盖旧的脏 originalBpm。
      gridBaseBpm: trackAnalysis.bpm,
      originalBpm: trackAnalysis.bpm,
      bpm: trackAnalysis.bpm,
      masterTempo: track.masterTempo !== false,
      firstBeatMs: trackAnalysis.firstBeatMs,
      downbeatBeatOffset: trackAnalysis.downbeatBeatOffset ?? track.downbeatBeatOffset,
      timeBasisOffsetMs: trackAnalysis.timeBasisOffsetMs ?? track.timeBasisOffsetMs
    }
  })

  return {
    nextTracks,
    resolvedCount: analysisMap.size,
    changedCount
  }
}
