import { createCipheriv, randomBytes } from 'node:crypto'
import { log } from '../log'
import { fetchWithSystemProxy } from '../fetchWithSystemProxy'
import { NeteaseApiError } from './errors'

/**
 * 网易云 weapi 客户端（主进程）。
 *
 * 加密方式与线上一致：AES-128-CBC 两层（固定 nonce + 随机 16 字符 key），
 * 再把反转后的 key 做裸 RSA（1024 位模数、指数 0x10001）。
 * 这套实现先在 scripts/netease-probe.ts 里跑通过，这里只是搬进主进程并接上系统代理。
 *
 * 所有请求都必须走 fetchWithSystemProxy：用户的网络环境可能有系统代理，裸 fetch 会连不上。
 */

const WEB_BASE = 'https://music.163.com'
const NONCE = '0CoJUm6Qyw8W8jud'
const IV = '0102030405060708'
const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export type NeteaseLevel = 'jymaster' | 'hires' | 'lossless' | 'exhigh' | 'standard'

export type NeteaseAccount = {
  userId: string
  nickname: string
  avatarUrl: string
  vipType: number
}

export type NeteasePlaylistKind = 'liked' | 'created' | 'subscribed' | 'album'

export type NeteasePlaylist = {
  playlistId: string
  kind: NeteasePlaylistKind
  title: string
  coverUrl: string
  trackCount: number
}

export type NeteaseSong = {
  songId: string
  title: string
  artist: string
  album: string
  durationMs: number
  coverUrl: string
}

export type NeteaseSongUrl = {
  url: string
  trial: boolean
  bitrate: number
  sizeBytes: number
  /** 服务端回显的档位；实际规格要靠文件头判断，见 parseAudioHeader */
  level: string
}

export type QrLoginState = {
  /** 800 过期 / 801 待扫 / 802 已扫待确认 / 803 成功 */
  code: number
  account?: NeteaseAccount
}

type Json = Record<string, unknown>

const asObj = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
const asArr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asStr = (value: unknown): string => (typeof value === 'string' ? value : '')
const asNum = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

// ---------------------------------------------------------------- 加密

function aesCbc(plain: Buffer, key: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(IV, 'utf8'))
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let value = base % modulus
  let exp = exponent
  while (exp > 0n) {
    if (exp & 1n) result = (result * value) % modulus
    value = (value * value) % modulus
    exp >>= 1n
  }
  return result
}

export function weapiEncrypt(payload: Json): { params: string; encSecKey: string } {
  const raw = randomBytes(16)
  const key = Array.from(raw, (byte) => KEY_CHARS[byte % KEY_CHARS.length]).join('')
  const json = JSON.stringify(payload)
  const first = aesCbc(Buffer.from(json, 'utf8'), NONCE).toString('base64')
  const params = aesCbc(Buffer.from(first, 'utf8'), key).toString('base64')
  const reversed = Buffer.from(key, 'utf8').reverse()
  const encrypted = modPow(
    BigInt(`0x${reversed.toString('hex')}`),
    0x10001n,
    BigInt(`0x${MODULUS}`)
  )
  return { params, encSecKey: encrypted.toString(16).padStart(256, '0') }
}

// ---------------------------------------------------------------- 客户端

type CookieJar = Map<string, string>

export class NeteaseClient {
  private jar: CookieJar = new Map()

  get cookieString(): string {
    const base = ['os=pc', 'appver=8.9.75']
    for (const [name, value] of this.jar) base.push(`${name}=${value}`)
    return base.join('; ')
  }

  hasCookie(name: string): boolean {
    return this.jar.has(name)
  }

  /** 导出完整 cookie（只在需要落盘时调用；不要写日志） */
  exportCookies(): string {
    return this.cookieString
  }

  importCookies(cookie: string): void {
    for (const part of String(cookie || '').split(';')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const index = trimmed.indexOf('=')
      if (index <= 0) continue
      this.jar.set(trimmed.slice(0, index), trimmed.slice(index + 1))
    }
  }

  clearCookies(): void {
    this.jar.clear()
  }

  /** 已登录的最小判据：MUSIC_U 存在 */
  get isLoggedIn(): boolean {
    return this.jar.has('MUSIC_U')
  }

