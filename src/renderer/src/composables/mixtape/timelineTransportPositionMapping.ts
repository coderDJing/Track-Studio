import { createTrackTimeMapFromSnapshotPayload } from '@renderer/composables/mixtape/trackTimeMapFactory'
import { mapPlaybackSequenceLocalToPlanSec } from '@renderer/composables/mixtape/timelineTransportPlaybackSequence'
import type { TransportEntry } from '@renderer/composables/mixtape/timelineTransportAudioData'

/**
 * Transport 的「源播放位置 ↔ 时间轴秒」坐标换算。
 * 从 timelineTransportAndDrag 抽出：这组函数互为闭合调用图、不依赖 transport 调度状态，
 * 只对传入的 entry / node 做映射运算。
 */

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const resolveEntryPlaybackOffsetSourceSec = (
  entry: TransportEntry,
  sectionTimelineOffsetSec: number
) => {
  const localStartSec = Math.max(0, Number(entry.localStartSec) || 0)
  const sectionOffsetSec = clampNumber(
    Number(sectionTimelineOffsetSec) || 0,
    0,
    Math.max(0, Number(entry.duration) || 0)
  )
  const timeMap = createTrackTimeMapFromSnapshotPayload(entry.tempoSnapshot)
  const sourceOffsetSec = Math.max(0, Number(entry.sourceOffsetSec) || 0)
  const sourceSegmentDuration = Math.max(0, Number(entry.sourceSegmentDuration) || 0)
  const sourceLocalSec = timeMap.mapLocalToSource(localStartSec + sectionOffsetSec)
  return clampNumber(
    Number(sourceLocalSec) || sourceOffsetSec,
    sourceOffsetSec,
    Math.max(sourceOffsetSec, sourceOffsetSec + sourceSegmentDuration)
  )
}

export const resolveEntryPlaybackOffsetPlanSec = (
  entry: TransportEntry,
  sectionTimelineOffsetSec: number
) => {
  if (!entry.playbackSequence?.segments?.length) {
    return resolveEntryPlaybackOffsetSourceSec(entry, sectionTimelineOffsetSec)
  }
  const localStartSec = Math.max(0, Number(entry.localStartSec) || 0)
  const sectionOffsetSec = clampNumber(
    Number(sectionTimelineOffsetSec) || 0,
    0,
    Math.max(0, Number(entry.duration) || 0)
  )
  const baseTimeMap = createTrackTimeMapFromSnapshotPayload({
    ...entry.tempoSnapshot,
    durationSec: entry.tempoSnapshot.baseDurationSec,
    loopSegments: undefined,
    loopSegment: undefined
  })
  return mapPlaybackSequenceLocalToPlanSec({
    localSec: localStartSec + sectionOffsetSec,
    sequence: entry.playbackSequence,
    mapBaseLocalToSource: (localSec: number) => baseTimeMap.mapLocalToSource(localSec)
  })
}
