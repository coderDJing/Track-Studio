import path from 'node:path'
import util from 'node:util'
import fs = require('fs-extra')

type ElectronAppLike = {
  isPackaged?: boolean
  getVersion?: () => string
  getPath?: (name: string) => string
  getAppPath?: () => string
}

type ElectronShellLike = {
  openPath: (fullPath: string) => Promise<string>
  showItemInFolder: (fullPath: string) => void | Promise<void>
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type ConsoleMethod = LogLevel | 'log'

type LoggerLike = {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const CONSOLE_METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug']

const safeRequire = (id: string): unknown => {
  try {
    return require(id)
  } catch {
    return null
  }
}

const electronModule =
  (safeRequire('electron') as {
    app?: ElectronAppLike
    shell?: ElectronShellLike
  } | null) || null

const electronApp = electronModule?.app || null
const electronShell = electronModule?.shell || null

const originalConsoleMethods: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
}

let logConfigured = false
let consoleHookInstalled = false

const safeConsoleWrite = (method: ConsoleMethod, args: unknown[]) => {
  try {
    const writer = originalConsoleMethods[method] || originalConsoleMethods.log
    writer(...args)
  } catch {}
}

const resolveUserDataDir = () => {
  try {
    const resolved = electronApp?.getPath?.('userData')
    if (typeof resolved === 'string' && resolved.trim()) {
      return resolved.trim()
    }
  } catch {}
  return process.cwd()
}

const isPackagedRuntime = (() => {
  try {
    return !!(electronApp && typeof electronApp.isPackaged === 'boolean' && electronApp.isPackaged)
  } catch {
    return false
  }
})()

const resolveDevProjectRoot = () => {
  const candidates = [
    process.env.INIT_CWD,
    process.cwd(),
    (() => {
      try {
        return electronApp?.getAppPath?.()
      } catch {
        return ''
      }
    })()
  ]
  for (const candidate of candidates) {
    const normalized = typeof candidate === 'string' ? candidate.trim() : ''
    if (normalized) return normalized
  }
  return process.cwd()
}

const resolveAppVersion = () => {
  try {
    const resolved = electronApp?.getVersion?.()
    if (typeof resolved === 'string' && resolved.trim()) {
      return resolved.trim()
    }
  } catch {}
  return 'unknown'
}

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    return value.stack || value.message || String(value)
  }
  return util.inspect(value, {
    depth: 6,
    breakLength: 140,
    compact: false,
    maxArrayLength: 200,
    maxStringLength: 10_000
  })
}

const formatArgs = (args: unknown[]): string => {
  return args
    .map((item) => formatValue(item))
    .map((item) => String(item || '').replace(/\r\n?/g, '\n'))
    .join(' ')
    .trim()
}

const resolveLogPath = () => {
  if (isPackagedRuntime) {
    return path.join(resolveUserDataDir(), 'log.txt')
  }
  return path.join(resolveDevProjectRoot(), 'log.txt')
}

const LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
const LOG_TRIM_TARGET_BYTES = 5 * 1024 * 1024 // 超限时删除前 5MB

const trimLogFileIfNeeded = (filePath: string) => {
  try {
    const stat = fs.statSync(filePath)
    if (!stat || stat.size <= LOG_MAX_SIZE_BYTES) return
    const content = fs.readFileSync(filePath, 'utf8')
    const trimFrom = content.length - LOG_TRIM_TARGET_BYTES
    if (trimFrom <= 0) return
    const newlineIndex = content.indexOf('\n', trimFrom)
    const trimmed = newlineIndex >= 0 ? content.slice(newlineIndex + 1) : content.slice(trimFrom)
    fs.writeFileSync(filePath, trimmed, 'utf8')
  } catch {}
}

