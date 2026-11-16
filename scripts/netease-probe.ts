/**
 * 网易云能力探针（P0，一次性脚本，不属于生产代码）
 *
 * 目的：在写任何 UI 之前，用真实账号验证四件事：
 *   1. 免费账号能否取到可用音频地址；会员账号各档位的命中率；
 *   2. 网易云到底给哪几档（hires / jymaster 是否可用）；
 *   3. cookie 里 __csrf / MUSIC_U 的组合是否完整；
 *   4. 走系统代理时是否可用。
 *
 * 用法（登录分两段，中间不会覆盖 unikey）：
 *   npx tsx scripts/netease-probe.ts --qr        # 出码：写 PNG + 存 unikey，退出
 *   npx tsx scripts/netease-probe.ts --login     # 扫完后续接，登录并跑完整探测
 *   npx tsx scripts/netease-probe.ts --samples 8
 *   npx tsx scripts/netease-probe.ts --proxy http://127.0.0.1:7890
 *   npx tsx scripts/netease-probe.ts --cookie "MUSIC_U=...; __csrf=..."
 *   npx tsx scripts/netease-probe.ts --smoke     # 只验加密与连通性
 *
 * 登录态默认缓存在系统临时目录，不写入仓库、不打印 cookie。
 */

import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { renderQr, writeQrPng } from './netease-qr'

const WEB_BASE = 'https://music.163.com'
const NONCE = '0CoJUm6Qyw8W8jud'
const IV = '0102030405060708'
const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
const SESSION_FILE = join(tmpdir(), 'frkb-netease-probe-session.json')
/** 待扫码的 unikey。出码与等扫码分两个进程，靠这个文件接力。 */
const PENDING_FILE = join(tmpdir(), 'frkb-netease-qr-pending.json')
const QR_PNG_PATH = resolve(process.cwd(), '.workbuddy/tmp/netease-login-qr.png')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** 探针要试的档位，从高到低。 */
const LEVELS = ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'] as const
type Level = (typeof LEVELS)[number]

type Json = Record<string, unknown>

const asObj = (value: unknown): Json | null =>
  value && typeof value === 'object' ? (value as Json) : null
const asArr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asNum = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value) || 0
  return 0
}
const asStr = (value: unknown): string => (typeof value === 'string' ? value : '')

type CookieJar = Map<string, string>

type Session = { cookie: string; userId: number; nickname: string }

type Args = {
  samples: number
  proxy: string
  cookie: string
  relogin: boolean
  smoke: boolean
  qr: boolean
  login: boolean
}

type PendingQr = { unikey: string; url: string; cookie: string; createdAt: number }

function parseArgs(argv: string[]): Args {
  const args: Args = {
    samples: 6,
    proxy: '',
    cookie: '',
    relogin: false,
    smoke: false,
    qr: false,
    login: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = (): string => argv[i + 1] || ''
    if (token === '--samples') {
      args.samples = Math.max(1, Math.min(30, Number(next()) || 6))
      i += 1
    } else if (token === '--proxy') {
      args.proxy = next()
      i += 1
    } else if (token === '--cookie') {
      args.cookie = next()
      i += 1
    } else if (token === '--relogin') {
      args.relogin = true
    } else if (token === '--smoke') {
      args.smoke = true
    } else if (token === '--qr') {
      args.qr = true
    } else if (token === '--login') {
      args.login = true
    } else if (token === '--help' || token === '-h') {
      printUsage()
      process.exit(0)
    }
  }
  return args
}

function printUsage(): void {
  console.log(`网易云能力探针

  --qr             只出二维码（写成 PNG 并打印路径），不等待、不探测
  --login          续接上一次 --qr 的 unikey 等扫码，登录成功后继续完整探测
  --samples <n>    每个档位抽样几首（默认 6，最大 30）
  --proxy <url>    显式代理，例如 http://127.0.0.1:7890
  --cookie <str>   直接复用已有 cookie，跳过扫码
  --relogin        忽略本地缓存，重新扫码
  --smoke          只验证 weapi 加密与连通性，不登录、不探测
`)
}

// ---------------------------------------------------------------- weapi 加密

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

