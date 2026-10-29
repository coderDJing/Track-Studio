import { app } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import store from '../../store'
import { listSetItemsByPlaylist } from '../../setListDb'
import { hashFileSha256 } from '../../curatedLibrarySync/hashFile'
import { normalizeFilePathForComparison } from '../../../shared/filePathComparison'
import {
  SET_PACKAGE_AUDIO_DIR_NAME,
  SET_PACKAGE_EXTENSION,
  SET_PACKAGE_FORMAT,
  SET_PACKAGE_VERSION
} from '../../../shared/setPackage'
import type { ISongInfo } from '../../../types/globals'
import {
  SetPackageError,
  stripMachineLocalSongFields,
  toPackageRelativePath,
  type SetPackageFileEntry,
  type SetPackageManifest,
  type SetPackageTrackEntry
} from './manifest'

export type ExportSetPackageParams = {
  playlistUuid: string
  setName: string
  /** renderer 通过 setList:load-items 读到的整份 SET，用于保留界面所见的分析结果 */
  songs: ISongInfo[]
  targetParentDir: string
  onProgress?: (done: number, total: number) => void
}

export type ExportSetPackageSummary = {
  packageDir: string
  manifestPath: string
  trackCount: number
  fileCount: number
}

const isWin = process.platform === 'win32'

const filePathKey = (filePath: string) =>
  normalizeFilePathForComparison(path.resolve(filePath), isWin)

const fileNameKey = (fileName: string) => (isWin ? fileName.toLowerCase() : fileName)

export function toSafeSetPackageName(name: string): string {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return cleaned || 'SET'
}

async function resolveUnusedDir(parentDir: string, baseName: string): Promise<string> {
  let candidate = path.join(parentDir, baseName)
  for (let index = 1; await fs.pathExists(candidate); index += 1) {
    candidate = path.join(parentDir, `${baseName} (${index})`)
  }
  return candidate
}

function resolveUnusedFileName(fileName: string, usedKeys: Set<string>): string {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  let candidate = fileName
  for (let index = 2; usedKeys.has(fileNameKey(candidate)); index += 1) {
    candidate = `${base} (${index})${ext}`
  }
  usedKeys.add(fileNameKey(candidate))
  return candidate
}

// SET 托管目录遇到重名会给文件加后缀，但列表展示的仍是原文件名；包内要还原成展示名。
function resolveDisplayFileName(song: ISongInfo, absPath: string): string {
  const actual = path.basename(absPath)
  const display = typeof song.fileName === 'string' ? song.fileName.trim() : ''
  if (!display || display !== path.basename(display)) return actual
  if (/[<>:"/\\|?*\u0000-\u001F]/.test(display) || /[. ]$/.test(display)) return actual
  if (path.extname(display).toLowerCase() !== path.extname(actual).toLowerCase()) return actual
  return display
}

function resolveSetItemAbsPath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(store.databaseDir || '', 'library', filePath)
}

export async function exportSetPackage(
  params: ExportSetPackageParams
): Promise<ExportSetPackageSummary> {
  const items = listSetItemsByPlaylist(params.playlistUuid)
  if (items.length === 0) throw new SetPackageError('EMPTY_SET', 'SET 歌单是空的')

  const songBySetItemId = new Map<string, ISongInfo>()
  for (const song of Array.isArray(params.songs) ? params.songs : []) {
    const id = typeof song?.setItemId === 'string' ? song.setItemId : ''
    if (id) songBySetItemId.set(id, song)
  }

  type PlannedTrack = { absPath: string; song: ISongInfo; addedAtMs: number }
  const planned: PlannedTrack[] = []
  const missing: string[] = []
  for (const item of items) {
    const song = songBySetItemId.get(item.id)
    if (!song) {
      throw new SetPackageError('TRACKS_MISMATCH', 'SET 内容已变化，请重新打开该 SET 后再导出')
    }
    const absPath = resolveSetItemAbsPath(item.filePath)
    const stat = await fs.stat(absPath).catch(() => null)
    if (!stat || !stat.isFile()) {
      missing.push(path.basename(absPath))
      continue
    }
    planned.push({ absPath, song, addedAtMs: item.createdAtMs })
  }
  if (missing.length > 0) {
    throw new SetPackageError('MISSING_FILES', 'SET 中有曲目的音频文件不存在', missing)
  }

  const packageDir = await resolveUnusedDir(
    params.targetParentDir,
    toSafeSetPackageName(params.setName)
  )
  const audioDir = path.join(packageDir, SET_PACKAGE_AUDIO_DIR_NAME)
  const fileByPathKey = new Map<string, SetPackageFileEntry>()
  const sourceByFileId = new Map<string, string>()
  const usedFileNames = new Set<string>()
  for (const track of planned) {
    const key = filePathKey(track.absPath)
    if (fileByPathKey.has(key)) continue
    const fileName = resolveDisplayFileName(track.song, track.absPath)
    const targetName = resolveUnusedFileName(fileName, usedFileNames)
    const entry: SetPackageFileEntry = {
      id: `f${fileByPathKey.size + 1}`,
      path: toPackageRelativePath(packageDir, path.join(audioDir, targetName)),
      fileName,
      size: 0,
      sha256: ''
    }
    fileByPathKey.set(key, entry)
    sourceByFileId.set(entry.id, track.absPath)
  }

  const files = [...fileByPathKey.values()]
  try {
    await fs.ensureDir(audioDir)
    params.onProgress?.(0, files.length)
    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index]
      const sourcePath = sourceByFileId.get(entry.id) || ''
      const targetPath = path.join(packageDir, ...entry.path.split('/'))
      await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
      const [stat, sha256] = await Promise.all([fs.stat(targetPath), hashFileSha256(targetPath)])
      entry.size = stat.size
      entry.sha256 = sha256
      params.onProgress?.(index + 1, files.length)
    }

    const tracks: SetPackageTrackEntry[] = planned.map((track) => ({
      fileId: fileByPathKey.get(filePathKey(track.absPath))?.id || '',
      addedAtMs: track.addedAtMs,
      song: stripMachineLocalSongFields(track.song)
    }))
    const manifest: SetPackageManifest = {
      format: SET_PACKAGE_FORMAT,
      version: SET_PACKAGE_VERSION,
      appVersion: app.getVersion(),
      exportedAt: new Date().toISOString(),
      set: { name: params.setName },
      files,
      tracks
    }
    const manifestPath = path.join(
      packageDir,
      `${path.basename(packageDir)}.${SET_PACKAGE_EXTENSION}`
    )
    await fs.writeJSON(manifestPath, manifest, { spaces: 2 })
    return {
      packageDir,
      manifestPath,
      trackCount: tracks.length,
      fileCount: files.length
    }
  } catch (error) {
    await fs.remove(packageDir).catch(() => {})
    throw error
  }
}