const appendFormattedLogSync = (level: LogLevel, text: string) => {
  const normalizedText = String(text || '').trim()
  if (!normalizedText) return
  const timestamp = new Date().toISOString()
  const versionTag = `[v${resolveAppVersion()}]`
  const levelTag = `[${level.toUpperCase()}]`
  const lines = normalizedText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => `${timestamp} ${versionTag} ${levelTag} ${line}`)
  if (lines.length === 0) return
  try {
    const filePath = getLogPath()
    fs.ensureFileSync(filePath)
    trimLogFileIfNeeded(filePath)
    fs.appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
  } catch (error) {
    safeConsoleWrite('error', ['[log] 写入日志失败', error])
  }
}

const writeLog = (level: LogLevel, args: unknown[], mirrorMethod: ConsoleMethod) => {
  ensureLogConfigured()
  safeConsoleWrite(mirrorMethod, args)
  appendFormattedLogSync(level, formatArgs(args))
}

const installMainConsoleHook = () => {
  if (consoleHookInstalled) return
  consoleHookInstalled = true
  const consoleRecord = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>
  for (const method of CONSOLE_METHODS) {
    consoleRecord[method] = (...args: unknown[]) => {
      safeConsoleWrite(method, args)
      if (method === 'error') {
        appendFormattedLogSync('error', formatArgs(args))
      }
    }
  }
}

export const log: LoggerLike = {
  debug: (...args: unknown[]) => writeLog('debug', args, 'debug'),
  info: (...args: unknown[]) => writeLog('info', args, 'info'),
  warn: (...args: unknown[]) => writeLog('warn', args, 'warn'),
  error: (...args: unknown[]) => writeLog('error', args, 'error')
}

export function configureLogTransports(): void {
  if (logConfigured) return
  logConfigured = true
  installMainConsoleHook()
  try {
    fs.ensureFileSync(resolveLogPath())
  } catch (error) {
    safeConsoleWrite('error', ['[log] 初始化日志文件失败', error])
  }
}

function ensureLogConfigured(): void {
  if (logConfigured) return
  configureLogTransports()
}

export function getLogPath(): string {
  ensureLogConfigured()
  return resolveLogPath()
}

export function clearLogFileSync(): void {
  try {
    fs.outputFileSync(getLogPath(), '')
  } catch (error) {
    safeConsoleWrite('error', ['[log] 清空日志失败', error])
  }
}

export async function openLogFile(): Promise<void> {
  const logPath = getLogPath()
  try {
    await fs.ensureFile(logPath)
    if (!electronShell) return
    const result = await electronShell.openPath(logPath)
    if (result) {
      await electronShell.showItemInFolder(logPath)
    }
  } catch (error) {
    safeConsoleWrite('error', ['[log] 打开日志文件失败', error])
    try {
      await electronShell?.showItemInFolder(logPath)
    } catch {}
  }
}

export async function showLogInFolder(): Promise<void> {
  const logPath = getLogPath()
  try {
    await fs.ensureFile(logPath)
    await electronShell?.showItemInFolder(logPath)
  } catch (error) {
    safeConsoleWrite('error', ['[log] 在文件管理器中打开日志失败', error])
  }
}

type ExpectedErrorRule = {
  code?: string
  messageIncludes?: RegExp
}

type ErrorLike = {
  code?: unknown
  message?: unknown
}

const expectedErrorRules: ExpectedErrorRule[] = [
  { code: 'ENOSPC' },
  { messageIncludes: /no space left on device/i }
]

function isExpectedError(error: unknown): boolean {
  try {
    const err = (error && typeof error === 'object' ? error : null) as ErrorLike | null
    const code = String(err?.code || '').toUpperCase()
    const message = String(err?.message || '')
    for (const rule of expectedErrorRules) {
      if (rule.code && code === rule.code) return true
      if (rule.messageIncludes && rule.messageIncludes.test(message)) return true
    }
    return false
  } catch {
    return false
  }
}

process.on('uncaughtException', (error) => {
  if (isExpectedError(error)) return
  ensureLogConfigured()
  log.error(error)
})

process.on('unhandledRejection', (reason: unknown, promise) => {
  if (isExpectedError(reason)) return
  ensureLogConfigured()
  log.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
