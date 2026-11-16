import fs from 'fs-extra'
import { safeStorage } from 'electron'
import { log } from '../log'
import { neteaseClient } from './client'
import { getNeteaseSessionFile } from './paths'

/**
 * 登录态持久化。
 *
 * cookie 等价于账号密码，不写数据库（数据库可能被用户拿去同步或备份），
 * 单独放在库根的 `.netease-session`，内容用 Electron safeStorage 加密（Windows 走 DPAPI）。
 *
 * safeStorage 不可用时（少数 Linux 无 keyring 环境）**不落盘**，只保留内存态：
 * 宁可每次启动重新扫码，也不把明文 cookie 写到磁盘上。
 */

type SessionPayload = {
  cookie: string
  userId: string
  nickname: string
}

let warnedNoCrypto = false
/** undefined = 还没读过磁盘；登录/登出之后都是确定值 */
let currentSession: SessionPayload | null | undefined

function parseSessionPayload(raw: string): SessionPayload | null {
  const parsed = JSON.parse(raw) as Partial<SessionPayload>
  if (!parsed?.cookie) return null
  return {
    cookie: String(parsed.cookie),
    userId: String(parsed.userId || ''),
    nickname: String(parsed.nickname || '')
  }
}

function readSessionFromDiskSync(): SessionPayload | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const file = getNeteaseSessionFile()
    if (!fs.existsSync(file)) return null
    return parseSessionPayload(safeStorage.decryptString(fs.readFileSync(file)))
  } catch (error) {
    log.warn('[netease] 读取登录态失败，按未登录处理', error)
    return null
  }
}

/** 当前会话（同步可读，给 getLibrary 注入子树用）。未登录返回 null。 */
export function getCurrentSession(): SessionPayload | null {
  if (currentSession === undefined) {
    currentSession = readSessionFromDiskSync()
  }
  return currentSession
}

export function getLoggedInUserId(): string {
  return String(getCurrentSession()?.userId || '').trim()
}

export async function saveSession(payload: SessionPayload): Promise<void> {
  currentSession = payload
  if (!safeStorage.isEncryptionAvailable()) {
    if (!warnedNoCrypto) {
      warnedNoCrypto = true
      log.warn('[netease] safeStorage 不可用，登录态只保留在内存中（重启后需重新扫码）')
    }
    return
  }
  try {
    const encrypted = safeStorage.encryptString(JSON.stringify(payload))
    await fs.writeFile(getNeteaseSessionFile(), encrypted, { mode: 0o600 })
  } catch (error) {
    log.warn('[netease] 保存登录态失败', error)
  }
}

export async function loadSession(): Promise<SessionPayload | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    return getCurrentSession()
  }
  try {
    const file = getNeteaseSessionFile()
    if (!(await fs.pathExists(file))) {
      // 刚登录时文件可能还在写，不能把内存里已经有的会话清掉
      if (currentSession) return currentSession
      currentSession = null
      return null
    }
    const parsed = parseSessionPayload(safeStorage.decryptString(await fs.readFile(file)))
    if (!parsed && currentSession) return currentSession
    currentSession = parsed
    return parsed
  } catch (error) {
    log.warn('[netease] 读取登录态失败，按未登录处理', error)
    if (currentSession) return currentSession
    currentSession = null
    return null
  }
}

export async function clearSession(): Promise<void> {
  currentSession = null
  try {
    const file = getNeteaseSessionFile()
    if (await fs.pathExists(file)) await fs.remove(file)
  } catch (error) {
    log.warn('[netease] 清除登录态失败', error)
  }
  neteaseClient.clearCookies()
}

/** 启动时恢复一次；失败就当未登录 */
export async function restoreSessionIntoClient(): Promise<boolean> {
  const session = await loadSession()
  if (!session) return false
  neteaseClient.importCookies(session.cookie)
  return neteaseClient.isLoggedIn
}
