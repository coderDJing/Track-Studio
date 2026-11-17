import fs from 'fs-extra'
import path from 'path'
import { normalizeSongHotCues } from '../../../shared/hotCues'
import { normalizeSongMemoryCues } from '../../../shared/memoryCues'
import { normalizePlaylistTrackNumber } from '../../../shared/playlistTrackOrder'
import type {
  RekordboxXmlExportRequest,
  RekordboxXmlExportSourceLibraryName,
  RekordboxXmlExportTrackInput
} from '../../../shared/rekordboxXmlExport'

const SUPPORTED_SOURCE_LIBRARIES = new Set<RekordboxXmlExportSourceLibraryName>([
  'FilterLibrary',
  'CuratedLibrary',
  'SetLibrary',
  'NeteaseLibrary'
])

const normalizeComparePath = (value: string) => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const isSupportedRekordboxXmlExportLibrary = (
  value: string
): value is RekordboxXmlExportSourceLibraryName =>
  SUPPORTED_SOURCE_LIBRARIES.has(value as RekordboxXmlExportSourceLibraryName)

const isPathInside = (targetPath: string, basePath: string) => {
  const normalizedTarget = normalizeComparePath(targetPath)
  const normalizedBase = normalizeComparePath(basePath)
  if (normalizedTarget === normalizedBase) return true
  const prefix = normalizedBase.endsWith(path.sep) ? normalizedBase : `${normalizedBase}${path.sep}`
  return normalizedTarget.startsWith(prefix)
}

export const sanitizePathSegment = (value: string, fallback: string) => {
  const trimmed = String(value || '').trim()
  const stripped = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const normalized = stripped.replace(/[. ]+$/g, '').trim()
  return normalized || fallback
}

export const normalizeXmlFileName = (value: string, fallbackBaseName: string) => {
  const trimmed = String(value || '').trim()
  const fallback = `${sanitizePathSegment(fallbackBaseName, 'rekordbox-export')}.xml`
  if (!trimmed) return fallback
  const ext = path.extname(trimmed).trim()
  const base = ext ? trimmed.slice(0, -ext.length) : trimmed
  const normalizedBase = sanitizePathSegment(base, path.parse(fallback).name)
  return `${normalizedBase}.xml`
}

export const normalizePlaylistName = (value: string, fallback: string) =>
  String(value || '').trim() || fallback

export const validateExportRootDir = async (targetRootDir: string, databaseDir: string) => {
  const normalizedTarget = String(targetRootDir || '').trim()
  if (!normalizedTarget) {
    return { ok: false as const, code: 'TARGET_ROOT_REQUIRED', message: '缺少导出目录。' }
  }
  const resolvedTarget = path.resolve(normalizedTarget)
  const resolvedDatabaseDir = path.resolve(String(databaseDir || '').trim() || process.cwd())
  if (isPathInside(resolvedTarget, resolvedDatabaseDir)) {
    return {
      ok: false as const,
      code: 'TARGET_INSIDE_LIBRARY',
      message: '导出目录不能位于当前音乐库目录内部。'
    }
  }
  return { ok: true as const, resolvedTarget }
}

export const validateSelectedTrackInputs = (tracks: RekordboxXmlExportTrackInput[]) => {
  const normalized = Array.isArray(tracks)
    ? tracks.filter(
        (item): item is RekordboxXmlExportTrackInput =>
          !!item && typeof item.filePath === 'string' && item.filePath.trim().length > 0
      )
    : []
  if (normalized.length === 0) {
    return {
      ok: false as const,
      code: 'NO_TRACKS',
      message: '没有可导出的曲目。'
    }
  }
  return {
    ok: true as const,
    tracks: normalized.map((item) => ({
      filePath: path.resolve(item.filePath),
      displayName: String(item.displayName || '').trim(),
      playlistTrackNumber: normalizePlaylistTrackNumber(item.playlistTrackNumber),
      artist: String(item.artist || '').trim(),
      album: String(item.album || '').trim(),
      genre: String(item.genre || '').trim(),
      label: String(item.label || '').trim(),
      bitrate: typeof item.bitrate === 'number' ? item.bitrate : undefined,
      duration: String(item.duration || '').trim(),
      hotCues: normalizeSongHotCues(item.hotCues),
      memoryCues: normalizeSongMemoryCues(item.memoryCues),
      setItemId: String(item.setItemId || '').trim() || undefined
    }))
  }
}

export const collectMissingSourcePaths = async (sourcePaths: string[]) => {
  const missing: string[] = []
  for (const sourcePath of sourcePaths) {
    try {
      const exists = await fs.pathExists(sourcePath)
      if (!exists) missing.push(sourcePath)
    } catch {
      missing.push(sourcePath)
    }
  }
  return missing
}

export const validateRequestLibrary = (request: RekordboxXmlExportRequest) => {
  if (!isSupportedRekordboxXmlExportLibrary(request.sourceLibraryName)) {
    return {
      ok: false as const,
      code: 'UNSUPPORTED_LIBRARY',
      message: '当前来源暂不支持导出到 Rekordbox XML。'
    }
  }
  if (request.sourceLibraryName === 'NeteaseLibrary' && request.mode === 'move') {
    return {
      ok: false as const,
      code: 'MOVE_NOT_ALLOWED',
      message: '网易云曲目只能复制导出，不能移动缓存文件。'
    }
  }
  return { ok: true as const }
}
