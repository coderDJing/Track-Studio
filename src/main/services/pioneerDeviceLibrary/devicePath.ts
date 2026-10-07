import path from 'node:path'

/** Native device paths start with '/', while runtime paths may already contain the volume root. */
export const resolvePioneerDevicePath = (
  rootPath: string,
  devicePath: string,
  options?: { pathStyle?: 'win32' | 'posix' }
): string => {
  const style = options?.pathStyle || (process.platform === 'win32' ? 'win32' : 'posix')
  const paths = style === 'win32' ? path.win32 : path.posix
  const root = String(rootPath || '')
    .trim()
    .replace(/\\/g, '/')
  const input = String(devicePath || '')
    .trim()
    .replace(/\\/g, '/')
  if (!root || !input) return ''
  const explicitHostPath = /^[a-zA-Z]:/.test(input) || input.startsWith('//')
  if (
    !paths.isAbsolute(root) ||
    (style === 'win32' && !/^[a-zA-Z]:\//.test(root) && !root.startsWith('//'))
  )
    throw new Error('设备根目录必须为绝对路径')
  const parts = input.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '..' || part === '.' || part.includes('\0')))
    throw new Error('设备文件路径包含非法目录')
  const normalizedRoot = paths.resolve(root)
  const inside = (candidate: string) => {
    const relative = paths.relative(normalizedRoot, candidate)
    return Boolean(
      relative &&
      relative !== '..' &&
      !relative.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(relative)
    )
  }
  if (paths.isAbsolute(input) && (style === 'posix' || explicitHostPath)) {
    const absolute = paths.normalize(input)
    if (inside(absolute)) return absolute
  }
  if (explicitHostPath || parts.some((part) => part.includes(':')))
    throw new Error('设备文件路径超出设备范围')
  // A native '/PIONEER/...' is volume-relative on both supported platforms.
  const result = paths.resolve(normalizedRoot, ...parts)
  if (!inside(result)) throw new Error('设备文件路径超出设备范围')
  return result
}