function weapiEncrypt(payload: Json): { params: string; encSecKey: string } {
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

// ---------------------------------------------------------------- HTTP

const jar: CookieJar = new Map()
let dispatcher: ProxyAgent | undefined
/** 最近一次响应下发的 cookie 名（只记名，不记值），排查登录态用。 */
const lastSetCookieNames: string[] = []

function cookieHeader(): string {
  const base = ['os=pc', 'appver=8.9.75']
  for (const [name, value] of jar) base.push(`${name}=${value}`)
  return base.join('; ')
}

function absorbCookies(response: {
  headers: { getSetCookie?: () => string[]; get?: (name: string) => string | null }
}): void {
  let list: string[] = []
  if (typeof response.headers.getSetCookie === 'function') list = response.headers.getSetCookie()
  if (list.length === 0 && typeof response.headers.get === 'function') {
    // 老版本 undici / Node 没有 getSetCookie 时，Set-Cookie 会被合并成一行，
    // 只能按"逗号 + 下一个 name=" 的位置切开（Expires 里的逗号不能切）。
    const raw = response.headers.get('set-cookie')
    if (raw) list = raw.split(/,(?=\s*[^;,=\s]+=)/)
  }
  lastSetCookieNames.length = 0
  for (const line of list) {
    const first = line.split(';')[0] || ''
    const index = first.indexOf('=')
    if (index <= 0) continue
    const name = first.slice(0, index).trim()
    lastSetCookieNames.push(name)
    jar.set(name, first.slice(index + 1).trim())
  }
}

function loadJarFromCookieString(cookie: string): void {
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    jar.set(trimmed.slice(0, index), trimmed.slice(index + 1))
  }
}

async function weapi(path: string, fields: Json): Promise<Json> {
  const csrf = jar.get('__csrf')
  const payload: Json = csrf ? { ...fields, csrf_token: csrf } : fields
  const { params, encSecKey } = weapiEncrypt(payload)
  const body = new URLSearchParams({ params, encSecKey }).toString()
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com/',
      'User-Agent': UA,
      Cookie: cookieHeader()
    },
    body,
    dispatcher,
    signal: AbortSignal.timeout(30_000)
  }
  // 国内到 music.163.com 偶发连接超时，单次重试就能过，避免一次抖动毁掉整轮探测。
  let response: Awaited<ReturnType<typeof undiciFetch>> | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await undiciFetch(`${WEB_BASE}/weapi${path}`, init)
      break
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  if (!response) throw lastError
  absorbCookies(response)
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`)
  const parsed = asObj(JSON.parse(text))
  if (!parsed) throw new Error(`${path} 返回不是对象`)
  return parsed
}

// ---------------------------------------------------------------- 登录

async function fetchProfile(): Promise<Json | null> {
  const result = await weapi('/w/nuser/account/get', {})
  // profile 在顶层（{code, account, profile}），但也兼容被包到 data 里的形态。
  const container = asObj(result.data) ?? result
  const profile = asObj(container.profile)
  if (!profile) {
    console.log(`  account/get 顶层字段：${Object.keys(result).join(', ') || '（空）'}`)
    console.log(
      `  account/get：code=${asNum(result.code)} msg=${asStr(result.message) || asStr(result.msg) || '-'}`
    )
  }
  return profile
}

/**
 * 只负责出码：申请 unikey，画成二维码 PNG，把 unikey 存盘，然后退出。
 *
 * 关键点：unikey 是一码一 key，且有效期只有几分钟。以前"申请 + 等待"放在同一个
 * 进程里，我这边一重跑就换 key，屏幕上那个码立刻作废——这就是之前两次都卡在 801
 * 的原因。拆成两个阶段后，扫码期间没有任何东西会覆盖这个 key。
 */
async function issueQr(): Promise<void> {
  const created = await weapi('/login/qrcode/unikey', { type: '1' })
  const unikey = asStr(created.unikey)
  if (!unikey) throw new Error('未拿到 unikey')

  const url = `https://music.163.com/login?codekey=${encodeURIComponent(unikey)}`
  mkdirSync(dirname(QR_PNG_PATH), { recursive: true })
  const png = writeQrPng(url, QR_PNG_PATH, { scale: 8, quietZone: 4 })
  writeFileSync(
    PENDING_FILE,
    JSON.stringify({ unikey, url, cookie: cookieHeader(), createdAt: Date.now() }, null, 2),
    { mode: 0o600 }
  )

  console.log(`二维码 PNG：${QR_PNG_PATH}`)
  console.log(`规格：${png.size}×${png.size} 模块 → ${png.pixels}×${png.pixels} 像素`)
  console.log(`unikey：${unikey.slice(0, 8)}…（已存 ${PENDING_FILE}）`)
  console.log('\n终端预览（如果输出被折叠就看 PNG）：')
  console.log(renderQr(url))
}

