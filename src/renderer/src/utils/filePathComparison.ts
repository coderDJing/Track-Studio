import {
  isCurrentRendererWindowsPathPlatform,
  normalizeFilePathForComparison
} from '@shared/filePathComparison'

// 只生成比较键；磁盘操作、IPC 和显示始终保留原始路径。
export const rendererFilePathKey = (filePath: string | null | undefined): string =>
  normalizeFilePathForComparison(filePath, isCurrentRendererWindowsPathPlatform())

export const sameRendererFilePath = (left: unknown, right: unknown): boolean => {
  if (typeof left !== 'string' || typeof right !== 'string') return left === right
  return rendererFilePathKey(left) === rendererFilePathKey(right)
}

export const uniqueRendererFilePaths = (filePaths: readonly string[]): string[] => {
  const byKey = new Map<string, string>()
  for (const filePath of filePaths) {
    const key = rendererFilePathKey(filePath)
    if (key && !byKey.has(key)) byKey.set(key, filePath)
  }
  return [...byKey.values()]
}

// 查找按比较键，遍历仍返回首次传入的原路径，避免把小写键发送给磁盘 / IPC。
export class RendererFilePathMap<T> extends Map<string, T> {
  private readonly pathsByKey = new Map<string, string>()

  constructor(entries?: Iterable<readonly [string, T]>) {
    super()
    if (entries) for (const [filePath, value] of entries) this.set(filePath, value)
  }

  override set(filePath: string, value: T): this {
    const key = rendererFilePathKey(filePath)
    const original = this.pathsByKey.get(key) ?? filePath
    this.pathsByKey.set(key, original)
    super.set(original, value)
    return this
  }

  override get(filePath: string): T | undefined {
    const original = this.pathsByKey.get(rendererFilePathKey(filePath))
    return original === undefined ? undefined : super.get(original)
  }

  override has(filePath: string): boolean {
    return this.pathsByKey.has(rendererFilePathKey(filePath))
  }

  override delete(filePath: string): boolean {
    const key = rendererFilePathKey(filePath)
    const original = this.pathsByKey.get(key)
    if (original === undefined) return false
    this.pathsByKey.delete(key)
    return super.delete(original)
  }

  override clear(): void {
    this.pathsByKey.clear()
    super.clear()
  }
}

export class RendererFilePathSet extends Set<string> {
  private readonly pathsByKey = new Map<string, string>()

  constructor(values?: Iterable<string>) {
    super()
    if (values) for (const filePath of values) this.add(filePath)
  }

  override add(filePath: string): this {
    const key = rendererFilePathKey(filePath)
    const original = this.pathsByKey.get(key) ?? filePath
    this.pathsByKey.set(key, original)
    super.add(original)
    return this
  }

  override has(filePath: string): boolean {
    return this.pathsByKey.has(rendererFilePathKey(filePath))
  }

  override delete(filePath: string): boolean {
    const key = rendererFilePathKey(filePath)
    const original = this.pathsByKey.get(key)
    if (original === undefined) return false
    this.pathsByKey.delete(key)
    return super.delete(original)
  }

  override clear(): void {
    this.pathsByKey.clear()
    super.clear()
  }
}
