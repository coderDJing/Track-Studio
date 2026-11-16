import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

export type MacUpdateStrategy = 'in-place' | 'manual'

const DEVELOPER_ID_AUTHORITY = 'Authority=Developer ID Application'

let cachedStrategy: MacUpdateStrategy | null = null

/** 当前运行产物的 .app 根目录，例如 /Applications/Track Studio.app */
export const resolveAppBundlePath = (): string =>
  path.resolve(path.dirname(process.execPath), '..', '..')

const isWritableDirectory = (target: string): boolean => {
  try {
    fs.accessSync(target, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 当前运行的应用是不是用 Developer ID 证书签的。
 * Squirrel.Mac 要求更新包与当前应用是同一签名身份，否则会拒绝安装，
 * 所以从旧的未签名版本直接跳到签名版本时必须走手动替换。
 */
const isDeveloperIdSigned = (appBundlePath: string): boolean => {
  try {
    const result = spawnSync('codesign', ['-dvvv', appBundlePath], { encoding: 'utf8' })
    if (result.error) return false
    const output = `${result.stdout || ''}${result.stderr || ''}`
    return output.includes(DEVELOPER_ID_AUTHORITY)
  } catch {
    return false
  }
}

/**
 * 决定 macOS 用哪种方式更新：
 * - in-place：交给 electron-updater 原地替换应用包，重启即完成升级；
 * - manual：退回「下载压缩包后手动替换」的流程。
 *
 * 原地更新要求同时满足三个条件：
 * 1. 已经是打包后的正式产物（开发态没有可替换的安装目录）；
 * 2. 应用装在可写目录（从挂载的 DMG 或只读卷直接运行就替换不了）；
 * 3. 当前应用已用 Developer ID 证书签名（见上面的签名身份说明）。
 */
export const resolveMacUpdateStrategy = (): MacUpdateStrategy => {
  if (cachedStrategy) return cachedStrategy
  cachedStrategy = computeMacUpdateStrategy()
  return cachedStrategy
}

const computeMacUpdateStrategy = (): MacUpdateStrategy => {
  if (process.platform !== 'darwin') return 'manual'
  if (!app.isPackaged) return 'manual'

  const appBundlePath = resolveAppBundlePath()
  // 直接从挂载的 DMG 运行：卷是只读的，原地替换必然失败。
  if (appBundlePath.startsWith('/Volumes/')) return 'manual'
  // Squirrel.Mac 需要把新的 .app 放回原安装位置，父目录与应用包本身都要可写。
  if (!isWritableDirectory(path.dirname(appBundlePath))) return 'manual'
  if (!isWritableDirectory(appBundlePath)) return 'manual'
  if (!isDeveloperIdSigned(appBundlePath)) return 'manual'
  return 'in-place'
}