/** 等扫码。用上一次 --qr 存下的 unikey，成功后落 cookie。 */
async function waitForScan(timeoutMs = 240_000): Promise<Session> {
  if (!existsSync(PENDING_FILE)) {
    throw new Error('没有待扫码的 unikey，请先执行 --qr')
  }
  const pending = JSON.parse(readFileSync(PENDING_FILE, 'utf8')) as PendingQr
  const unikey = asStr(pending.unikey)
  if (!unikey) throw new Error('待扫码文件里没有 unikey，请重新执行 --qr')
  // 出码时的 cookie 也带回来，登录校验靠它串同一个会话。
  if (pending.cookie) loadJarFromCookieString(pending.cookie)

  const ageSec = Math.round((Date.now() - Number(pending.createdAt || 0)) / 1000)
  console.log(`续接 unikey（${unikey.slice(0, 8)}…，出码于 ${ageSec} 秒前），开始轮询…`)

  const deadline = Date.now() + timeoutMs
  let lastCode = -1
  while (Date.now() < deadline) {
    const checked = await weapi('/login/qrcode/client/login', { key: unikey, type: '1' })
    const code = asNum(checked.code)
    if (code !== lastCode) {
      lastCode = code
      console.log(`扫码状态：${code}（800 过期 / 801 待扫 / 802 已扫待确认 / 803 成功）`)
    }
    if (code === 800) {
      throw new Error('二维码已过期，请重新执行 --qr 出码')
    }
    if (code === 802) {
      console.log('已扫码，等待手机端点「确认登录」…')
    }
    if (code === 803) {
      // 803 一出现就把 cookie 落盘：这一步失败过账号接口就白扫了，重扫要再等一轮。
      writeFileSync(
        SESSION_FILE,
        JSON.stringify({ cookie: cookieHeader(), userId: 0, nickname: '' }, null, 2),
        { mode: 0o600 }
      )
      console.log(`  本次响应下发 cookie：${lastSetCookieNames.join(', ') || '（无）'}`)
      console.log(`  cookie 罐：${[...jar.keys()].join(', ') || '（空）'}`)
      const profile = await fetchProfile()
      if (!profile)
        throw new Error('登录成功但拿不到账号信息（cookie 已保存，可直接重跑不加 --login）')
      const session: Session = {
        cookie: cookieHeader(),
        userId: asNum(profile.userId),
        nickname: asStr(profile.nickname)
      }
      writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 })
      console.log(`登录成功：${session.nickname}（userId=${session.userId}）`)
      return session
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error('等待扫码超时')
}