  private absorbCookies(response: { headers: { getSetCookie?: () => string[] } }): void {
    const list =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    for (const line of list) {
      const first = String(line || '').split(';')[0] || ''
      const index = first.indexOf('=')
      if (index <= 0) continue
      this.jar.set(first.slice(0, index).trim(), first.slice(index + 1).trim())
    }
  }

  async weapi<T extends Json = Json>(path: string, fields: Json = {}): Promise<T> {
    // 官方网页和 pyncm 会把 csrf_token 同时放进加密 body 和 URL；
    // 只放 body、或没有这字段时，部分写接口会回 200 却不改数据。
    const csrf = String(this.jar.get('__csrf') || this.jar.get('_csrf') || '')
    const payload: Json = { ...fields, csrf_token: csrf }
    const { params, encSecKey } = weapiEncrypt(payload)
    const body = new URLSearchParams({ params, encSecKey }).toString()
    const url = `${WEB_BASE}/weapi${path}?csrf_token=${encodeURIComponent(csrf)}`

    let lastError: unknown = null
    // music.163.com 偶发连接超时，单次重试就能过；失败三次再报错。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchWithSystemProxy(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: 'https://music.163.com/',
            'User-Agent': UA,
            Cookie: this.cookieString
          },
          body,
          signal: AbortSignal.timeout(30_000) as never
        })
        this.absorbCookies(response as unknown as { headers: { getSetCookie?: () => string[] } })
        if (!response.ok) {
          throw new NeteaseApiError(`${path} HTTP ${response.status}`, response.status, 0)
        }
        const text = await response.text()
        const parsed = asObj(JSON.parse(text))
        if (!parsed) throw new Error(`${path} 返回不是对象`)
        const code = asNum(parsed.code)
        if (
          code !== 0 &&
          code !== 200 &&
          code !== 800 &&
          code !== 801 &&
          code !== 802 &&
          code !== 803
        ) {
          // 业务码非成功：登录失效与"资源没了"要能被上层区分出来，
          // 否则调用方只会看到"歌单是空的"。
          const detail = asStr(parsed.message) || asStr(parsed.msg)
          throw new NeteaseApiError(
            code === 301 || code === 302
              ? `登录态已失效（code ${code}）`
              : detail || `${path} 返回错误码 ${code}`,
            response.status,
            code
          )
        }
        return parsed as T
      } catch (error) {
        lastError = error
        // 登录失效 / 资源不存在 / 被限流这几种，重试只会把 30 秒拖成 90 秒
        if (error instanceof NeteaseApiError && error.definitive) {
          log.warn(
            `[netease-diag] weapi 不可重试失败 path=${path} status=${error.status} code=${error.code} message=${error.message}`
          )
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
      }
    }
    log.warn(
      `[netease-diag] weapi 重试耗尽 path=${path} message=${lastError instanceof Error ? lastError.message : String(lastError)}`
    )
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  // -------------------------------------------------- 登录

  async createQrKey(): Promise<{ unikey: string; url: string }> {
    const created = await this.weapi('/login/qrcode/unikey', { type: '1' })
    const unikey = asStr(created.unikey)
    if (!unikey) throw new Error('未拿到 unikey')
    return { unikey, url: `https://music.163.com/login?codekey=${encodeURIComponent(unikey)}` }
  }

  async checkQr(unikey: string): Promise<QrLoginState> {
    const checked = await this.weapi('/login/qrcode/client/login', { key: unikey, type: '1' })
    const code = asNum(checked.code)
    if (code !== 803) return { code }
    const account = await this.fetchAccount()
    if (!account) throw new Error('扫码成功但取不到账号信息')
    return { code, account }
  }

  async fetchAccount(): Promise<NeteaseAccount | null> {
    const result = await this.weapi('/w/nuser/account/get')
    // profile 在顶层（{code, account, profile}）；兼容被包进 data 的形态
    const container = asObj(result.data) ?? result
    const profile = asObj(container.profile)
    if (!profile) return null
    return {
      userId: String(asNum(profile.userId)),
      nickname: asStr(profile.nickname),
      avatarUrl: asStr(profile.avatarUrl),
      vipType: asNum(profile.vipType)
    }
  }

  // -------------------------------------------------- 目录

  async listPlaylists(userId: string): Promise<NeteasePlaylist[]> {
    const result = await this.weapi('/user/playlist', {
      uid: String(userId),
      limit: '1000',
      offset: '0',
      includeVideo: 'false'
    })
    const out: NeteasePlaylist[] = []
    const rows = asArr(result.playlist)
    let missingCreator = 0
    for (let index = 0; index < rows.length; index += 1) {
      const row = asObj(rows[index])
      if (!row) continue
      const playlistId = String(asNum(row.id))
      if (!playlistId || playlistId === '0') continue
      const specialType = asNum(row.specialType)
      const creatorId = String(asNum(asObj(row.creator)?.userId))
      let kind: NeteasePlaylistKind = 'subscribed'
      if (specialType === 5) kind = 'liked'
      else if (creatorId && creatorId === String(userId)) kind = 'created'
      else if (!creatorId) missingCreator += 1
      out.push({
        playlistId,
        kind,
        title: asStr(row.name),
        coverUrl: asStr(row.coverImgUrl),
        trackCount: asNum(row.trackCount)
      })
    }
    if (missingCreator > 0) {
      log.warn(
        `[netease-diag] playlist 列表有 ${missingCreator} 张缺少 creator.userId，自建/收藏分类可能不准`
      )
    }
    return out
  }

  /** 收藏的专辑。接口形态不稳，读不到就返回空数组，不影响歌单部分。 */
  async listAlbums(): Promise<NeteasePlaylist[]> {
    try {
      const result = await this.weapi('/album/sublist', {
        limit: '1000',
        offset: '0',
        total: 'true'
      })
      const rows = asArr(result.data).length ? asArr(result.data) : asArr(result.albums)
      return rows
        .map((item) => asObj(item))
        .filter((row): row is Json => Boolean(row))
        .map((row) => {
          const albumId = String(asNum(row.id))
          const artists = asArr(row.artists)
            .map((entry) => asStr(asObj(entry)?.name))
            .filter(Boolean)
          return {
            playlistId: albumId,
            kind: 'album' as const,
            title: artists.length ? `${asStr(row.name)} — ${artists.join(', ')}` : asStr(row.name),
            coverUrl: asStr(row.picUrl),
            trackCount: asNum(row.size)
          }
        })
        .filter((item) => item.playlistId && item.playlistId !== '0')
    } catch {
      return []
    }
  }

  /**
   * 歌单里的曲目 id（按原始顺序）。
   *
   * 拿不到 `playlist` 时**必须抛**，不能返回空数组：一次权限失败 / 接口变形都会被
   * 上层当成"这张歌单真的空了"，随后整表重写就把这首歌单的曲目关系全抹掉，
   * 「已下载」的孤儿判定会把这些歌算成孤儿。真为空的歌单会给出 `playlist` 对象，
   * 只是 `trackIds` 为空——两者必须分得开。
   */
  async playlistTrackIds(playlistId: string): Promise<string[]> {
    const detail = await this.weapi('/v6/playlist/detail', { id: playlistId, n: '100000', s: '8' })
    const playlist = asObj(detail.playlist)
    if (!playlist) {
      throw new NeteaseApiError(`歌单 ${playlistId} 没有返回详情`, 0, asNum(detail.code))
    }
    return asArr(playlist.trackIds)
      .map((item) => String(asNum(asObj(item)?.id)))
      .filter((id) => id && id !== '0')
  }

  /**
   * 从自己的歌单（含「我喜欢的音乐」）里移出曲目。
   * 走 /weapi/playlist/manipulate/tracks，改的是账号里的云端歌单。
   */
  async removePlaylistTracks(playlistId: string, songIds: string[]): Promise<void> {
    const ids = [
      ...new Set(songIds.map((id) => String(id || '').trim()).filter((id) => id && id !== '0'))
    ]
    if (!playlistId || ids.length === 0) return
    await this.weapi('/playlist/manipulate/tracks', {
      op: 'del',
      pid: String(playlistId),
      trackIds: JSON.stringify(ids),
      imme: 'true'
    })
  }

  /** 删除自己创建的歌单。走 /weapi/playlist/remove，ids 为 [id] / [id1,id2] 这种 JSON 数组字符串。 */
  async deletePlaylists(playlistIds: string[]): Promise<void> {
    const ids = [
      ...new Set(playlistIds.map((id) => String(id || '').trim()).filter((id) => id && id !== '0'))
    ]
    if (ids.length === 0) throw new Error('缺少歌单')
    const result = await this.weapi('/playlist/remove', { ids: `[${ids.join(',')}]` })
    const detail = asStr(result.message) || asStr(result.msg)
    log.info(
      `[netease] playlist/remove 返回 code=${asNum(result.code)}${detail ? ` ${detail}` : ''}`
    )
  }

  /** 取消收藏别人的歌单。走 /weapi/playlist/unsubscribe。 */
  async unsubscribePlaylist(playlistId: string): Promise<void> {
    const id = String(playlistId || '').trim()
    if (!id || id === '0') return
    await this.weapi('/playlist/unsubscribe', { id })
  }

  /** 取消收藏专辑。走 /weapi/album/unsub。 */
  async unsubscribeAlbum(albumId: string): Promise<void> {
    const id = String(albumId || '').trim()
    if (!id || id === '0') return
    await this.weapi('/album/unsub', { id })
  }

  async albumTrackIds(albumId: string): Promise<string[]> {
    const detail = await this.weapi('/v1/album/detail', { id: albumId })
    const album = asObj(detail.album)
    if (album) return asArr(album.songs).map((item) => String(asNum(asObj(item)?.id)))
    if (Array.isArray(detail.songs)) {
      return asArr(detail.songs).map((item) => String(asNum(asObj(item)?.id)))
    }
    throw new NeteaseApiError(`专辑 ${albumId} 没有返回详情`, 0, asNum(detail.code))
  }

  async songDetails(ids: string[]): Promise<Map<string, NeteaseSong>> {
    const out = new Map<string, NeteaseSong>()
    const unique = Array.from(new Set(ids.filter(Boolean)))
    // 接口一次处理不了太多 id，按 200 一批切。
    // 单批失败不抛：目录结构已经落库了，为了几批元数据让整次同步失败不值得——
    // 这些曲目只是标题为空，下次同步会补回来。
    for (let start = 0; start < unique.length; start += 200) {
      const chunk = unique.slice(start, start + 200)
      try {
        const result = await this.weapi('/v3/song/detail', {
          ids: `[${chunk.join(',')}]`,
          c: `[${chunk.map((id) => `{"id":${id}}`).join(',')}]`
        })
        for (const item of asArr(result.songs)) {
          const song = asObj(item)
          if (!song) continue
          const songId = String(asNum(song.id))
          const artists = asArr(song.ar).map((entry) => asStr(asObj(entry)?.name))
          const album = asObj(song.al)
          out.set(songId, {
            songId,
            title: asStr(song.name),
            artist: artists.filter(Boolean).join(', '),
            album: asStr(album?.name),
            durationMs: asNum(song.dt),
            coverUrl: asStr(album?.picUrl)
          })
        }
      } catch (error) {
        log.warn(`[netease] 取曲目详情失败（${chunk.length} 首），跳过这一批`, error)
      }
    }
    return out
  }

  // -------------------------------------------------- 音频

  async songUrl(songId: string, level: NeteaseLevel): Promise<NeteaseSongUrl | null> {
    let result: Json
    try {
      result = await this.weapi('/song/enhance/player/url/v1', {
        ids: `[${songId}]`,
        level,
        encodeType: 'flac'
      })
    } catch (error) {
      // 「这首没有可用地址」是常态（下架 / 需要会员 / 地区限制），
      // 用 null 表达，别让调用方去分辨错误类型。
      if (error instanceof NeteaseApiError) return null
      throw error
    }
    const row = asObj(asArr(result.data)[0])
    if (!row) return null
    return {
      url: asStr(row.url),
      // freeTrialInfo 有对象值就说明只给了试听片段（下架 / 需要会员 / 地区限制）
      trial: Boolean(row.freeTrialInfo),
      bitrate: asNum(row.br),
      sizeBytes: asNum(row.size),
      level: asStr(row.level) || level
    }
  }
}

export const neteaseClient = new NeteaseClient()
