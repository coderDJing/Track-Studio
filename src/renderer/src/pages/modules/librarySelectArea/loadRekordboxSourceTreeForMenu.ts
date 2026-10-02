import {
  getCachedRekordboxSourceTree,
  getRememberedRekordboxSourceSelectedPlaylist,
  setCachedRekordboxSourceTree,
  shouldRefreshRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type {
  IPioneerPlaylistTreeNode,
  IPioneerDeviceLibraryKind
} from '../../../../../types/globals'
import type { RekordboxDesktopIcon } from './useRekordboxSourceIcons'

type SourceTreeResult = {
  treeNodes?: IPioneerPlaylistTreeNode[]
  sourceRootPath?: string
}

const hasPlaylistInTree = (treeNodes: IPioneerPlaylistTreeNode[], playlistId: number): boolean => {
  if (!playlistId) return false
  const walk = (nodes: IPioneerPlaylistTreeNode[]): boolean => {
    for (const node of nodes) {
      if (!node.isFolder && node.id === playlistId) return true
      if (Array.isArray(node.children) && node.children.length > 0 && walk(node.children)) {
        return true
      }
    }
    return false
  }
  return walk(Array.isArray(treeNodes) ? treeNodes : [])
}

export const resolvePlaylistIdForTree = (
  treeNodes: IPioneerPlaylistTreeNode[],
  preferredPlaylistId: number
) => {
  const safePlaylistId = Number(preferredPlaylistId) || 0
  if (safePlaylistId <= 0) return 0
  return hasPlaylistInTree(treeNodes, safePlaylistId) ? safePlaylistId : 0
}

export const buildDesktopSourceIcon = (
  probe: { sourceKey?: unknown; sourceRootPath?: unknown },
  label: string,
  iconAsset: string
): RekordboxDesktopIcon => ({
  key: String(probe.sourceKey || 'rekordbox-desktop').trim(),
  name: label,
  grey: iconAsset,
  white: iconAsset,
  src: iconAsset,
  showAlt: false,
  tooltip: label,
  rootPath: String(probe.sourceRootPath || '').trim(),
  i18nKey: 'library.rekordboxDesktopLibrary'
})

export const readDesktopSourceRevision = async (): Promise<string> => {
  const result = (await window.electron.ipcRenderer.invoke(
    buildRekordboxSourceChannel('desktop', 'source-revision')
  )) as { revision?: string }
  return String(result?.revision || '')
}

export const loadPioneerDriveTreeForMenu = async (
  sourceCacheKey: string,
  path: string,
  libraryType: IPioneerDeviceLibraryKind
) => {
  const cachedTree = getCachedRekordboxSourceTree(sourceCacheKey)
  if (cachedTree && !shouldRefreshRekordboxSourceTree(sourceCacheKey)) {
    return cachedTree.treeNodes
  }
  const result = (await window.electron.ipcRenderer.invoke(
    buildRekordboxSourceChannel('usb', 'load-tree'),
    path,
    libraryType
  )) as SourceTreeResult
  const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
  setCachedRekordboxSourceTree(sourceCacheKey, treeNodes, {
    selectedPlaylistId: getRememberedRekordboxSourceSelectedPlaylist(sourceCacheKey)
  })
  return treeNodes
}

export const loadDesktopLibraryTreeForMenu = async (sourceCacheKey: string, rootPath: string) => {
  const cachedTree = getCachedRekordboxSourceTree(sourceCacheKey)
  const revision = await readDesktopSourceRevision()
  if (cachedTree?.revision && cachedTree.revision === revision) {
    return { treeNodes: cachedTree.treeNodes, rootPath }
  }
  const result = (await window.electron.ipcRenderer.invoke(
    buildRekordboxSourceChannel('desktop', 'load-tree')
  )) as SourceTreeResult
  const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
  const nextRootPath = String(result?.sourceRootPath || rootPath || '').trim()
  setCachedRekordboxSourceTree(sourceCacheKey, treeNodes, {
    selectedPlaylistId: getRememberedRekordboxSourceSelectedPlaylist(sourceCacheKey),
    revision
  })
  return { treeNodes, rootPath: nextRootPath }
}
