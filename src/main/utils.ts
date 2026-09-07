import store from './store'
import { IDir, md5 } from '../types/globals'
import fs = require('fs-extra')
import path = require('path')
import os = require('os')
import type { AudioFileResult, ProcessProgress } from 'rust_package'
import { BrowserWindow, ipcMain, session } from 'electron'
import {
  ensureLibraryTreeBaseline,
  loadLibraryNodes,
  syncLibraryTreeFromDisk
} from './libraryTreeDb'
import { pruneOrphanedSongListCaches } from './services/cacheMaintenance'
import { getMixtapeProjectStemConfig } from './mixtapeDb'
import { CORE_KEYS, ensureEnglishCoreLibraries, getCoreFsDirName } from './coreLibraries'
import { isENOSPCError } from './nodeErrorUtils'

export { ensureEnglishCoreLibraries, getCoreFsDirName } from './coreLibraries'
export { isENOSPCError } from './nodeErrorUtils'

interface SongsAnalyseResult {
  songsAnalyseResult: md5[]
  errorSongsAnalyseResult: md5[]
}

type RustHashBinding = {
  calculateAudioHashesWithProgress: (
    songFilePaths: string[],
    progressCallback: (err: Error | null, progress: ProcessProgress) => void
  ) => Promise<AudioFileResult[]>
  calculateFileHashesWithProgress: (
    songFilePaths: string[],
    progressCallback: (err: Error | null, progress: ProcessProgress) => void
  ) => Promise<AudioFileResult[]>
}

function loadRustHashBinding(): RustHashBinding {
  const binding = require('rust_package') as Partial<RustHashBinding>
  if (
    typeof binding.calculateAudioHashesWithProgress !== 'function' ||
    typeof binding.calculateFileHashesWithProgress !== 'function'
  ) {
    throw new Error('rust_package hash functions unavailable')
  }
  return binding as RustHashBinding
}

export function mapRendererPathToFsPath(rendererPath: string): string {
  // 将渲染层路径中的英文核心库名替换为实际物理目录名
  let p = rendererPath
  for (const enName of CORE_KEYS) {
    const fsName = getCoreFsDirName(enName)
    p = p.replace(new RegExp(`(^|/)${enName}(/|$)`), `$1${fsName}$2`)
  }
  return p
}

type LibraryPathResolution = {
  mappedPath: string
  absPath: string
}

type ResolveLibraryPathOptions = {
  allowRoot?: boolean
}

const getDatabaseRootForLibraryPath = () => {
  const databaseRoot = String(store.databaseDir || '')
  if (!databaseRoot) {
    throw new Error('library database root is not configured')
  }
  return path.resolve(databaseRoot)
}

const isPathInsideRoot = (rootDir: string, targetPath: string, allowRoot: boolean) => {
  const relative = path.relative(rootDir, targetPath)
  if (!relative) return allowRoot
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function resolveLibraryPath(
  rendererPath: string,
  options: ResolveLibraryPathOptions = {}
): LibraryPathResolution {
  const rootDir = getDatabaseRootForLibraryPath()
  const mappedInput = mapRendererPathToFsPath(String(rendererPath || ''))
  if (!mappedInput) {
    throw new Error('library path is empty')
  }
  if (path.isAbsolute(mappedInput)) {
    throw new Error('library path must be relative')
  }

  const absPath = path.resolve(rootDir, mappedInput)
  if (!isPathInsideRoot(rootDir, absPath, !!options.allowRoot)) {
    throw new Error('library path is outside database root')
  }

  return {
    mappedPath: path.relative(rootDir, absPath) || '.',
    absPath
  }
}

export function resolveLibraryChildPath(parentAbsPath: string, childName: string): string {
  const rootDir = getDatabaseRootForLibraryPath()
  const parentPath = path.resolve(parentAbsPath)
  const name = String(childName || '')
  if (!name) {
    throw new Error('library child path is empty')
  }
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    throw new Error('library child path must be a direct child name')
  }
  if (!isPathInsideRoot(rootDir, parentPath, true)) {
    throw new Error('library parent path is outside database root')
  }

  const absPath = path.resolve(parentPath, name)
  if (!isPathInsideRoot(parentPath, absPath, false) || !isPathInsideRoot(rootDir, absPath, false)) {
    throw new Error('library child path is outside database root')
  }
  return absPath
}

