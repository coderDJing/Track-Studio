const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F]/g

export const sanitizeSetExportNamePart = (value: string): string => {
  const cleaned = String(value || '')
    .replace(WINDOWS_FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .trim()
  return cleaned
}

export const padSetExportIndex = (index: number, total: number): string => {
  const safeIndex = Math.max(1, Math.floor(Number(index)) || 1)
  const safeTotal = Math.max(1, Math.floor(Number(total)) || 1)
  const width = Math.max(2, String(safeTotal).length)
  return String(safeIndex).padStart(width, '0')
}

export const splitExportFileExtension = (fileName: string): { base: string; ext: string } => {
  const name = String(fileName || '')
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0 || lastDot >= name.length - 1) return { base: name, ext: '' }
  return { base: name.slice(0, lastDot), ext: name.slice(lastDot) }
}

export const buildSetFolderExportFileName = (params: {
  index: number
  total: number
  title?: string
  artist?: string
  originalFileName?: string
}): string => {
  const originalName = String(params.originalFileName || '')
  const { base: originalBase, ext } = splitExportFileExtension(originalName)
  const title =
    sanitizeSetExportNamePart(params.title || '') ||
    sanitizeSetExportNamePart(originalBase) ||
    'Track'
  const artist = sanitizeSetExportNamePart(params.artist || '')
  const body = artist ? `${title} - ${artist}` : title
  return `${padSetExportIndex(params.index, params.total)} ${body}${ext}`
}

export const allocateUniqueFileName = (
  fileName: string,
  usedKeys: Set<string>,
  options: { caseInsensitive?: boolean } = {}
): string => {
  const caseInsensitive = options.caseInsensitive !== false
  const keyOf = (name: string) => (caseInsensitive ? name.toLowerCase() : name)
  const { base, ext } = splitExportFileExtension(fileName)
  let candidate = fileName
  for (let index = 2; usedKeys.has(keyOf(candidate)); index += 1) {
    candidate = `${base} (${index})${ext}`
  }
  usedKeys.add(keyOf(candidate))
  return candidate
}
