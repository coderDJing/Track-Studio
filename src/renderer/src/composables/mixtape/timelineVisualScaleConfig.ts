import {
  DEFAULT_LANE_COUNT,
  MIXTAPE_ENVELOPE_PREVIEW_BASE_LANE_HEIGHT,
  MIXTAPE_OVERVIEW_BASE_LANE_HEIGHT,
  normalizeMixtapeLaneCount,
  resolveMixtapeTrackLaneBaseHeight
} from '@renderer/composables/mixtape/constants'

export const TIMELINE_VISUAL_SCALE_MIN = 0.56
export const TIMELINE_VISUAL_SCALE_MAX = 3

const TIMELINE_TRACK_LANE_BORDER_PX = 2
const TIMELINE_TRACK_LANE_GAP_PX = 8
const TIMELINE_TRACK_VERTICAL_PADDING_PX = 20
const ENVELOPE_PREVIEW_LANE_GAP_PX = 2
const ENVELOPE_PREVIEW_LANE_PADDING_Y_PX = 2
const OVERVIEW_LANE_GAP_PX = 6
const OVERVIEW_LANE_PADDING_Y_PX = 8

const resolveTrackSectionBaseHeight = (laneCount: number) =>
  laneCount * (resolveMixtapeTrackLaneBaseHeight(laneCount) + TIMELINE_TRACK_LANE_BORDER_PX) +
  Math.max(0, laneCount - 1) * TIMELINE_TRACK_LANE_GAP_PX +
  TIMELINE_TRACK_VERTICAL_PADDING_PX

const resolveEnvelopeSectionBaseHeight = (laneCount: number) =>
  laneCount * MIXTAPE_ENVELOPE_PREVIEW_BASE_LANE_HEIGHT +
  Math.max(0, laneCount - 1) * ENVELOPE_PREVIEW_LANE_GAP_PX +
  ENVELOPE_PREVIEW_LANE_PADDING_Y_PX

const resolveOverviewSectionBaseHeight = (laneCount: number) =>
  laneCount * MIXTAPE_OVERVIEW_BASE_LANE_HEIGHT +
  Math.max(0, laneCount - 1) * OVERVIEW_LANE_GAP_PX +
  OVERVIEW_LANE_PADDING_Y_PX

export const resolveTimelineScalableBaseHeightByTrackCount = (
  trackCount: number,
  laneCount: number = DEFAULT_LANE_COUNT
) => {
  const resolvedLaneCount = normalizeMixtapeLaneCount(laneCount)
  const hasTracks = Number(trackCount) > 0
  const envelopeSectionHeight = hasTracks ? resolveEnvelopeSectionBaseHeight(resolvedLaneCount) : 0
  return Math.max(
    1,
    resolveTrackSectionBaseHeight(resolvedLaneCount) +
      envelopeSectionHeight +
      resolveOverviewSectionBaseHeight(resolvedLaneCount)
  )
}
