export type HorizontalBrowseLoopClockRange = {
  startSec: number
  endSec: number
}

const resolveLoopDurationSec = (range: HorizontalBrowseLoopClockRange | null | undefined) => {
  if (!range || !Number.isFinite(range.startSec) || !Number.isFinite(range.endSec)) return 0
  const durationSec = range.endSec - range.startSec
  return range.startSec >= 0 && durationSec > 0.0001 ? durationSec : 0
}

export const resolveHorizontalBrowseLoopPlaybackSeconds = (
  seconds: number,
  range: HorizontalBrowseLoopClockRange | null | undefined
) => {
  const durationSec = resolveLoopDurationSec(range)
  if (!range || !durationSec || !Number.isFinite(seconds)) return seconds
  if (seconds < range.startSec) return range.startSec
  if (seconds < range.endSec) return seconds
  return range.startSec + ((seconds - range.startSec) % durationSec)
}

export const resolveHorizontalBrowseLoopClockDriftSec = (
  leftSec: number,
  rightSec: number,
  range: HorizontalBrowseLoopClockRange | null | undefined
) => {
  const driftSec = Math.abs(leftSec - rightSec)
  const durationSec = resolveLoopDurationSec(range)
  if (
    !range ||
    !durationSec ||
    leftSec < range.startSec ||
    leftSec >= range.endSec ||
    rightSec < range.startSec ||
    rightSec >= range.endSec
  ) {
    return driftSec
  }
  return Math.min(driftSec, durationSec - driftSec)
}
