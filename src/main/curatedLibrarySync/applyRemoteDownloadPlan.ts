import type { CuratedLibrarySyncCloudFile } from '../../shared/curatedLibrarySync'
import type { CuratedLocalFile } from './scan'

export const matchLocalFileForCloud = (
  file: CuratedLibrarySyncCloudFile,
  localById: Map<string, CuratedLocalFile>,
  localByHash: Map<string, CuratedLocalFile[]>,
  adoptedLocalIds: Set<string>,
  adoptIds: boolean
): CuratedLocalFile | undefined => {
  let matched = localById.get(file.fileId)
  if (!matched && adoptIds) {
    const hashMatches = localByHash.get(file.sha256) || []
    matched =
      hashMatches.find(
        (item) => !adoptedLocalIds.has(item.fileId) && item.fileName === file.fileName
      ) || hashMatches.find((item) => !adoptedLocalIds.has(item.fileId))
  }
  return matched
}

export const cloudFileNeedsDownload = (params: {
  file: CuratedLibrarySyncCloudFile
  matched: CuratedLocalFile | undefined
  shouldSkipRestore: boolean
  hasLocalParent: boolean
}): boolean => {
  if (!params.hasLocalParent) return false
  if (params.matched) return params.matched.contentSha256 !== params.file.sha256
  if (params.shouldSkipRestore) return false
  return true
}

export const countCloudFilesNeedingDownload = (params: {
  files: CuratedLibrarySyncCloudFile[]
  localById: Map<string, CuratedLocalFile>
  localByHash: Map<string, CuratedLocalFile[]>
  adoptIds: boolean
  shouldSkipRestore: (file: CuratedLibrarySyncCloudFile) => boolean
  hasLocalParent: (parentUuid: string) => boolean
}): number => {
  const previewAdopted = new Set<string>()
  let total = 0
  for (const file of params.files) {
    const matched = matchLocalFileForCloud(
      file,
      params.localById,
      params.localByHash,
      previewAdopted,
      params.adoptIds
    )
    if (matched && matched.fileId !== file.fileId) previewAdopted.add(matched.fileId)
    if (
      cloudFileNeedsDownload({
        file,
        matched,
        shouldSkipRestore: params.shouldSkipRestore(file),
        hasLocalParent: params.hasLocalParent(file.parentUuid)
      })
    ) {
      total += 1
    }
  }
  return total
}
