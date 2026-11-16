// Run: pnpm exec vitest run src/main/netease/errors.spec.ts
import { describe, expect, it } from 'vitest'
import { NeteaseApiError, isFatalCode } from './errors'

/**
 * 同步能否保住旧数据，取决于这几个开关有没有分对：
 * 登录失效要提示重新扫码（但不能当成「歌单没了」去覆盖库），
 * 明确取不到才能跳过那一张，其余错误必须让整次同步中止。
 */
describe('NeteaseApiError', () => {
  it('把 HTTP 401 和业务码 301/302 判为登录失效，且不与「资源不可用」混为一谈', () => {
    expect(new NeteaseApiError('x', 401, 0).loginExpired).toBe(true)
    expect(new NeteaseApiError('x', 200, 301).loginExpired).toBe(true)
    expect(new NeteaseApiError('x', 200, 302).loginExpired).toBe(true)
    expect(new NeteaseApiError('x', 200, 301).unavailable).toBe(false)
    expect(new NeteaseApiError('x', 401, 0).definitive).toBe(true)
  })

  it('把 HTTP 403/404 和业务码 404 判为资源不可用，而不是登录失效', () => {
    expect(new NeteaseApiError('x', 403, 0).unavailable).toBe(true)
    expect(new NeteaseApiError('x', 404, 0).unavailable).toBe(true)
    expect(new NeteaseApiError('x', 200, 404).unavailable).toBe(true)
    expect(new NeteaseApiError('x', 403, 0).loginExpired).toBe(false)
    expect(new NeteaseApiError('x', 403, 0).definitive).toBe(true)
  })

  it('把 -460 / -462 视为不应重试的致命业务码', () => {
    expect(isFatalCode(-460)).toBe(true)
    expect(isFatalCode(-462)).toBe(true)
    expect(isFatalCode(400)).toBe(false)
    expect(new NeteaseApiError('x', 200, -460).definitive).toBe(true)
  })

  it('普通失败不是 definitive，调用方可以重试', () => {
    const error = new NeteaseApiError('x', 500, 400)
    expect(error.loginExpired).toBe(false)
    expect(error.unavailable).toBe(false)
    expect(error.definitive).toBe(false)
  })
})