export async function getSongsAnalyseResult(
  songFilePaths: string[],
  processFunc: Function
): Promise<SongsAnalyseResult> {
  function progressCallback(err: Error | null, progress: ProcessProgress) {
    if (!err && progress) {
      processFunc(progress.processed)
    }
  }
  // 根据 fingerprintMode 决定调用哪种分析器（暂时仅 PCM，稍后加入整文件哈希）
  const mode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
  const { calculateAudioHashesWithProgress, calculateFileHashesWithProgress } =
    loadRustHashBinding()
  let results: AudioFileResult[]
  if (mode === 'file') {
    results = await calculateFileHashesWithProgress(songFilePaths, progressCallback)
  } else {
    results = await calculateAudioHashesWithProgress(songFilePaths, progressCallback)
  }
  const songsAnalyseResult: md5[] = []
  const errorSongsAnalyseResult: md5[] = []

  for (let item of results) {
    const common: md5 = {
      sha256_Hash: item.sha256Hash,
      file_path: item.filePath,
      error: item.error
    }

    if (item.sha256Hash === 'error') {
      errorSongsAnalyseResult.push(common)
      continue
    }

    songsAnalyseResult.push(common)
  }

  return { songsAnalyseResult, errorSongsAnalyseResult }
}
//获取整个库的树结构
export async function getLibrary(options: { skipSync?: boolean } = {}) {
  const rootDir = store.databaseDir
  if (!rootDir) {
    return { uuid: 'library_root_missing', type: 'root', dirName: 'library', children: [] }
  }
  // 先确保核心库英文化（若失败则回退中文），同时建立英文->FS 名的映射
  await ensureEnglishCoreLibraries(rootDir)
  await ensureLibraryTreeBaseline(rootDir, {
    coreDirNames: {
      FilterLibrary: getCoreFsDirName('FilterLibrary'),
      CuratedLibrary: getCoreFsDirName('CuratedLibrary'),
      SetLibrary: getCoreFsDirName('SetLibrary'),
      MixtapeLibrary: getCoreFsDirName('MixtapeLibrary'),
      RecordingLibrary: getCoreFsDirName('RecordingLibrary'),
      RecycleBin: getCoreFsDirName('RecycleBin')
    }
  })
  if (!options.skipSync) {
    await syncLibraryTreeFromDisk(rootDir, {
      coreDirNames: {
        FilterLibrary: getCoreFsDirName('FilterLibrary'),
        CuratedLibrary: getCoreFsDirName('CuratedLibrary'),
        SetLibrary: getCoreFsDirName('SetLibrary'),
        MixtapeLibrary: getCoreFsDirName('MixtapeLibrary'),
        RecordingLibrary: getCoreFsDirName('RecordingLibrary'),
        RecycleBin: getCoreFsDirName('RecycleBin')
      },
      audioExtensions: store.settingConfig?.audioExt
    })
    await pruneOrphanedSongListCaches(rootDir)
  }

  const rows = loadLibraryNodes(rootDir) || []
  if (rows.length === 0) {
    return { uuid: 'library_root_missing', type: 'root', dirName: 'library', children: [] }
  }

  const fsToRenderer = new Map<string, string>([
    [getCoreFsDirName('FilterLibrary'), 'FilterLibrary'],
    [getCoreFsDirName('CuratedLibrary'), 'CuratedLibrary'],
    [getCoreFsDirName('SetLibrary'), 'SetLibrary'],
    [getCoreFsDirName('RecycleBin'), 'RecycleBin'],
    [getCoreFsDirName('RecordingLibrary'), 'RecordingLibrary'],
    [getCoreFsDirName('MixtapeLibrary'), 'MixtapeLibrary']
  ])

  const nodeMap = new Map<string, IDir>()
  let rootNode: IDir | null = null

  for (const row of rows) {
    let dirName = row.dirName
    if (row.nodeType === 'library') {
      const mapped = fsToRenderer.get(dirName)
      if (mapped) dirName = mapped
    }
    const node: IDir = {
      uuid: row.uuid,
      type: row.nodeType,
      dirName
    }
    if (row.nodeType === 'mixtapeList') {
      const stemConfig = getMixtapeProjectStemConfig(row.uuid)
      node.mixMode = stemConfig.mixMode
      node.stemProfile = stemConfig.stemProfile
    }
    if (row.order !== null) node.order = row.order
    nodeMap.set(row.uuid, node)
  }

  for (const row of rows) {
    const node = nodeMap.get(row.uuid)
    if (!node) continue
    if (row.parentUuid) {
      const parent = nodeMap.get(row.parentUuid)
      if (parent) {
        if (!parent.children) parent.children = []
        parent.children.push(node)
      }
    } else if (!rootNode) {
      rootNode = node
    }
  }

  const resolvedRoot: IDir = rootNode ??
    nodeMap.values().next().value ?? {
      uuid: 'library_root_missing',
      type: 'root',
      dirName: 'library',
      children: []
    }

  const sortChildren = (node: IDir) => {
    if (!node.children || node.children.length === 0) return
    node.children.sort((a, b) => {
      if (a.order === undefined || b.order === undefined) return 0
      return a.order - b.order
    })
    node.children.forEach(sortChildren)
  }

  if (!resolvedRoot.children) resolvedRoot.children = []
  sortChildren(resolvedRoot)
  return resolvedRoot
}

