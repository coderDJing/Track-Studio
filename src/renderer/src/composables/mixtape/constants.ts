const MIXTAPE_TRACK_UI_SCALE = 1.5
export const MIXTAPE_BASE_TRACK_LANE_HEIGHT = Math.round(
  Math.max(28, 36) * 4 * MIXTAPE_TRACK_UI_SCALE
)
export const MIXTAPE_ENVELOPE_PREVIEW_BASE_LANE_HEIGHT = 63
export const MIXTAPE_OVERVIEW_BASE_LANE_HEIGHT = 12
// 展开到 4 轨时把包络预览与概览压薄，把省下的高度让给泳道区。
export const MIXTAPE_ENVELOPE_PREVIEW_COMPACT_LANE_HEIGHT = 44
export const MIXTAPE_OVERVIEW_COMPACT_LANE_HEIGHT = 8
export const BASE_PX_PER_SEC = 80
export const MIXTAPE_WIDTH_SCALE = 0.1 * MIXTAPE_TRACK_UI_SCALE
export const MIN_TRACK_WIDTH = Math.max(6, Math.round(60 * MIXTAPE_WIDTH_SCALE))
export const FALLBACK_TRACK_WIDTH = Math.max(12, Math.round(120 * MIXTAPE_WIDTH_SCALE))
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 20
export const ZOOM_STEP = 0.1
export const RENDER_ZOOM_STEP = 0.05
export const WHEEL_ZOOM_BASE_STEP = 1.5
export const WHEEL_ZOOM_RATIO_STEP = 0.025
export const WHEEL_ZOOM_MAX_STEP = 0.3
export const WHEEL_MAX_STEPS_PER_FRAME = 2
export const WHEEL_LINE_HEIGHT_PX = 16
export const LANE_GAP = 8
export const DEFAULT_LANE_COUNT = 2
export const MAX_LANE_COUNT = 4

// 泳道数只允许在默认值与上限之间切换；其余值一律回落到默认值。
export const normalizeMixtapeLaneCount = (value: unknown): number => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_LANE_COUNT
  return Math.floor(numeric) >= MAX_LANE_COUNT ? MAX_LANE_COUNT : DEFAULT_LANE_COUNT
}

// 展开到 4 轨时压缩单轨高度，保证轨道区总高度与双轨一致，不把时间线撑出视口。
export const resolveMixtapeTrackLaneBaseHeight = (laneCount: unknown): number => {
  const resolvedCount = normalizeMixtapeLaneCount(laneCount)
  return Math.max(
    1,
    Math.round((MIXTAPE_BASE_TRACK_LANE_HEIGHT * DEFAULT_LANE_COUNT) / resolvedCount)
  )
}

// 包络预览/概览的每泳道基准高度：四轨时压薄，把高度让给泳道区。
export const resolveMixtapeEnvelopePreviewLaneBaseHeight = (laneCount: unknown): number =>
  normalizeMixtapeLaneCount(laneCount) >= MAX_LANE_COUNT
    ? MIXTAPE_ENVELOPE_PREVIEW_COMPACT_LANE_HEIGHT
    : MIXTAPE_ENVELOPE_PREVIEW_BASE_LANE_HEIGHT

export const resolveMixtapeOverviewLaneBaseHeight = (laneCount: unknown): number =>
  normalizeMixtapeLaneCount(laneCount) >= MAX_LANE_COUNT
    ? MIXTAPE_OVERVIEW_COMPACT_LANE_HEIGHT
    : MIXTAPE_OVERVIEW_BASE_LANE_HEIGHT

export const normalizeMixtapeLaneIndex = (
  value: unknown,
  fallback: unknown = 0,
  laneCount: unknown = MAX_LANE_COUNT
) => {
  const numeric = Number(value)
  const fallbackNumeric = Number(fallback)
  const resolved = Number.isFinite(numeric)
    ? numeric
    : Number.isFinite(fallbackNumeric)
      ? fallbackNumeric
      : 0
  const safeLaneCount = Math.max(1, Math.floor(Number(laneCount) || MAX_LANE_COUNT))
  return Math.max(0, Math.min(safeLaneCount - 1, Math.floor(resolved)))
}

// 取“存起来的”泳道号（0..MAX-1），不按当前可见泳道数夹取。
// 只有算显示泳道时才需要区分两者：先拿原始值，再交给折叠逻辑决定显示在哪。
export const resolveMixtapeStoredLaneIndex = (value: unknown, fallbackIndex = 0) =>
  normalizeMixtapeLaneIndex(
    value,
    Math.max(0, Math.floor(Number(fallbackIndex) || 0)) % DEFAULT_LANE_COUNT
  )
export const LANE_PADDING_TOP = 10
export const TIMELINE_SIDE_PADDING_PX = 18
export const TIMELINE_END_EXTENSION_PX = 120
export const MIXTAPE_WAVEFORM_Y_OFFSET = 1
export const PRE_RENDER_RANGE_BUFFER = 1.2
export const SHOW_GRID_LINES = true
export const GRID_DETAIL_SPLIT_MIN_ZOOM = ZOOM_MIN
export const GRID_DETAIL_SPLIT_MAX_ZOOM = ZOOM_MAX
const GRID_DETAIL_SPLIT_SPAN = Math.max(0, GRID_DETAIL_SPLIT_MAX_ZOOM - GRID_DETAIL_SPLIT_MIN_ZOOM)
export const GRID_DOWNBEAT_LINE_ZOOM = 3
export const GRID_BEAT_LINE_ZOOM = GRID_DETAIL_SPLIT_MIN_ZOOM + (GRID_DETAIL_SPLIT_SPAN * 2) / 3
export const GRID_BAR_WIDTH_MIN = 1.6
export const GRID_BAR_WIDTH_MAX = 2.6
const GRID_BAR_WIDTH_MAX_ZOOM = 1.2
export const GRID_BEAT4_LINE_WIDTH = 1.8
export const GRID_BEAT_LINE_WIDTH = 1.3
export const MIXTAPE_WAVEFORM_HEIGHT_SCALE = 0.72
export const MIXTAPE_WAVEFORM_SUPERSAMPLE = 2
export const RAW_WAVEFORM_TARGET_RATE = 2400
export const RAW_WAVEFORM_MIN_ZOOM = ZOOM_MIN
export const MIXTAPE_SUMMARY_ZOOM = 0
export const WAVEFORM_TILE_WIDTH = 1200
export const RENDER_X_BUFFER_PX = WAVEFORM_TILE_WIDTH
export const WAVEFORM_BATCH_SIZE = 6
export const RAW_WAVEFORM_BATCH_SIZE = 3

export const resolveTimelineGridBarWidth = (zoomValue: number) => {
  const safeZoom = Number.isFinite(zoomValue) ? zoomValue : 1
  const minZoom = ZOOM_MIN
  const maxZoom = GRID_BAR_WIDTH_MAX_ZOOM
  if (safeZoom <= minZoom) return GRID_BAR_WIDTH_MIN
  if (safeZoom >= maxZoom) return GRID_BAR_WIDTH_MAX
  const ratio = (safeZoom - minZoom) / Math.max(0.0001, maxZoom - minZoom)
  return GRID_BAR_WIDTH_MIN + (GRID_BAR_WIDTH_MAX - GRID_BAR_WIDTH_MIN) * ratio
}
