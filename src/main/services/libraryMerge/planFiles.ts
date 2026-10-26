import fs from 'node:fs/promises'
import path from 'node:path'
import { v4 as uuidV4 } from 'uuid'
import type { PlannedFile } from './plan'
import { LibraryMergeError } from './types'
import { mainFilePathKey } from '../../filePathComparison'

const CONTROL_FILE_NAMES = new Set(['.frkb.uuid', '.description.json', '.description.json.legacy'])

// These are generated from persistent library data and are safe to rebuild. They must never
// contribute to a merge's copied payload or capacity estimate.
export const LIBRARY_MERGE_IGNORED_CACHE_DIRECTORY_NAMES = ['.frkb_covers', '.frkb_cache'] as const

const isIgnoredCacheDirectoryName = (value: string): boolean =>
  LIBRARY_MERGE_IGNORED_CACHE_DIRECTORY_NAMES.some(
    (directoryName) => normalizeNameKey(directoryName) === normalizeNameKey(value)
  )

type SourceFile = {
  sourceAbs: string
  relativePath: string
  size: number
  mtimeMs: number
}

const normalizeNameKey = (value: string): string => {
  const normalized = String(value || '').normalize('NFC')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

const assertDirectory = async (dirPath: string, code: string): Promise<void> => {
  const stat = await fs.lstat(dirPath).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new LibraryMergeError(code, `缺少或无法访问目录：${dirPath}`)
  }
}

const getSafeRelativePath = (value: string, description: string): string => {
  const normalized = path.normalize(value)
  if (
    !normalized ||
    normalized === '.' ||
    path.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new LibraryMergeError(
      'SOURCE_TREE_INVALID',
      `来源库包含不安全的${description}路径：${value}`
    )
  }
  return normalized
}

const listRegularFilesRecursively = async (
  rootDir: string,
  ignoredDirectoryNames: readonly string[] = LIBRARY_MERGE_IGNORED_CACHE_DIRECTORY_NAMES
): Promise<SourceFile[]> => {
  await assertDirectory(rootDir, 'SOURCE_TREE_INVALID')
  const ignoredNames = new Set(ignoredDirectoryNames.map(normalizeNameKey))
  const files: SourceFile[] = []
  const walk = async (currentDir: string, relativeDir: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (CONTROL_FILE_NAMES.has(entry.name)) continue
      const sourceAbs = path.join(currentDir, entry.name)
      const relativePath = getSafeRelativePath(path.join(relativeDir, entry.name), '文件')
      const stat = await fs.lstat(sourceAbs)
      if (stat.isSymbolicLink()) {
        throw new LibraryMergeError('SOURCE_FILE_UNSAFE', `来源库包含符号链接：${sourceAbs}`)
      }
      if (stat.isDirectory()) {
        if (ignoredNames.has(normalizeNameKey(entry.name))) continue
        await walk(sourceAbs, relativePath)
        continue
      }
      if (!stat.isFile()) {
        throw new LibraryMergeError(
          'SOURCE_FILE_UNSAFE',
          `来源库包含不支持的文件类型：${sourceAbs}`
        )
      }
      files.push({ sourceAbs, relativePath, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  await walk(rootDir, '')
  return files
}

export const assertLeafDirectoryHasNoUserContent = async (
  dirPath: string,
  nodeLabel: string
): Promise<void> => {
  const files = await listRegularFilesRecursively(dirPath)
  if (files.length > 0) {
    throw new LibraryMergeError(
      'SOURCE_TREE_INVALID',
      `来源库的 ${nodeLabel} 不应直接包含文件：${files[0].sourceAbs}`
    )
  }
}

export const assertExpectedDirectoryEntries = async (params: {
  dirPath: string
  expectedDirectoryNames: string[]
  allowedExtraDirectoryNames?: string[]
  allowRegularFiles?: boolean
  code: string
}): Promise<void> => {
  const expectedNames = new Set(params.expectedDirectoryNames.map(normalizeNameKey))
  const extraNames = new Set((params.allowedExtraDirectoryNames || []).map(normalizeNameKey))
  const entries = await fs.readdir(params.dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (CONTROL_FILE_NAMES.has(entry.name)) continue
    const entryPath = path.join(params.dirPath, entry.name)
    const stat = await fs.lstat(entryPath)
    if (stat.isSymbolicLink()) {
      throw new LibraryMergeError('SOURCE_FILE_UNSAFE', `来源库包含符号链接：${entryPath}`)
    }
    const nameKey = normalizeNameKey(entry.name)
    if (isIgnoredCacheDirectoryName(entry.name)) {
      if (!stat.isDirectory()) {
        throw new LibraryMergeError(params.code, `缓存节点不是目录：${entryPath}`)
      }
      continue
    }
    if (expectedNames.has(nameKey) || extraNames.has(nameKey)) {
      if (!stat.isDirectory()) {
        throw new LibraryMergeError(params.code, `库树节点不是目录：${entryPath}`)
      }
      continue
    }
    if (params.allowRegularFiles && stat.isFile()) continue
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new LibraryMergeError('SOURCE_FILE_UNSAFE', `来源库包含不支持的文件类型：${entryPath}`)
    }
    throw new LibraryMergeError(params.code, `来源库目录中存在未登记项目：${entryPath}`)
  }
}

export const getMergeFilePathKey = (
  filePath: string,
  platform: string = process.platform
): string => mainFilePathKey(path.resolve(filePath), platform)

export const uniqueTargetFilePath = async (
  targetRoot: string,
  sourceRelativePath: string,
  sourceLabel: string,
  reservedPaths: Set<string>
): Promise<string> => {
  const relativePath = getSafeRelativePath(sourceRelativePath, '资源')
  const targetDir = path.join(targetRoot, path.dirname(relativePath))
  const fileName = path.basename(relativePath)
  const ext = path.extname(fileName)
  const baseName = path.basename(fileName, ext)
  let index = 1
  while (true) {
    const candidateName =
      index === 1
        ? fileName
        : `${baseName} (from ${sourceLabel}${index === 2 ? '' : ` ${index}`})${ext}`
    const candidate = path.join(targetDir, candidateName)
    // 目标命名保留跨平台防冲突策略；来源身份使用 getMergeFilePathKey 的平台规则。
    const key = getMergeFilePathKey(candidate, 'win32')
    const existing = await fs.lstat(candidate).catch(() => null)
    if (!existing && !reservedPaths.has(key)) {
      reservedPaths.add(key)
      return candidate
    }
    index += 1
  }
}

export const planAssets = async (params: {
  sourceDir: string
  targetDir: string
  sourceLabel: string
  stagePrefix: string
  reservedPaths: Set<string>
  ignoredDirectoryNames?: readonly string[]
}): Promise<PlannedFile[]> => {
  const sourceFiles = await listRegularFilesRecursively(
    params.sourceDir,
    params.ignoredDirectoryNames
  )
  const files: PlannedFile[] = []
  for (const sourceFile of sourceFiles) {
    const targetAbs = await uniqueTargetFilePath(
      params.targetDir,
      sourceFile.relativePath,
      params.sourceLabel,
      params.reservedPaths
    )
    files.push({
      kind: 'asset',
      sourceAbs: sourceFile.sourceAbs,
      stageRel: path.join(params.stagePrefix, uuidV4(), path.basename(targetAbs)),
      targetAbs,
      targetListRoot: '',
      targetFilePath: '',
      size: sourceFile.size,
      mtimeMs: sourceFile.mtimeMs
    })
  }
  return files
}
