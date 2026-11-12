import { describe, expect, it } from 'vitest'
import type { ISettingConfig } from 'src/types/globals'
import { ensureSettingDialogRuntimeDefaults } from './settingDialogRuntimeDefaults'

const createRuntime = (analysisGridMode?: unknown) => ({
  setting: { analysisGridMode } as unknown as ISettingConfig
})

describe('ensureSettingDialogRuntimeDefaults', () => {
  it('defaults the beat grid mode to normal', () => {
    const runtime = createRuntime(undefined)
    ensureSettingDialogRuntimeDefaults(runtime)
    expect(runtime.setting.analysisGridMode).toBe('normal')
  })

  it('keeps a stored dynamic mode', () => {
    const runtime = createRuntime('dynamic')
    ensureSettingDialogRuntimeDefaults(runtime)
    expect(runtime.setting.analysisGridMode).toBe('dynamic')
  })

  it('normalizes an unknown stored mode back to normal', () => {
    const runtime = createRuntime('auto')
    ensureSettingDialogRuntimeDefaults(runtime)
    expect(runtime.setting.analysisGridMode).toBe('normal')
  })
})
