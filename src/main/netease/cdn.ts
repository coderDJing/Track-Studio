import { fetchWithSystemProxy } from '../fetchWithSystemProxy'
import { log } from '../log'

/**
 * 网易云 CDN 的取流入口。
 *
 * 两件事必须都在这里做：
 *   1. **Referer**。只带 User-Agent 会被当成盗链，轻则 403，重则回一个 HTML 错误页
 *      （然后被我们当成音频存下来）；
 *   2. **429 退避**。批量导入时最容易撞限流，一撞就整批失败，还会把账号送进更深的限流。
 */

export const NETEASE_REFERER = 'https://music.163.com/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'

export type CdnFetchOptions = {
  /** 透传给 CDN 的 Range 头（播放器 seek 时会发） */
  range?: string
  /** 撞到 429 / 5xx 时的重试次数；播放路径要设 0，不能让播放器等退避 */
  retries?: number
}

export async function fetchNeteaseCdn(
  url: string,
  options: CdnFetchOptions = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Referer: NETEASE_REFERER
  }
  if (options.range) headers.Range = options.range

  const retries = Math.max(0, options.retries ?? 0)
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithSystemProxy(url, { headers } as never)
    const retriable = response.status === 429 || response.status >= 500
    if (!retriable || attempt >= retries) {
      if (response.status === 429) log.warn('[netease] CDN 限流（429）')
      return response
    }
    const delay = 1000 * 2 ** attempt + Math.floor(Math.random() * 400)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}
