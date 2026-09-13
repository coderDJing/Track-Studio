import path from 'node:path'
import fs from 'fs-extra'
import type {
  CuratedLibrarySyncCloudFile,
  CuratedLibrarySyncCloudNode
} from '../../shared/curatedLibrarySync'
import {
  normalizePlaylistTrackNumber,
  setSongListTrackNumbersByOrder
} from '../services/playlistTrackNumbers'
import { readCacheFieldsBatch, type CuratedCacheFields } from './cacheFields'
import { getCuratedSyncFileById } from './identityDb'
import { asOptionalPositiveInt } from './pendingLocal'
import {
  curatedRelativeToAbs,
  getCuratedLibraryAbsRoot,
  getNodeAbsPath,
  resolveCloudParentToLocalUuid
} from './paths'
import type { CuratedLocalFile } from './scan'
import type { CuratedApplyDiagnostics } from './applyRemoteDiagnostics'

export type RemoteTrackNumberScope = {
  curatedUuid: string
  snapshotNodeIds: Set<string>
}

const localParentUuidOf = (cloudParentUuid: string, scope: RemoteTrackNumberScope): string =>
  resolveCloudParentToLocalUuid(cloudParentUuid, scope.curatedUuid, scope.snapshotNodeIds)

export const collectPendingTrackParentUuids = (params: {
  localFiles: CuratedLocalFile[]
  lastAppliedFiles?: Map<string, CuratedLibrarySyncCloudFile> | null
  liveCacheByPath: Map<string, CuratedCacheFields>
  scope: RemoteTrackNumberScope
}): Set<string> => {
  const pendingParents = new Set<string>()
  for (const localFile of params.localFiles) {
    const lastFile = params.lastAppliedFiles?.get(localFile.fileId)
    if (!lastFile) continue
    const live = params.liveCacheByPath.get(localFile.absPath)
    const liveTrack = live?.trackNumber ?? localFile.trackNumber
    const liveAdded = live?.addedAtMs ?? localFile.addedAtMs
    if (
      asOptionalPositiveInt(lastFile.trackNumber) === asOptionalPositiveInt(liveTrack) &&
      asOptionalPositiveInt(lastFile.addedAtMs) === asOptionalPositiveInt(liveAdded)
    ) {
      continue
    }
    pendingParents.add(localFile.parentUuid)
    pendingParents.add(localParentUuidOf(localFile.parentUuid, params.scope))
  }
  return pendingParents
}

const applyTrackNumbers = async (params: {
  files: CuratedLibrarySyncCloudFile[]
  scope: RemoteTrackNumberScope
  localById: Map<string, CuratedLocalFile>
  diagnostics: CuratedApplyDiagnostics
}) => {
  const grouped = new Map<string, CuratedLibrarySyncCloudFile[]>()
  for (const file of params.files) {
    const parentUuid = localParentUuidOf(file.parentUuid, params.scope)
    const list = grouped.get(parentUuid) || []
    list.push(file)
    grouped.set(parentUuid, list)
  }
  for (const [parentUuid, group] of grouped) {
    await params.diagnostics.measure(
      'track-number-list',
      { parentUuid, fileCount: group.length },
      async () => {
        const listRoot =
          parentUuid === params.scope.curatedUuid
            ? getCuratedLibraryAbsRoot()
            : getNodeAbsPath(parentUuid)
        if (!listRoot) return
        const ordered = [...group].sort((left, right) => {
          const leftNum = Number(left.trackNumber) || Number.MAX_SAFE_INTEGER
          const rightNum = Number(right.trackNumber) || Number.MAX_SAFE_INTEGER
          if (leftNum !== rightNum) return leftNum - rightNum
          return left.fileName.localeCompare(right.fileName)
        })
        const alreadyOrdered = ordered.every(
          (file, index) =>
            normalizePlaylistTrackNumber(params.localById.get(file.fileId)?.trackNumber) ===
            index + 1
        )
        if (alreadyOrdered) return
        const absPaths: string[] = []
        for (const file of ordered) {
          const identity = getCuratedSyncFileById(file.fileId)
          const abs =
            (identity?.relativePath && curatedRelativeToAbs(identity.relativePath)) ||
            path.join(listRoot, file.fileName)
          if (await fs.pathExists(abs)) absPaths.push(abs)
        }
        if (absPaths.length > 0) {
          await params.diagnostics.measure(
            'track-number-write',
            { parentUuid, fileCount: absPaths.length },
            () => setSongListTrackNumbersByOrder({ listRoot, orderedFilePaths: absPaths })
          )
        }
      }
    )
  }
}

export const applyRemoteTrackNumbers = async (params: {
  files: CuratedLibrarySyncCloudFile[]
  localFiles: CuratedLocalFile[]
  localById: Map<string, CuratedLocalFile>
  scope: RemoteTrackNumberScope
  preservePendingLocal: boolean
  lastAppliedFiles?: Map<string, CuratedLibrarySyncCloudFile> | null
  diagnostics: CuratedApplyDiagnostics
}): Promise<void> => {
  let pendingParents = new Set<string>()
  if (params.preservePendingLocal) {
    const liveCacheByPath = await params.diagnostics.measure(
      'live-cache-before-track-numbers',
      { fileCount: params.localFiles.length },
      () => readCacheFieldsBatch(params.localFiles.map((file) => file.absPath))
    )
    pendingParents = collectPendingTrackParentUuids({
      localFiles: params.localFiles,
      lastAppliedFiles: params.lastAppliedFiles,
      liveCacheByPath,
      scope: params.scope
    })
  }
  const files = params.files.filter((file) => {
    if (pendingParents.size === 0) return true
    return (
      !pendingParents.has(file.parentUuid) &&
      !pendingParents.has(localParentUuidOf(file.parentUuid, params.scope))
    )
  })
  await params.diagnostics.measure(
    'track-numbers',
    { fileCount: files.length, skippedParentCount: pendingParents.size },
    () =>
      applyTrackNumbers({
        files,
        scope: params.scope,
        localById: params.localById,
        diagnostics: params.diagnostics
      })
  )
}
