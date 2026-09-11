import path from 'node:path'
import fs from 'fs-extra'
import { stampPlaylistSongsAddedAt } from '../services/playlistAddedAt'
import type { CuratedLibrarySyncCloudFile } from '../../shared/curatedLibrarySync'
import {
  getCuratedSyncFileById,
  upsertCuratedSyncFile,
  type CuratedSyncFileRow
} from './identityDb'
import type { CuratedLocalFile } from './scan'

type LocalFileMetadata = {
  contentSize: number
  mtimeMs: number | null
  existing?: CuratedSyncFileRow | null
}

const sameIdentity = (left: CuratedSyncFileRow, right: CuratedSyncFileRow): boolean =>
  left.relativePath === right.relativePath &&
  left.parentUuid === right.parentUuid &&
  left.fileName === right.fileName &&
  left.contentSha256 === right.contentSha256 &&
  left.contentSize === right.contentSize &&
  left.mtimeMs === right.mtimeMs &&
  left.trackNumber === right.trackNumber &&
  left.addedAtMs === right.addedAtMs &&
  left.updatedAtMs === right.updatedAtMs &&
  left.location === right.location &&
  left.locationPath === right.locationPath

const persistCloudIdentity = (params: {
  file: CuratedLibrarySyncCloudFile
  absPath: string
  relativePath: string
  parentUuid: string
  localMetadata: LocalFileMetadata
}): void => {
  const { file, absPath, relativePath, parentUuid, localMetadata } = params
  const existing = localMetadata.existing ?? getCuratedSyncFileById(file.fileId)
  const row: CuratedSyncFileRow = {
    fileId: file.fileId,
    relativePath,
    parentUuid,
    fileName: path.basename(absPath),
    contentSha256: file.sha256,
    contentSize: localMetadata.contentSize,
    mtimeMs: localMetadata.mtimeMs,
    trackNumber: file.trackNumber,
    addedAtMs: file.addedAtMs,
    updatedAtMs: file.updatedAtMs,
    location: 'curated',
    locationPath: relativePath
  }
  if (existing && sameIdentity(existing, row)) return
  upsertCuratedSyncFile(row)
}

export const persistCloudIdentityFromDisk = async (params: {
  file: CuratedLibrarySyncCloudFile
  absPath: string
  relativePath: string
  parentUuid: string
}): Promise<void> => {
  const stat = await fs.stat(params.absPath)
  persistCloudIdentity({
    ...params,
    localMetadata: { contentSize: stat.size, mtimeMs: stat.mtimeMs }
  })
}

export const persistMatchedCloudFile = async (params: {
  file: CuratedLibrarySyncCloudFile
  absPath: string
  relativePath: string
  parentUuid: string
  listRoot: string
  previous: CuratedLocalFile
}): Promise<void> => {
  const { file, absPath, relativePath, parentUuid, listRoot, previous } = params
  persistCloudIdentity({
    file,
    absPath,
    relativePath,
    parentUuid,
    localMetadata: {
      contentSize: previous.contentSize,
      mtimeMs: previous.mtimeMs,
      existing: previous
    }
  })
  const cloudAdded = file.addedAtMs
  if (cloudAdded == null || !Number.isFinite(cloudAdded) || cloudAdded === previous.addedAtMs) {
    return
  }
  await stampPlaylistSongsAddedAt({
    listRoot,
    filePaths: [absPath],
    addedAtMs: cloudAdded
  })
}
