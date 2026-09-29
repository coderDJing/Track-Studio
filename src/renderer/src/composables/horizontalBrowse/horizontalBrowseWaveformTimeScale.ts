const REFERENCE_BPM = 120

// The two decks share a zoom value. Keep a beat the same width on both decks;
// playback rate then determines how quickly those beats pass the playhead.
export const resolveHorizontalBrowseWaveformTimeScale = (gridBpm: unknown) => {
  const bpm = Number(gridBpm)
  if (!Number.isFinite(bpm) || bpm <= 0) return 1
  return Math.max(0.25, REFERENCE_BPM / bpm)
}
