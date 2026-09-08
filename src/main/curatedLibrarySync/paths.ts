import path from 'node:path'
import store from '../store'
import { getCoreFsDirName } from '../coreLibraries'
import { getLibraryDb } from '../libraryDb'
import { loadLibraryNodes, type LibraryNodeRow } from '../libraryTreeDb'
import type { CuratedLibrarySyncLocation } from '../../shared/curatedLibrarySync'
import { resolveCloudParentToLocalUuid } from './parentUuid'

export {
  canonicalizeCloudParentUuid,
  resolveCloudParentToLocalUuid,
  sameCloudParentUuid,
  toCloudParentUuid
} from './parentUuid'

const normalizeCompare = (value: string): string => {
  const resolved = path.resolve(String(value || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const sameAbsPath = (left: string, right: string): boolean =>
  normalizeCompare(left) === normalizeCompare(right)

export const toPosixRelative = (value: string): string =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

export const getCuratedLibraryAbsRoot = (): string | null => {
  const dbRoot = String(store.databaseDir || '').trim()
  if (!dbRoot) return null
  return path.join(dbRoot, 'library', getCoreFsDirName('CuratedLibrary'))
}

export const getLibraryAbsRoot = (): string | null => {
  const dbRoot = String(store.databaseDir || '').trim()
  if (!dbRoot) return null
  return path.join(dbRoot, 'library')
}

export const getSetCustodyAbsRoot = (): string | null => {
  const libraryRoot = getLibraryAbsRoot()
  if (!libraryRoot) return null
  return path.join(libraryRoot, getCoreFsDirName('SetLibrary'), '__set_custody__')
}

export const getRecycleBinAbsRoot = (): string | null => {
  const libraryRoot = getLibraryAbsRoot()
  if (!libraryRoot) return null
  return path.join(libraryRoot, getCoreFsDirName('RecycleBin'))
}

export const isPathInside = (absPath: string, rootPath: string | null): boolean => {
  if (!rootPath || !absPath) return false
  const normalized = normalizeCompare(absPath)
  const normalizedRoot = normalizeCompare(rootPath)
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`)
}

export const absToCuratedRelative = (absPath: string): string | null => {
  const root = getCuratedLibraryAbsRoot()
  if (!root || !absPath) return null
  if (!isPathInside(absPath, root)) return null
  const rel = path.relative(root, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return toPosixRelative(rel)
}

export const absToLibraryRelative = (absPath: string): string | null => {
  const root = getLibraryAbsRoot()
  if (!root || !absPath) return null
  if (!isPathInside(absPath, root)) return null
  const rel = path.relative(root, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return toPosixRelative(rel)
}

export const curatedRelativeToAbs = (relativePath: string): string | null => {
  const root = getCuratedLibraryAbsRoot()
  if (!root) return null
  const posix = toPosixRelative(relativePath)
  if (!posix) return null
  const abs = path.resolve(root, ...posix.split('/'))
  if (!isPathInside(abs, root)) return null
  return abs
}

export const libraryRelativeToAbs = (relativePath: string): string | null => {
  const root = getLibraryAbsRoot()
  if (!root) return null
  const posix = toPosixRelative(relativePath)
  if (!posix) return null
  const abs = path.resolve(root, ...posix.split('/'))
  if (!isPathInside(abs, root)) return null
  return abs
}

export const detectCuratedFileLocation = (
  absPath: string
): { location: CuratedLibrarySyncLocation; locationPath: string | null } => {
  if (isPathInside(absPath, getCuratedLibraryAbsRoot())) {
    return { location: 'curated', locationPath: absToCuratedRelative(absPath) }
  }
  if (isPathInside(absPath, getRecycleBinAbsRoot())) {
    return { location: 'recycle', locationPath: absToLibraryRelative(absPath) }
  }
  if (isPathInside(absPath, getSetCustodyAbsRoot())) {
    return { location: 'custody', locationPath: absToLibraryRelative(absPath) }
  }
  return { location: 'missing', locationPath: absToLibraryRelative(absPath) }
}

export const findCuratedLibraryNode = (): LibraryNodeRow | null => {
  const nodes = loadLibraryNodes() || []
  const curatedName = getCoreFsDirName('CuratedLibrary')
  const isWin = process.platform === 'win32'
  const equals = (left: string, right: string) =>
    isWin ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right
  const root = nodes.find((node) => node.nodeType === 'root' && !node.parentUuid)
  if (!root) return null
  return (
    nodes.find(
      (node) =>
        node.parentUuid === root.uuid &&
        node.nodeType === 'library' &&
        equals(node.dirName, curatedName)
    ) || null
  )
}

export const getNodeAbsPath = (uuid: string): string | null => {
  const dbRoot = String(store.databaseDir || '').trim()
  if (!dbRoot || !uuid) return null
  const db = getLibraryDb()
  if (!db) return null
  const nodes = loadLibraryNodes() || []
  const byUuid = new Map(nodes.map((node) => [node.uuid, node]))
  const parts: string[] = []
  let current = byUuid.get(uuid) || null
  const seen = new Set<string>()
  while (current) {
    if (seen.has(current.uuid)) return null
    seen.add(current.uuid)
    parts.unshift(current.dirName)
    if (!current.parentUuid) break
    current = byUuid.get(current.parentUuid) || null
  }
  if (parts.length === 0) return null
  return path.join(dbRoot, ...parts)
}

export const resolveCloudParentAbs = (
  cloudParentUuid: string,
  curatedUuid: string,
  snapshotNodeIds: Set<string>
): string | null => {
  const localParent = resolveCloudParentToLocalUuid(cloudParentUuid, curatedUuid, snapshotNodeIds)
  if (localParent === curatedUuid) return getCuratedLibraryAbsRoot()
  return getNodeAbsPath(localParent)
}

export const getNodeRelativeFromCurated = (uuid: string): string | null => {
  const abs = getNodeAbsPath(uuid)
  if (!abs) return null
  const curatedRoot = getCuratedLibraryAbsRoot()
  if (!curatedRoot) return null
  if (normalizeCompare(abs) === normalizeCompare(curatedRoot)) return ''
  return absToCuratedRelative(abs)
}

export const listCuratedDescendantNodes = (): LibraryNodeRow[] => {
  const curated = findCuratedLibraryNode()
  if (!curated) return []
  const nodes = loadLibraryNodes() || []
  const children = new Map<string, LibraryNodeRow[]>()
  for (const node of nodes) {
    if (!node.parentUuid) continue
    const list = children.get(node.parentUuid) || []
    list.push(node)
    children.set(node.parentUuid, list)
  }
  const result: LibraryNodeRow[] = []
  const stack = [curated.uuid]
  while (stack.length > 0) {
    const uuid = stack.pop() as string
    const kids = children.get(uuid) || []
    for (const child of kids) {
      result.push(child)
      stack.push(child.uuid)
    }
  }
  return result
}
