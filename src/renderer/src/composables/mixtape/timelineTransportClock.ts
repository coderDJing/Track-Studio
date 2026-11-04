// Playback, automation and playhead use the same scheduled output clock.
// Worklet input cursors and delayed position messages cannot re-anchor the arrangement.
export const resolveTransportClockSec = (
  contextTimeSec: number,
  scheduledStartSec: number,
  timelineStartSec: number
) => timelineStartSec + Math.max(0, contextTimeSec - scheduledStartSec)
