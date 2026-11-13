import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import childProcess from 'node:child_process'
import { list, type ReadEntry } from 'tar'

const ARCHIVE_EXTRACT_TIMEOUT_MS = 20 * 60_000

export type RekordboxRuntimeArchiveEntryType =
  'file' | 'directory' | 'symlink' | 'hardlink' | 'other'

export type RekordboxRuntimeArchiveEntry = {
  path: string
  type: RekordboxRuntimeArchiveEntryType
  linkPath?: string
  size: number
}

const toArchiveEntryType = (type: ReadEntry['type']): RekordboxRuntimeArchiveEntryType => {
  if (type === 'File' || type === 'OldFile' || type === 'ContiguousFile') return 'file'
  if (type === 'Directory' || type === 'GNUDumpDir') return 'directory'
  if (type === 'SymbolicLink') return 'symlink'
  if (type === 'Link') return 'hardlink'
  return 'other'
}

/**
 * 用 tar 官方解析器读取真实 entry（含 GNU 长路径 / PAX 全局与扩展头 / 长链接），
 * `strict` 让格式异常或非法头直接失败，而不是被静默忽略。
 */
export const inspectTarGzEntries = async (
  archivePath: string
): Promise<RekordboxRuntimeArchiveEntry[]> => {
  const entries: RekordboxRuntimeArchiveEntry[] = []
  await list({
    file: archivePath,
    strict: true,
    onReadEntry: (entry: ReadEntry) => {
      // PAX/GNU 长路径等元数据条目由 tar 合并到真正的 entry，不参与路径策略。
      if (entry.meta) return
      entries.push({
        path: entry.path,
        type: toArchiveEntryType(entry.type),
        ...(entry.linkpath ? { linkPath: entry.linkpath } : {}),
        size: entry.size
      })
    }
  })
  return entries
}

/** 用系统 tar 解压（win/mac 均为 bsdtar，保留 symlink 与执行位）。 */
export const extractTarGzArchive = async (
  archivePath: string,
  outputDir: string
): Promise<void> => {
  await fsPromises.mkdir(outputDir, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn('tar', ['-xzf', archivePath, '-C', outputDir], {
      windowsHide: true
    })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('tar extract timeout'))
    }, ARCHIVE_EXTRACT_TIMEOUT_MS)
    timer.unref?.()
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `tar exit ${String(code ?? '')}`))
    })
  })
}

const isInsideOrEqual = (rootRelative: string, candidate: string): boolean =>
  candidate === rootRelative || candidate.startsWith(`${rootRelative}/`)

const toPosix = (value: string) => value.replace(/\\/g, '/')

export type ArchiveEntryValidationResult = { ok: true } | { ok: false; reason: string }

/**
 * 归档条目策略：
 * - 只允许 `<platform>` 目录本身及其下级路径；
 * - 拒绝绝对路径、盘符、反斜杠、`.`/`..` 段；
 * - symlink 目标必须是归档内的相对路径，且解析后仍位于 `<platform>` 下；
 * - hardlink 目标必须是归档内 `<platform>` 下的路径；
 * - 设备/管道等其它类型一律拒绝。
 */
export const validateArchiveEntriesForPlatform = (
  entries: readonly RekordboxRuntimeArchiveEntry[],
  platformKey: string,
  normalizeRelativePath: (value: unknown) => string | null
): ArchiveEntryValidationResult => {
  if (entries.length === 0) return { ok: false, reason: 'archive-empty' }
  for (const entry of entries) {
    // 目录条目通常以 `/` 结尾（如 `win32-x64/`），先去掉尾部斜杠再校验。
    const rawPath =
      entry.type === 'directory' ? String(entry.path || '').replace(/\/+$/, '') : entry.path
    const normalized = normalizeRelativePath(rawPath)
    if (!normalized) return { ok: false, reason: `unsafe-path:${entry.path}` }
    if (!isInsideOrEqual(platformKey, normalized)) {
      return { ok: false, reason: `outside-platform:${entry.path}` }
    }
    if (entry.type === 'other') return { ok: false, reason: `unsupported-entry:${entry.path}` }
    if (entry.type !== 'symlink' && entry.type !== 'hardlink') continue
    const rawLink = toPosix(String(entry.linkPath || '').trim())
    if (!rawLink) return { ok: false, reason: `missing-link:${entry.path}` }
    if (rawLink.startsWith('/') || /^[A-Za-z]:/.test(rawLink) || rawLink.includes('\\')) {
      return { ok: false, reason: `unsafe-link:${entry.path}` }
    }
    const resolved =
      entry.type === 'symlink'
        ? path.posix.normalize(path.posix.join(path.posix.dirname(normalized), rawLink))
        : path.posix.normalize(rawLink)
    if (!isInsideOrEqual(platformKey, resolved)) {
      return { ok: false, reason: `link-escapes:${entry.path}->${rawLink}` }
    }
  }
  return { ok: true }
}

/** 解压后再走一遍，确认没有指向 staging 之外的 symlink（防绕过预检）。 */
export const assertNoEscapingSymlinks = async (rootPath: string): Promise<void> => {
  const root = path.resolve(rootPath)
  const walk = async (dir: string): Promise<void> => {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const linkTarget = await fsPromises.readlink(entryPath)
        const resolved = path.resolve(path.dirname(entryPath), linkTarget)
        const relative = path.relative(root, resolved)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`symlink escapes staging: ${entryPath} -> ${linkTarget}`)
        }
        continue
      }
      if (entry.isDirectory()) await walk(entryPath)
    }
  }
  if (!fs.existsSync(root)) return
  await walk(root)
}
