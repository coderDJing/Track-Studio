import { describe, expect, it } from 'vitest'
import { isProvidedVerticalMetrics } from './useVirtualRows'

describe('iCloud and ordinary list vertical metrics', () => {
  it('treats omitted OverlayScrollbars samples as missing, not as frozen zero-size metrics', () => {
    expect(isProvidedVerticalMetrics(undefined, undefined)).toBe(false)
    expect(isProvidedVerticalMetrics(0, undefined)).toBe(false)
    expect(isProvidedVerticalMetrics(undefined, 0)).toBe(false)
    expect(isProvidedVerticalMetrics(120, 600)).toBe(true)
    expect(isProvidedVerticalMetrics(0, 0)).toBe(true)
  })
})
