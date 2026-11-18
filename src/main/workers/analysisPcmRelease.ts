export type AnalysisPcmHolder = {
  pcmData?: Buffer | null
}

/**
 * Drop a decoded PCM buffer as soon as its phase is finished so the next track
 * does not inherit the previous ArrayBuffer until a later GC.
 * Replacing the property does not mutate a shared parent buffer (e.g. a 120s
 * subarray of a full-track decode).
 */
export const releaseAnalysisPcm = <T extends AnalysisPcmHolder | null | undefined>(
  holder: T
): null => {
  if (holder && holder.pcmData && holder.pcmData.byteLength > 0) {
    holder.pcmData = Buffer.alloc(0)
  }
  return null
}

export const requestAnalysisMemoryReclaim = () => {
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc === 'function') gc()
}

export const BEAT_GRID_ANALYSIS_SAMPLE_RATE = 44100
export const BEAT_GRID_ANALYSIS_CHANNELS = 2
export const BEAT_GRID_ANALYSIS_MAX_SCAN_SEC = 120

export const canReuseDecodedPcmForBeatGrid = (decoded: {
  sampleRate: number
  channels: number
  pcmData?: Buffer | null
}): boolean =>
  decoded.sampleRate === BEAT_GRID_ANALYSIS_SAMPLE_RATE &&
  decoded.channels === BEAT_GRID_ANALYSIS_CHANNELS &&
  Boolean(decoded.pcmData && decoded.pcmData.byteLength > 0)

export const sliceBeatGridPcmFromDecoded = <
  T extends {
    pcmData: Buffer
    sampleRate: number
    channels: number
    totalFrames?: number
    decoderBackend?: string
  }
>(
  decoded: T
):
  | (Omit<T, 'decoderBackend' | 'totalFrames'> & {
      totalFrames: number
      decoderBackend: string
    })
  | null => {
  if (!canReuseDecodedPcmForBeatGrid(decoded)) return null
  const frameStride = BEAT_GRID_ANALYSIS_CHANNELS * 4
  const maxBytes = BEAT_GRID_ANALYSIS_MAX_SCAN_SEC * BEAT_GRID_ANALYSIS_SAMPLE_RATE * frameStride
  const byteLength = Math.min(decoded.pcmData.byteLength, maxBytes)
  const usable = byteLength - (byteLength % frameStride)
  if (usable <= 0) return null
  return {
    ...decoded,
    pcmData: decoded.pcmData.subarray(0, usable),
    totalFrames: Math.floor(usable / frameStride),
    decoderBackend: `${decoded.decoderBackend || 'decoded'}-beat-grid-slice`
  }
}