function restoreSession(args: Args): Session | null {
  if (args.cookie) {
    loadJarFromCookieString(args.cookie)
    return { cookie: args.cookie, userId: 0, nickname: '' }
  }
  if (args.relogin || !existsSync(SESSION_FILE)) return null
  try {
    const raw = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Partial<Session>
    if (!raw.cookie) return null
    loadJarFromCookieString(raw.cookie)
    return {
      cookie: raw.cookie,
      userId: Number(raw.userId) || 0,
      nickname: String(raw.nickname || '')
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 目录

async function listPlaylists(
  userId: number
): Promise<Array<{ id: string; name: string; count: number }>> {
  const result = await weapi('/user/playlist', {
    uid: String(userId),
    limit: '100',
    offset: '0',
    includeVideo: 'true'
  })
  return asArr(result.playlist).map((item) => {
    const row = asObj(item) || {}
    return {
      id: String(asNum(row.id)),
      name: asStr(row.name),
      count: asNum(row.trackCount)
    }
  })
}

async function playlistTrackIds(playlistId: string, limit: number): Promise<string[]> {
  const detail = await weapi('/v6/playlist/detail', { id: playlistId, n: '100000', s: '8' })
  const playlist = asObj(detail.playlist)
  if (!playlist) return []
  const ids = asArr(playlist.trackIds)
    .map((item) => asNum(asObj(item)?.id))
    .filter((id) => id > 0)
  return ids.slice(0, limit).map((id) => String(id))
}

async function songDetails(
  ids: string[]
): Promise<Map<string, { title: string; artist: string; duration: number }>> {
  const out = new Map<string, { title: string; artist: string; duration: number }>()
  if (ids.length === 0) return out
  const result = await weapi('/v3/song/detail', {
    ids: `[${ids.join(',')}]`,
    c: `[${ids.map((id) => `{"id":${id}}`).join(',')}]`
  })
  for (const item of asArr(result.songs)) {
    const song = asObj(item)
    if (!song) continue
    const id = String(asNum(song.id))
    const artists = asArr(song.ar).map((entry) => asStr(asObj(entry)?.name))
    out.set(id, {
      title: asStr(song.name),
      artist: artists.join(', '),
      duration: asNum(song.dt)
    })
  }
  return out
}

// ---------------------------------------------------------------- 音频探测

type ProbeResult = {
  level: Level
  status: 'ok' | 'trial' | 'none' | 'error'
  bytes: number
  bitrate: number
  format: string
  note: string
}

function parseFlacHeader(
  buffer: Buffer
): { sampleRate: number; bits: number; channels: number } | null {
  if (buffer.length < 42) return null
  if (buffer.toString('latin1', 0, 4) !== 'fLaC') return null
  const blockType = buffer[4] & 0x7f
  if (blockType !== 0) return null
  const base = 18
  const sampleRate = (buffer[base] << 12) | (buffer[base + 1] << 4) | (buffer[base + 2] >> 4)
  const channels = ((buffer[base + 2] >> 1) & 0x07) + 1
  const bits = (((buffer[base + 2] & 0x01) << 4) | (buffer[base + 3] >> 4)) + 1
  return { sampleRate, bits, channels }
}

async function probeLevel(songId: string, level: Level): Promise<ProbeResult> {
  let url = ''
  let trial = false
  let bitrate = 0
  let bytes = 0
  try {
    const result = await weapi('/song/enhance/player/url/v1', {
      ids: `[${songId}]`,
      level,
      encodeType: 'flac'
    })
    const row = asObj(asArr(result.data)[0]) || {}
    url = asStr(row.url)
    bitrate = asNum(row.br)
    bytes = asNum(row.size)
    const freeTrial = row.freeTrialInfo
    trial = Boolean(freeTrial) && freeTrial !== null
  } catch (error) {
    return {
      level,
      status: 'error',
      bytes: 0,
      bitrate: 0,
      format: '-',
      note: error instanceof Error ? error.message : '请求失败'
    }
  }

  if (!url)
    return { level, status: 'none', bytes, bitrate, format: '-', note: trial ? '仅试听' : '无地址' }

  try {
    const head = await undiciFetch(url, {
      headers: { Range: 'bytes=0-131071', 'User-Agent': UA },
      dispatcher,
      signal: AbortSignal.timeout(30_000)
    })
    const buffer = Buffer.from(await head.arrayBuffer())
    if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === 'fLaC') {
      const info = parseFlacHeader(buffer)
      const format = info ? `FLAC ${info.bits}bit/${info.sampleRate}Hz/${info.channels}ch` : 'FLAC'
      return {
        level,
        status: trial ? 'trial' : 'ok',
        bytes,
        bitrate,
        format,
        note: trial ? '试听片段' : ''
      }
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
      return {
        level,
        status: trial ? 'trial' : 'ok',
        bytes,
        bitrate,
        format: 'MP3',
        note: trial ? '试听片段' : ''
      }
    }
    return {
      level,
      status: trial ? 'trial' : 'ok',
      bytes,
      bitrate,
      format: buffer.toString('latin1', 0, 3) === 'ID3' ? 'MP3' : '其他',
      note: ''
    }
  } catch (error) {
    return {
      level,
      status: 'error',
      bytes,
      bitrate,
      format: '-',
      note: `取字节失败：${error instanceof Error ? error.message : '未知'}`
    }
  }
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.proxy) {
    dispatcher = new ProxyAgent(args.proxy)
    console.log(`代理：${args.proxy}`)
  }

  if (args.smoke) {
    const started = Date.now()
    const account = await weapi('/w/nuser/account/get', {})
    console.log(`/w/nuser/account/get → code=${asNum(account.code)}（${Date.now() - started}ms）`)
    const ok = asNum(account.code) === 200
    console.log(ok ? '\nweapi 加密与连通性正常。' : '\n返回内容异常，请检查网络或代理。')
    return
  }

  if (args.qr) {
    await issueQr()
    return
  }

  let session: Session | null
  if (args.login) {
    // --login 明确表示"等这次扫码"，优先级高于本地缓存，否则上次残留的 cookie 会把它顶掉。
    session = await waitForScan()
  } else {
    session = restoreSession(args)
    if (session) console.log('使用已缓存的登录态…')
  }
  if (!session) {
    throw new Error('还没有登录态：先跑 --qr 出码，扫完再跑 --login')
  }

  const profile = await fetchProfile()
  if (!profile) {
    console.log('\n登录态无效（可能已过期）。用 --relogin 重新扫码。')
    process.exit(1)
  }
  const userId = asNum(profile.userId)
  const vipType = asNum(profile.vipType)
  console.log(`\n账号：${asStr(profile.nickname)}  (userId=${userId}, vipType=${vipType})`)
  console.log(
    `cookie 关键项：MUSIC_U=${jar.has('MUSIC_U') ? '有' : '缺失'}, __csrf=${jar.has('__csrf') ? '有' : '缺失'}`
  )

  const playlists = await listPlaylists(userId)
  console.log(`歌单 ${playlists.length} 个，前 5 个：`)
  for (const item of playlists.slice(0, 5)) console.log(`  · ${item.name}（${item.count} 首）`)

  const target = playlists.find((item) => item.id !== '0' && item.count > 0) || null
  if (!target) {
    console.log('\n没有可用歌单，跳过音质探测。')
    return
  }
  const ids = await playlistTrackIds(target.id, args.samples * 3)
  if (ids.length === 0) {
    console.log('\n歌单为空，跳过音质探测。')
    return
  }

  const step = Math.max(1, Math.floor(ids.length / args.samples))
  const picked = ids.filter((_, index) => index % step === 0).slice(0, args.samples)
  const details = await songDetails(picked)

  console.log(
    `\n音质探测：歌单「${target.name}」，抽样 ${picked.length} 首 × ${LEVELS.length} 档\n`
  )

  const tally = new Map<
    Level,
    {
      ok: number
      trial: number
      none: number
      error: number
      bits: Set<number>
      rates: Set<number>
    }
  >()
  for (const level of LEVELS) {
    tally.set(level, { ok: 0, trial: 0, none: 0, error: 0, bits: new Set(), rates: new Set() })
  }

  for (const id of picked) {
    const meta = details.get(id)
    console.log(`— ${meta ? `${meta.title} — ${meta.artist}` : `songId=${id}`}`)
    for (const level of LEVELS) {
      const result = await probeLevel(id, level)
      const stat = tally.get(level)
      if (stat) {
        stat[result.status] += 1
        const sizeMb = result.bytes > 0 ? `${(result.bytes / 1048576).toFixed(1)}MB` : '-'
        const bit = /FLAC (\d+)bit/.exec(result.format)
        const rate = /FLAC \d+bit\/(\d+)Hz/.exec(result.format)
        if (bit) stat.bits.add(Number(bit[1]))
        if (rate) stat.rates.add(Number(rate[1]))
        console.log(
          `    ${level.padEnd(9)} ${result.status.padEnd(5)} ${result.format.padEnd(24)} ${sizeMb.padStart(8)} ${result.note}`
        )
      }
    }
  }

  console.log('\n汇总（抽样样本内的命中情况）')
  console.log('  档位        ok  试听  无    错误   实测规格')
  for (const level of LEVELS) {
    const stat = tally.get(level)
    if (!stat) continue
    const spec = `${[...stat.bits].join('/') || '-'}bit ${[...stat.rates].join('/') || '-'}Hz`
    console.log(
      `  ${level.padEnd(10)} ${String(stat.ok).padStart(3)} ${String(stat.trial).padStart(4)} ${String(stat.none).padStart(4)} ${String(stat.error).padStart(5)}   ${spec}`
    )
  }

  console.log('\n结论要点：')
  console.log('  · 若 lossless 全为 ok 且规格 16/44100，说明 CD 级无损可用；')
  console.log('  · 若 hires / jymaster 出现 24bit 或 48k+，说明我们能比 EngineX 多拿一档；')
  console.log('  · 若 standard 也大量 none，说明该账号连 128k 都取不到，需要会员。')
  console.log(`\n登录态已缓存到 ${SESSION_FILE}（如需换账号加 --relogin）`)
}

main().catch((error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause
  const detail = cause ? `（${cause.code || ''} ${cause.message || ''}）` : ''
  console.error(`\n探针失败：${error instanceof Error ? error.message : String(error)}${detail}`)
  process.exit(1)
})