export const operateHiddenFile = async (
  filePath: string,
  operateFunction: () => Promise<unknown> | unknown
) => {
  // 统一 await，无论传入同步/异步
  const run = async () => await Promise.resolve(operateFunction())

  if (os.platform() !== 'win32') {
    // 非 Windows：直接运行
    return run()
  }

  const { execFile } = require('child_process')
  const { promisify } = require('util')
  const execFileAsync = promisify(execFile)

  // 独立处理 attrib 错误，避免覆盖业务异常
  const tryAttrib = async (attribute: '+h' | '-h') => {
    try {
      await execFileAsync('attrib', [attribute, filePath], { windowsHide: true })
    } catch {
      // 静默忽略 attrib 失败（可能：文件不存在、被移动、权限受限）
    }
  }

  // 若存在则去隐藏，再执行业务，最后若存在则设隐藏
  const existedBefore = await fs.pathExists(filePath)
  if (existedBefore) {
    await tryAttrib('-h')
  }
  try {
    await run()
  } finally {
    const existsAfter = await fs.pathExists(filePath)
    if (existsAfter) {
      await tryAttrib('+h')
    }
  }
}

export const collectFilesWithExtensions = async (dir: string, extensions: string[] = []) => {
  let files: string[] = []
  try {
    const stats = await fs.stat(dir)

    if (stats.isFile()) {
      const ext = path.extname(dir).toLowerCase()
      if (extensions.includes(ext)) {
        return [dir]
      } else {
        return []
      }
    }

    // 读取目录中的文件和子目录
    const directoryEntries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of directoryEntries) {
      const fullPath = path.join(dir, entry.name)

      // 如果是文件，检查扩展名
      if (entry.isFile()) {
        const ext = path.extname(fullPath).toLowerCase()
        if (extensions.includes(ext)) {
          files.push(fullPath)
        }
      } else if (entry.isDirectory()) {
        // 如果是目录，递归调用
        const subFiles = await collectFilesWithExtensions(fullPath, extensions)
        files = files.concat(subFiles)
      }
    }

    return files
  } catch (error) {
    return []
  }
}

export async function moveOrCopyItemWithCheckIsExist(
  src: string,
  targetPath: string,
  isMove: boolean
) {
  const isRetryableLock = (error: unknown): boolean => {
    const code = String((error as { code?: unknown })?.code || '')
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EAGAIN'
  }
  let dest = targetPath
  if (await fs.pathExists(targetPath)) {
    let counter = 1
    const baseName = path.basename(targetPath, path.extname(targetPath))
    const extension = path.extname(targetPath)
    const directory = path.dirname(targetPath)
    let newFileName = `${baseName}(${counter})${extension}`
    while (await fs.pathExists(path.join(directory, newFileName))) {
      counter++
      newFileName = `${baseName}(${counter})${extension}`
    }
    dest = path.join(directory, newFileName)
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (isMove) await fs.move(src, dest)
      else await fs.copy(src, dest)
      return dest
    } catch (error) {
      lastError = error
      if (!isRetryableLock(error) || attempt === 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'move failed'))
}

