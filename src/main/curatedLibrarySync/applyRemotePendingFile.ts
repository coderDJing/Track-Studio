import path from 'node:path'
import fs from 'fs-extra'
import type { CuratedLibrarySyncCloudFile } from '../../shared/curatedLibrarySync'
import { readCacheFields, type CuratedLocalFile } from './scan'
import { localFilePendingSinceLast } from './pendingLocal'
import { notifyCuratedFilePathChanged, replaceCuratedSyncFileId } from './identityDb'

/** 扫描开跑后本机已把文件挪到别处：按内容接回，避免按云端旧路径再下一份。 */
export const adoptAliveHashMatch = async (
  matched: CuratedLocalFile,
  cloudFileId: string,
  sha256: string,
  localByHash: Map<string, CuratedLocalFile[]>
): Promise<CuratedLocalFile> => {
  if (await fs.pathExists(matched.absPath)) return matched
  const missingAbs = matched.absPath
  const alive = (localByHash.get(sha256) || []).find(
    (item) => path.normalize(item.absPath) !== path.normalize(missingAbs)
  )
  if (!alive || !(await fs.pathExists(alive.absPath))) return matched
  if (alive.fileId !== cloudFileId) replaceCuratedSyncFileId(alive.fileId, cloudFileId)
  notifyCuratedFilePathChanged(missingAbs, alive.absPath)
  return { ...alive, fileId: cloudFileId }
}

/** 扫描开跑后文件被改名/挪走/改内容/改曲序：不要按云端旧快照搬回去。 */
export const liveMatchedFileApplyState = async (
  matched: CuratedLocalFile,
  lastFile: CuratedLibrarySyncCloudFile | undefined,
  curatedUuid: string,
  lastNodeIds: Set<string>
): Promise<'missing' | 'pending' | 'stable'> => {
  if (!(await fs.pathExists(matched.absPath))) return 'missing'
  try {
    const stat = await fs.stat(matched.absPath)
    if (
      stat.size !== matched.contentSize ||
      (matched.mtimeMs != null && Number(matched.mtimeMs) !== Number(stat.mtimeMs))
    ) {
      return 'pending'
    }
  } catch {
    return 'missing'
  }
  const liveCache = await readCacheFields(matched.absPath)
  const live = {
    parentUuid: matched.parentUuid,
    fileName: path.basename(matched.absPath),
    contentSha256: matched.contentSha256,
    trackNumber: liveCache.trackNumber ?? matched.trackNumber,
    addedAtMs: liveCache.addedAtMs ?? matched.addedAtMs
  }
  if (localFilePendingSinceLast(live, lastFile, curatedUuid, lastNodeIds)) return 'pending'
  return 'stable'
}
