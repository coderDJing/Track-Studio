import path = require('path')
import fs = require('fs-extra')
import { v4 as uuidV4 } from 'uuid'
import store from '../../store'
import { log } from '../../log'
import { getCoreFsDirName } from '../../coreLibraries'
import { loadLibraryNodes } from '../../libraryTreeDb'
import { beginLibraryTreeWatcherBulkOperation } from '../../libraryTreeWatcher'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { appendSetItems, countSetItemsByPlaylist, removeSetItemsByPlaylist } from '../../setListDb'
import { hashFileSha256 } from '../../curatedLibrarySync/hashFile'
import { buildSetAnalysisSnapshot } from '../setAnalysisSnapshot'
import { markGlobalSongSearchDirty } from '../globalSongSearch'
import type { ISongInfo } from '../../../types/globals'
import {
  SetPackageError,
  assertSetPackageFilesPresent,
  readSetPackageManifest,
  resolvePackageFilePath,
  type SetPackageManifest
} from './manifest'
import { toSafeSetPackageName } from './exportSetPackage'

export type ImportSetPackageParams = {
  manifestPath: string
  playlistUuid: string
  onProgress?: (done: number, total: number) => void
}

const SET_CUSTODY_DIR_NAME = '__set_custody__'

type ImportedFile = {
  absPath: string
  size: number
  mtimeMs: number
}

const fileNameKey = (fileName: string) =>
  process.platform === 'win32' ? fileName.toLowerCase() : fileName

function getSetCustodyRoot(): string {
  return path.join(
    store.databaseDir || '',
    'library',
    getCoreFsDirName('SetLibrary'),
    SET_CUSTODY_DIR_NAME
  )
}

/** 读取并校验包内容，供导入前展示名称与曲目数。 */
export async function inspectSetPackage(manifestPath: string): Promise<SetPackageManifest> {
  const manifest = await readSetPackageManifest(manifestPath)
  await assertSetPackageFilesPresent(path.dirname(manifestPath), manifest)
  return manifest
}

function assertTargetPlaylist(playlistUuid: string) {
  const node = (loadLibraryNodes() || []).find((row) => row.uuid === playlistUuid)
  if (!node || node.nodeType !== 'setList') {
    throw new SetPackageError('PLAYLIST_NOT_FOUND', '目标 SET 歌单不存在')
  }
  if (countSetItemsByPlaylist(playlistUuid) > 0) {
    throw new SetPackageError('PLAYLIST_NOT_EMPTY', '目标 SET 歌单不是空的')
  }
}

export async function importSetPackage(
  params: ImportSetPackageParams
): Promise<{ trackCount: number; fileCount: number }> {
  if (!store.databaseDir) throw new SetPackageError('FAILED', '音乐库尚未就绪')
  assertTargetPlaylist(params.playlistUuid)
  const packageDir = path.dirname(params.manifestPath)
  const manifest = await inspectSetPackage(params.manifestPath)

  const custodyRoot = getSetCustodyRoot()
  // 每次导入独占一个子目录，保证原文件名不变（文件名也是曲目列表里展示的内容）。
  const importDir = path.join(
    custodyRoot,
    `${toSafeSetPackageName(manifest.set.name)}_${uuidV4().slice(0, 8)}`
  )
  const importedById = new Map<string, ImportedFile>()
  const releaseWatcher = beginLibraryTreeWatcherBulkOperation()
  try {
    const usedNames = new Set<string>()
    params.onProgress?.(0, manifest.files.length)
    for (let index = 0; index < manifest.files.length; index += 1) {
      const file = manifest.files[index]
      const sourcePath = resolvePackageFilePath(packageDir, file.path)
      if (!sourcePath) throw new SetPackageError('MANIFEST_INVALID', `文件路径非法：${file.path}`)
      const nameKey = fileNameKey(file.fileName)
      const targetDir = usedNames.has(nameKey) ? path.join(importDir, String(index + 1)) : importDir
      usedNames.add(nameKey)
      const targetPath = path.join(targetDir, file.fileName)
      await fs.ensureDir(targetDir)
      await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
      const [stat, sha256] = await Promise.all([fs.stat(targetPath), hashFileSha256(targetPath)])
      if (stat.size !== file.size || sha256 !== file.sha256) {
        throw new SetPackageError('PACKAGE_FILE_CORRUPTED', 'SET 包内音频文件已损坏', [
          file.fileName
        ])
      }
      importedById.set(file.id, { absPath: targetPath, size: stat.size, mtimeMs: stat.mtimeMs })
      params.onProgress?.(index + 1, manifest.files.length)
    }

    const cachedFileIds = new Set<string>()
    for (const track of manifest.tracks) {
      if (cachedFileIds.has(track.fileId)) continue
      cachedFileIds.add(track.fileId)
      const imported = importedById.get(track.fileId)
      if (!imported) throw new SetPackageError('FAILED', '导入的音频文件丢失')
      const info = {
        ...track.song,
        filePath: imported.absPath,
        fileName: path.basename(imported.absPath),
        cover: null
      } as ISongInfo
      const saved = await LibraryCacheDb.upsertSongCacheEntry(custodyRoot, imported.absPath, {
        size: imported.size,
        mtimeMs: imported.mtimeMs,
        info
      })
      if (!saved) throw new SetPackageError('FAILED', '写入曲目分析结果失败')
    }

    const inserted = appendSetItems(
      params.playlistUuid,
      manifest.tracks.map((track) => ({
        filePath: importedById.get(track.fileId)?.absPath || '',
        analysis: buildSetAnalysisSnapshot(track.song),
        createdAtMs: track.addedAtMs || null
      }))
    )
    if (inserted.length !== manifest.tracks.length) {
      throw new SetPackageError('FAILED', '写入 SET 曲目失败')
    }
    markGlobalSongSearchDirty('setList:import-package')
    return { trackCount: inserted.length, fileCount: importedById.size }
  } catch (error) {
    removeSetItemsByPlaylist(params.playlistUuid)
    for (const imported of importedById.values()) {
      await LibraryCacheDb.removeSongCacheEntry(custodyRoot, imported.absPath).catch(() => false)
    }
    await fs.remove(importDir).catch((removeError) => {
      log.error('[setPackage] 回滚导入目录失败', { importDir, error: removeError })
    })
    throw error
  } finally {
    releaseWatcher()
  }
}
