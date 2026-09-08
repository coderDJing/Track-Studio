export const isWindowsPathPlatform = (platform: string | undefined | null): boolean => {
  const normalized = String(platform || '')
    .trim()
    .toLowerCase()
  return normalized === 'win32' || normalized === 'windows'
}

export const isCurrentRendererWindowsPathPlatform = (): boolean =>
  typeof navigator !== 'undefined' && isWindowsPathPlatform(navigator.platform)

export const normalizeFilePathForComparison = (
  value: string | undefined | null,
  caseInsensitive: boolean
): string => {
  const normalized = String(value || '')
    .trim()
    .replace(/\\/g, '/')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}
