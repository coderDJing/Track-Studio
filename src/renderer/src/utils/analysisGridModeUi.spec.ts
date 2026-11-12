import { describe, expect, it, vi } from 'vitest'
import { isDynamicAnalysisGridAvailable } from '@shared/analysisGridMode'
import { buildAnalysisGridModeOptions, isAnalysisGridSubmitBlocked } from './analysisGridModeUi'

vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))

describe('analysisGridModeUi', () => {
  it('keeps dynamic selectable when the release switch is on', () => {
    const options = buildAnalysisGridModeOptions({ dynamicAvailable: true })
    expect(options.map((option) => option.value)).toEqual(['normal', 'dynamic'])
    expect(options.every((option) => option.disabled !== true)).toBe(true)
  })

  it('disables dynamic but keeps it visible when the release switch is off', () => {
    const options = buildAnalysisGridModeOptions({ dynamicAvailable: false })
    expect(options).toEqual([
      { label: 'settings.analysisGridMode.normal', value: 'normal', disabled: false },
      { label: 'settings.analysisGridMode.dynamic', value: 'dynamic', disabled: true }
    ])
  })

  it('builds enabled and submittable dynamic options for a packaged release', () => {
    const dynamicAvailable = isDynamicAnalysisGridAvailable({ isDevelopment: false })
    expect(dynamicAvailable).toBe(true)
    expect(
      buildAnalysisGridModeOptions({ dynamicAvailable }).find(
        (option) => option.value === 'dynamic'
      )
    ).toEqual({
      label: 'settings.analysisGridMode.dynamic',
      value: 'dynamic',
      disabled: false
    })
    expect(
      isAnalysisGridSubmitBlocked({
        beatGridSelected: true,
        mode: 'dynamic',
        dynamicAvailable
      })
    ).toBe(false)
  })

  it('blocks submitting a dynamic grid request when dynamic is unavailable', () => {
    expect(
      isAnalysisGridSubmitBlocked({
        beatGridSelected: true,
        mode: 'dynamic',
        dynamicAvailable: false
      })
    ).toBe(true)
    expect(
      isAnalysisGridSubmitBlocked({
        beatGridSelected: true,
        mode: 'normal',
        dynamicAvailable: false
      })
    ).toBe(false)
    expect(
      isAnalysisGridSubmitBlocked({
        beatGridSelected: false,
        mode: 'dynamic',
        dynamicAvailable: false
      })
    ).toBe(false)
    expect(
      isAnalysisGridSubmitBlocked({
        beatGridSelected: true,
        mode: 'dynamic',
        dynamicAvailable: true
      })
    ).toBe(false)
  })
})