type InterruptedDecision = 'resume' | 'cancel'

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  options: {
    concurrency?: number
    onProgress?: (done: number, total: number) => void
    onInterrupted?: (payload: {
      total: number
      done: number
      running: number
      pending: number
      successSoFar: number
      failedSoFar: number
    }) => Promise<InterruptedDecision>
    stopOnENOSPC?: boolean
    yieldEvery?: number
  } = {}
): Promise<{
  results: Array<T | Error>
  success: number
  failed: number
  hasENOSPC: boolean
  skipped: number
}> {
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 16))
  const yieldEvery = Math.max(0, Math.floor(options.yieldEvery ?? 0))
  const total = tasks.length
  const results: Array<T | Error> = new Array(total)
  let nextIndex = 0
  let inFlight = 0
  let completed = 0
  let hasENOSPC = false
  let interrupted = false
  let cancelled = false
  let skipped = 0

  const retryQueue: number[] = []

  // gate 用于在中断时阻塞调度；resume/cancel 后放行
  let gateResolve: (() => void) | null = null
  let gate: Promise<void> | null = null
  const closeGate = () => {
    if (gateResolve) gateResolve()
    gateResolve = null
    gate = null
  }
  const openGate = () => {
    if (!gate) {
      gate = new Promise<void>((resolve) => {
        gateResolve = resolve
      })
    }
  }

  const maybeYieldToEventLoop = async () => {
    if (yieldEvery <= 0 || completed === 0 || completed % yieldEvery !== 0) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  const getNextTaskIndex = async (): Promise<number | null> => {
    // 若取消，停止调度
    if (cancelled) return null
    // 中断时阻塞，直到 resume/cancel
    if (interrupted && gate) {
      await gate
      if (cancelled) return null
    }
    if (retryQueue.length > 0) {
      return retryQueue.shift() as number
    }
    if (nextIndex < total) {
      const idx = nextIndex
      nextIndex++
      return idx
    }
    return null
  }

  async function handleENOSPC(idx: number, _err: unknown) {
    hasENOSPC = true
    // 记录待重试
    retryQueue.push(idx)
    if (options.stopOnENOSPC !== false) {
      // 首次进入中断
      if (!interrupted) {
        interrupted = true
        openGate()
        if (typeof options.onInterrupted === 'function') {
          const successSoFar = results.filter(
            (r) => r !== undefined && !(r instanceof Error)
          ).length
          const failedSoFar = results.filter((r) => r instanceof Error).length
          const decision = await options.onInterrupted({
            total,
            done: completed,
            running: inFlight,
            pending: total - completed - inFlight,
            successSoFar,
            failedSoFar
          })
          if (decision === 'resume') {
            interrupted = false
            closeGate()
          } else {
            cancelled = true
            // 统计剩余未开始的任务为 skipped（包括重试队列 + 未派发）
            const remaining = total - completed - inFlight
            skipped += remaining
            closeGate()
          }
        }
      }
    }
  }

  async function worker() {
    while (true) {
      const idx = await getNextTaskIndex()
      if (idx === null) break
      inFlight++
      try {
        const val = await tasks[idx]()
        // 成功：若无返回值也要标记成功，避免统计为 0
        results[idx] = val === undefined ? (true as unknown as T) : val
        completed++
        if (options.onProgress) options.onProgress(completed, total)
        await maybeYieldToEventLoop()
      } catch (err: unknown) {
        if (isENOSPCError(err)) {
          await handleENOSPC(idx, err)
          // ENOSPC 情况下不计入完成，等待重试或取消
          if (cancelled) {
            // 取消时，本次失败计入失败
            results[idx] = err instanceof Error ? err : new Error(String(err))
            completed++
            if (options.onProgress) options.onProgress(completed, total)
            await maybeYieldToEventLoop()
          }
        } else {
          // 非 ENOSPC 失败，立即记入结果
          results[idx] = err instanceof Error ? err : new Error(String(err))
          completed++
          if (options.onProgress) options.onProgress(completed, total)
          await maybeYieldToEventLoop()
        }
      } finally {
        inFlight--
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker())
  await Promise.all(workers)

  const failed = results.filter((r) => r instanceof Error).length
  const success = results.filter((r) => r !== undefined && !(r instanceof Error)).length
  return { results, success, failed, hasENOSPC, skipped }
}

// ===== 用户交互：等待渲染层对中断批处理的决策（resume / cancel） =====
const fileOpControllers = new Map<string, (decision: InterruptedDecision) => void>()
let fileOpIpcRegistered = false

export function waitForUserDecision(
  win: BrowserWindow | null,
  batchId: string,
  context: string,
  payload: { total: number; done: number; running: number; pending: number }
): Promise<InterruptedDecision> {
  if (!fileOpIpcRegistered) {
    ipcMain.on('file-op-control', (_e, data: { batchId: string; action: InterruptedDecision }) => {
      const resolve = fileOpControllers.get(data?.batchId)
      if (resolve) {
        resolve(data.action)
        fileOpControllers.delete(data.batchId)
      }
    })
    fileOpIpcRegistered = true
  }
  return new Promise<InterruptedDecision>((resolve) => {
    fileOpControllers.set(batchId, resolve)
    win?.webContents.send('file-op-interrupted', { batchId, context, ...payload })
  })
}

const normalizeProxyUrl = (proxyUrl: string, scheme = 'http') => {
  const normalized = String(proxyUrl || '').trim()
  if (!normalized) return ''
  if (/^[a-z]+:\/\//i.test(normalized)) return normalized
  return `${scheme}://${normalized}`
}

const parseResolvedProxyRules = (proxyRules: string): string => {
  const rules = String(proxyRules || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
  for (const rule of rules) {
    const match = rule.match(/^(PROXY|HTTP|HTTPS)\s+(.+)$/i)
    if (!match) continue
    const protocol = match[1].toUpperCase()
    const target = match[2].trim()
    if (!target) continue
    return normalizeProxyUrl(target, protocol === 'HTTPS' ? 'https' : 'http')
  }
  return ''
}

/**
 * Detect system proxy settings
 * Returns proxy URL (e.g., "http://127.0.0.1:7890") or empty string if not configured
 */
export async function getSystemProxy(): Promise<string> {
  // First check environment variables (highest priority)
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  if (envProxy) {
    return envProxy
  }

  // Chromium session proxy supports PAC / system proxy on macOS and other platforms
  try {
    const resolvedProxy = await session.defaultSession.resolveProxy('https://github.com/')
    const normalizedProxy = parseResolvedProxyRules(resolvedProxy)
    if (normalizedProxy) {
      return normalizedProxy
    }
  } catch {
    // Ignore and fall back to platform-specific probing
  }

  // On Windows, read from registry
  if (os.platform() === 'win32') {
    const { exec } = require('child_process')
    const { promisify } = require('util')
    const execAsync = promisify(exec)

    try {
      // Check if proxy is enabled
      const enableResult = await execAsync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf8' }
      )
      const enableMatch = enableResult.stdout.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/)
      const proxyEnabled = enableMatch && parseInt(enableMatch[1], 16) === 1

      if (!proxyEnabled) {
        return ''
      }

      // Get proxy server address
      const serverResult = await execAsync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { encoding: 'utf8' }
      )
      const serverMatch = serverResult.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/)
      if (serverMatch && serverMatch[1]) {
        const proxyServer = serverMatch[1].trim()
        // Handle different proxy formats
        // Format: "127.0.0.1:7890" or "http=127.0.0.1:7890;https=127.0.0.1:7890"
        if (proxyServer.includes('=')) {
          // Multiple protocols specified, extract https or http
          const parts = proxyServer.split(';')
          for (const part of parts) {
            if (part.startsWith('https=')) {
              const addr = part.substring(6)
              return normalizeProxyUrl(addr)
            }
          }
          for (const part of parts) {
            if (part.startsWith('http=')) {
              const addr = part.substring(5)
              return normalizeProxyUrl(addr)
            }
          }
        }
        // Simple format: "127.0.0.1:7890"
        return normalizeProxyUrl(proxyServer)
      }
    } catch {
      // Registry read failed, return empty
    }
  }

  return ''
}

export function getCurrentTimeYYYYMMDDHHMMSSSSS() {
  let now = new Date()

  let year = now.getFullYear()
  let month = now.getMonth() + 1 // 月份是从0开始的
  let day = now.getDate()
  let hour = now.getHours()
  let minute = now.getMinutes()
  let second = now.getSeconds()
  let millisecond = now.getMilliseconds()

  // 格式化月份、‌日期、‌小时、‌分钟、‌秒和毫秒
  let monthStr = month < 10 ? '0' + month : month
  let dayStr = day < 10 ? '0' + day : day
  let hourStr = hour < 10 ? '0' + hour : hour
  let minuteStr = minute < 10 ? '0' + minute : minute
  let secondStr = second < 10 ? '0' + second : second
  let millisecondStr =
    millisecond < 100 ? (millisecond < 10 ? '00' + millisecond : '0' + millisecond) : millisecond

  return (
    year +
    '' +
    monthStr +
    '' +
    dayStr +
    '' +
    hourStr +
    '' +
    minuteStr +
    '' +
    secondStr +
    '' +
    millisecondStr
  )
}
