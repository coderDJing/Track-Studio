/**
 * 「艺人 - 标题」→ 一个能落盘的合法文件名。
 *
 * 单独成文件是为了能直接测：import.ts 的依赖链很长（指纹、库监听、云同步），
 * 为了验一个字符串函数把那些全拉起来不值得。
 */

const WINDOWS_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g
const MAX_BASE_NAME_LENGTH = 96

/**
 * 只做必要处理：非法字符换成空格、连续空白压成一个、去掉结尾的点和空格
 * （Windows 会把 "abc." 变成 "abc"，两首不同的歌就可能撞在一起）。
 */
export function buildImportBaseName(artist: string, title: string, songId: string): string {
  const clean = (value: string) =>
    String(value || '')
      .replace(WINDOWS_ILLEGAL, ' ')
      .replace(/\s+/g, ' ')
      .trim()

  const safeArtist = clean(artist)
  const safeTitle = clean(title)
  let base = safeArtist && safeTitle ? `${safeArtist} - ${safeTitle}` : safeTitle || safeArtist
  if (!base) base = `netease_${songId}`
  base = base.replace(/[. ]+$/g, '')
  if (!base) base = `netease_${songId}`
  if (base.length > MAX_BASE_NAME_LENGTH) {
    base = base.slice(0, MAX_BASE_NAME_LENGTH).replace(/[. ]+$/g, '')
  }
  return base
}
