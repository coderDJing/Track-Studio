import path from 'node:path'
import fs from 'fs-extra'
import store from '../store'
import { collectFilesWithExtensions, moveOrCopyItemWithCheckIsExist } from '../utils'
import { findSongListRoot, transferTrackCaches } from '../services/cacheMaintenance'
import { replaceMixtapeFilePath } from '../mixtapeDb'
import { updateSetItemFilePathReferences } from '../setListDb'
import { remapKeyAnalysisTrackedPath } from '../services/keyAnalysisQueue'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { rememberCuratedArtistsForAddedTracks } from '../curatedArtistLibrary'
import { deletePlaylistViewSnapshotsUnderRoot } from '../libraryCacheDb'
import { notifyCuratedFilePathChanged } from './identityDb'

const remapMovedAudioFile = (fromAbs: string, toAbs: string) => {
  remapKeyAnalysisTrackedPath(fromAbs, toAbs)
  replaceMixtapeFilePath(fromAbs, toAbs)
  updateSetItemFilePathReferences(fromAbs, toAbs)
  notifyCuratedFilePathChanged(fromAbs, toAbs)
}

const transferCachesQuietly = async (
  fromAbs: string,
  toAbs: string,
  mode: 'move' | 'copy'
): Promise<void> => {
  try {
    const fromRoot = await findSongListRoot(path.dirname(fromAbs))
    const toRoot = await findSongListRoot(path.dirname(toAbs))
    await transferTrackCaches({
      fromRoot,
      toRoot,
      fromPath: fromAbs,
      toPath: toAbs,
      mode
    })
  } catch {}
}

export const relocateLibraryAudioFile = async (params: {
  sourceAbs: string
  destAbs: string
  mode: 'move' | 'copy'
  overwrite?: boolean
}): Promise<string> => {
  let movedPath = params.destAbs
  if (params.overwrite) {
    if (params.mode === 'move') {
      await fs.move(params.sourceAbs, params.destAbs, { overwrite: true })
    } else {
      await fs.copy(params.sourceAbs, params.destAbs, { overwrite: true })
    }
  } else {
    movedPath = await moveOrCopyItemWithCheckIsExist(
      params.sourceAbs,
      params.destAbs,
      params.mode === 'move'
    )
  }
  if (params.mode === 'move') {
    remapMovedAudioFile(params.sourceAbs, movedPath)
  }
  await transferCachesQuietly(params.sourceAbs, movedPath, params.mode)
  markGlobalSongSearchDirty('curatedLibrarySync')
  return movedPath
}

export const rememberImportedCuratedTracks = (absPaths: string[]): void => {
  if (absPaths.length === 0) return
  void rememberCuratedArtistsForAddedTracks({
    tracks: absPaths.map((targetPath) => ({ targetPath }))
  })
}

export const relocateLibraryDirectoryFiles = async (
  sourceAbs: string,
  destAbs: string
): Promise<void> => {
  // 整目录搬家后快照里的 list_root / filePath 都是旧绝对路径，改不回来，只能丢掉。
  // 源目录即使已经不在了也要按旧路径清：云端对账可能磁盘先动、树后动。
  deletePlaylistViewSnapshotsUnderRoot(sourceAbs)
  if (!(await fs.pathExists(sourceAbs))) return
  const audioExts = store.settingConfig?.audioExt || []
  const oldFiles =
    audioExts.length > 0 ? await collectFilesWithExtensions(sourceAbs, audioExts) : []
  await fs.move(sourceAbs, destAbs, { overwrite: false })
  for (const oldFile of oldFiles) {
    const rel = path.relative(sourceAbs, oldFile)
    if (!rel || rel.startsWith('..')) continue
    const newFile = path.join(destAbs, rel)
    remapMovedAudioFile(oldFile, newFile)
    await transferCachesQuietly(oldFile, newFile, 'move')
  }
  markGlobalSongSearchDirty('curatedLibrarySync')
}
