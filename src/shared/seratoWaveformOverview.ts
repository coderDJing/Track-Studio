export type SeratoWaveformOverviewData = {
  versionMajor: number
  versionMinor: number
  columnCount: number
  rowCount: 16
  pixels: Uint8Array
}

const SERATO_OVERVIEW_HEADER_SIZE = 2
const SERATO_OVERVIEW_ROW_COUNT = 16

export const parseSeratoWaveformOverview = (
  raw: Uint8Array | null | undefined
): SeratoWaveformOverviewData | null => {
  if (!(raw instanceof Uint8Array) || raw.length <= SERATO_OVERVIEW_HEADER_SIZE) return null
  const pixelLength = raw.length - SERATO_OVERVIEW_HEADER_SIZE
  if (pixelLength % SERATO_OVERVIEW_ROW_COUNT !== 0) return null
  const columnCount = pixelLength / SERATO_OVERVIEW_ROW_COUNT
  if (!columnCount) return null
  return {
    versionMajor: raw[0],
    versionMinor: raw[1],
    columnCount,
    rowCount: SERATO_OVERVIEW_ROW_COUNT,
    pixels: raw.slice(SERATO_OVERVIEW_HEADER_SIZE)
  }
}
