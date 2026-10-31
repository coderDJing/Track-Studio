import {
  UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
  UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
  type UnifiedDisplayWaveformDetailData
} from '../../../shared/unifiedDisplayWaveform'

export const createPackageWaveformFixture = (seed = 1): UnifiedDisplayWaveformDetailData => {
  const bytes = (length: number, salt: number) =>
    Uint8Array.from({ length }, (_, index) => (index * salt + seed) % 256)
  return {
    version: UNIFIED_DISPLAY_WAVEFORM_CACHE_VERSION,
    parameterVersion: UNIFIED_DISPLAY_WAVEFORM_PARAMETER_VERSION,
    duration: 2,
    sampleRate: 44100,
    detailRate: 1200,
    overviewRate: 32,
    bodyRateDivisor: 4,
    height: bytes(2400, 1),
    attack: bytes(2400, 2),
    colorIndex: bytes(2400, 3),
    colorLow: bytes(2400, 4),
    colorMid: bytes(2400, 5),
    colorHigh: bytes(2400, 6),
    colorRed: bytes(2400, 7),
    colorGreen: bytes(2400, 8),
    colorBlue: bytes(2400, 9),
    body: bytes(600, 10),
    overviewHeight: bytes(64, 11)
  }
}
