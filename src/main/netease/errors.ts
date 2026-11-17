/**
 * 接口错误。
 *
 * 网易云的失败有两层：HTTP 状态是一层，响应体里的 `code` 是另一层。
 * 只看 HTTP 会把「登录态失效」当成正常响应——歌单详情的 `playlist` 变成空对象，
 * 于是空歌单被当成真结果写回库，用户的所有曲目瞬间变成孤儿。
 *
 * 单独成文件是为了能直接测（client.ts 的依赖链里有 electron，跑不进 node 测试环境）。
 */
export class NeteaseApiError extends Error {
  readonly status: number
  readonly code: number

  constructor(message: string, status = 0, code = 0) {
    super(message)
    this.name = 'NeteaseApiError'
    this.status = status
    this.code = code
  }

  /** 登录态失效：要提示重新扫码，但**不能**自动删 cookie——用户可能只是临时波动 */
  get loginExpired(): boolean {
    return this.status === 401 || this.code === 301 || this.code === 302
  }

  /** 明确的"这个资源取不到了"（歌单被删/转私密），不是网络抖动 */
  get unavailable(): boolean {
    return this.status === 403 || this.status === 404 || this.code === 404
  }

  /** 重试没有意义的错误，立即上抛 */
  get definitive(): boolean {
    return this.loginExpired || this.unavailable || isFatalCode(this.code)
  }
}

/** -460 操作频繁、-462 需要验证、521 需要绑定手机：这几类重试只会更糟 */
export const isFatalCode = (code: number): boolean => code === -460 || code === -462 || code === 521
