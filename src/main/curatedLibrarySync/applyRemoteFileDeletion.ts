import { mainFilePathKey } from '../filePathComparison'
import { protectSetReferencedFilesForDeletion } from '../ipc/setListHandlers'
import { moveFileToRecycleBin } from '../recycleBinService'
import { isPathBusyForRemoteMutation } from './busyPaths'
import type { ApplyRemoteContext } from './applyRemote'

export const deleteLocalFile = async (
  absPath: string,
  ctx: ApplyRemoteContext
): Promise<boolean> => {
  if (isPathBusyForRemoteMutation(absPath) || ctx.isBusy?.(absPath)) return false
  const setProtection = await protectSetReferencedFilesForDeletion([absPath])
  if (
    setProtection.protectedFiles.some(
      (item) => mainFilePathKey(item.filePath) === mainFilePathKey(absPath) && item.success
    )
  ) {
    return true
  }
  const result = await moveFileToRecycleBin(absPath)
  return result.status === 'moved' || result.status === 'skipped'
}
