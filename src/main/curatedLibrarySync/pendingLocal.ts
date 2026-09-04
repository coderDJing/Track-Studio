import type {
  CuratedLibrarySyncCloudFile,
  CuratedLibrarySyncCloudNode
} from '../../shared/curatedLibrarySync'
import { sameCloudParentUuid } from './parentUuid'
import type { CuratedLocalFile, CuratedLocalNode } from './scan'

export const asOptionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

export const sameSortOrder = (left: unknown, right: unknown): boolean => {
  const a = asOptionalNumber(left)
  const b = asOptionalNumber(right)
  if (a === b) return true
  // 旧服务端曾把 null 写成 0（Number(null) === 0）
  return (a === null && b === 0) || (a === 0 && b === null)
}

export const asOptionalPositiveInt = (value: unknown): number | null => {
  const num = asOptionalNumber(value)
  if (num === null) return null
  const rounded = Math.floor(num)
  return rounded > 0 ? rounded : null
}

const sameParent = (
  left: string,
  right: string,
  curatedUuid: string | null,
  knownNodeIds: Set<string>
): boolean => {
  if (!curatedUuid) return left === right
  return sameCloudParentUuid(left, right, curatedUuid, knownNodeIds)
}

/** 本机相对上次已落地快照改过树节点：落地时不能用云端旧序号/改名盖回去。 */
export const localNodePendingSinceLast = (
  local: CuratedLocalNode,
  last: CuratedLibrarySyncCloudNode | undefined,
  curatedUuid: string | null,
  lastNodeIds: Set<string>
): boolean => {
  if (!last) return false
  if (last.name !== local.name) return true
  if (last.nodeType !== local.nodeType) return true
  if (!sameParent(last.parentUuid, local.parentUuid, curatedUuid, lastNodeIds)) return true
  return sameSortOrder(last.sortOrder, local.sortOrder) === false
}

/** 本机相对上次已落地快照改过文件：落地时不能用云端旧序号/加入时间盖回去。 */
export const localFilePendingSinceLast = (
  local: Pick<
    CuratedLocalFile,
    'parentUuid' | 'fileName' | 'contentSha256' | 'trackNumber' | 'addedAtMs'
  >,
  last: CuratedLibrarySyncCloudFile | undefined,
  curatedUuid: string | null,
  lastNodeIds: Set<string>
): boolean => {
  if (!last) return false
  if (!sameParent(last.parentUuid, local.parentUuid, curatedUuid, lastNodeIds)) return true
  if (last.fileName !== local.fileName) return true
  if (last.sha256 !== local.contentSha256) return true
  if (asOptionalPositiveInt(last.trackNumber) !== asOptionalPositiveInt(local.trackNumber)) {
    return true
  }
  return asOptionalPositiveInt(last.addedAtMs) !== asOptionalPositiveInt(local.addedAtMs)
}
