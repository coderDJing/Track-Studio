import { describe, expect, it } from 'vitest'
import { isRcVersion, shouldEnableRcDiagnostics } from './rcDiagnostics'

describe('RC performance diagnostics gate', () => {
  it('只识别 rc 预发布版本', () => {
    expect(isRcVersion('1.2.4-rc.202609081730')).toBe(true)
    expect(isRcVersion('1.2.4-RC.1')).toBe(true)
    expect(isRcVersion('1.2.4')).toBe(false)
    expect(isRcVersion('1.2.4-beta.1')).toBe(false)
  })

  it('只在打包后的 RC 中启用', () => {
    expect(shouldEnableRcDiagnostics(true, '1.2.4-rc.1')).toBe(true)
    expect(shouldEnableRcDiagnostics(false, '1.2.4-rc.1')).toBe(false)
    expect(shouldEnableRcDiagnostics(true, '1.2.4')).toBe(false)
  })
})
