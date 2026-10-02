export const COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE = 4800

export type NativeWaveformBitmap = {
  width: number
  height: number
  /** Straight-alpha RGBA pixels in row-major order. Overview data only. */
  rgba: Uint8Array
}

export type CompactVisualWaveformData = {
  version: number
  parameterVersion: number
  duration: number
  sampleRate: number
  detailRate: number
  overviewRate: number
  bodyRateDivisor: number
  colorRateDivisor: number
  detailPeakTop: Uint8Array
  detailPeakBottom: Uint8Array
  detailBody: Uint8Array
  colorIndex: Uint8Array
  colorLow: Uint8Array
  colorMid: Uint8Array
  colorHigh: Uint8Array
  colorRed: Uint8Array
  colorGreen: Uint8Array
  colorBlue: Uint8Array
  overviewTop: Uint8Array
  overviewBottom: Uint8Array
  nativeBitmap?: NativeWaveformBitmap
}
