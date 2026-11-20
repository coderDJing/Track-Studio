import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import { mapBaseTrackLocalToFirstLoopedLocal } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import type { MixtapeTrack } from '@renderer/composables/mixtape/types'
import { resolveMutedIntroOffsetSec } from '@shared/mixtapeChapterText'

const MUTE_EPSILON = 0.0001

/**
 * Resolve the first audible point of a mixtape clip on the global timeline.
 *
 * volumeMuteSegments are base-local seconds (the same coordinate used by
 * playback mute checks and loop mapping, after tempo/master-grid stretch,
 * before loop expansion). This walks that muted prefix, then maps it through
 * mapBaseTrackLocalToFirstLoopedLocal so a looped muted region is not treated
 * as a raw startSec + offset.
 *
 * Returns null when the unlooped base duration is known and the muted prefix
 * covers it, because loop repeats only replay that same muted base audio.
 */
export const resolveMixtapeChapterAudibleEntrySec = (
  track: MixtapeTrack,
  sourceDurationSec: number
): number | null => {
  const startSec = Number.isFinite(Number(track.startSec)) ? Math.max(0, Number(track.startSec)) : 0
  const snapshot = buildTrackRuntimeTempoSnapshot({
    track,
    sourceDurationSec: Math.max(0, Number(sourceDurationSec) || 0)
  })
  const baseDurationSec = Math.max(0, Number(snapshot.baseDurationSec) || 0)
  const muteSegments = normalizeVolumeMuteSegments(track.volumeMuteSegments, baseDurationSec)
  const mutedPrefixSec = resolveMutedIntroOffsetSec(muteSegments)
  if (baseDurationSec > MUTE_EPSILON && mutedPrefixSec >= baseDurationSec - MUTE_EPSILON) {
    return null
  }
  const loopValue =
    Array.isArray(snapshot.timeMapInput.loopSegments) && snapshot.timeMapInput.loopSegments.length
      ? snapshot.timeMapInput.loopSegments
      : snapshot.timeMapInput.loopSegment
  const localOffsetSec = mapBaseTrackLocalToFirstLoopedLocal(
    mutedPrefixSec,
    baseDurationSec,
    loopValue
  )
  return startSec + localOffsetSec
}
