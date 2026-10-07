export type PioneerUsbLoopBeatFields = {
  loopNumerator?: number
  loopDenominator?: number
}

const isStoredPowerOfTwo = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value > 0 &&
  value <= 0xffff &&
  (value & (value - 1)) === 0

/** Native PCP2 represents manual loops as 0/0 and quantized loops as N/1 or 1/N. */
export const isValidPioneerUsbLoopBeatPair = (numerator: unknown, denominator: unknown): boolean =>
  (numerator === 0 && denominator === 0) ||
  (isStoredPowerOfTwo(numerator) &&
    isStoredPowerOfTwo(denominator) &&
    (numerator === 1 || denominator === 1))

export const normalizePioneerUsbLoopBeatFields = (
  value: { loopNumerator?: unknown; loopDenominator?: unknown },
  isLoop: boolean
): PioneerUsbLoopBeatFields => {
  const { loopNumerator, loopDenominator } = value
  if (
    !isLoop ||
    typeof loopNumerator !== 'number' ||
    typeof loopDenominator !== 'number' ||
    !isValidPioneerUsbLoopBeatPair(loopNumerator, loopDenominator)
  )
    return {}
  return { loopNumerator, loopDenominator }
}
