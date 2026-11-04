import { createTrackTimeMapFromSnapshotPayload } from './trackTimeMapFactory'
import {
  resolveTransportDynamicTempoSegmentAtLocalSec,
  type TransportDynamicTempoSegment
} from './timelineTransportDynamicTempoSegments'
import type { SerializedTrackTempoSnapshot } from './types'

type TempoEntry = {
  tempoSnapshot: SerializedTrackTempoSnapshot
  dynamicTempoSegments?: TransportDynamicTempoSegment[]
  tempoRatio: number
  originalBpm?: number
}

// Snapshots are immutable and shared by the source nodes; old projects can be collected.
const timeMaps = new WeakMap<
  SerializedTrackTempoSnapshot,
  ReturnType<typeof createTrackTimeMapFromSnapshotPayload>
>()

export const resolveTransportEntryTimeMap = (entry: Pick<TempoEntry, 'tempoSnapshot'>) => {
  const cached = timeMaps.get(entry.tempoSnapshot)
  if (cached) return cached
  const map = createTrackTimeMapFromSnapshotPayload(entry.tempoSnapshot)
  timeMaps.set(entry.tempoSnapshot, map)
  return map
}

export const resolveTransportEntryPlaybackRate = (entry: TempoEntry, localSec: number) => {
  const segment = resolveTransportDynamicTempoSegmentAtLocalSec(
    entry.dynamicTempoSegments,
    localSec
  )
  const sourceBpm = Number(
    segment?.sourceBpm ?? entry.tempoSnapshot.gridSourceBpm ?? entry.originalBpm
  )
  const targetBpm = resolveTransportEntryTimeMap(entry).sampleBpmAtLocal(localSec)
  const rate = sourceBpm > 0 && targetBpm > 0 ? targetBpm / sourceBpm : entry.tempoRatio
  return Math.max(0.25, Math.min(4, Number(rate) || 1))
}
