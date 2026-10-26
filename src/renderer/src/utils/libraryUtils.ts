import { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import { IDir } from 'src/types/globals'
import { calculateFileSystemOperations } from './diffLibraryTree'
import { toLibraryDisplayName, t } from './translate'
import { usePlaylistViewSettingsStore } from '@renderer/stores/playlistViewSettings'

const MIXTAPE_WINDOW_OPEN_ERROR_CODE = 'MIXTAPE_WINDOW_OPEN'

export const ensureMixtapeDeleteAllowed = async (playlistId: string): Promise<boolean> => {
  const normalizedId = (playlistId || '').trim()
  if (!normalizedId) return true
  let isWindowOpen = false
  try {
    isWindowOpen = await window.electron.ipcRenderer.invoke(
      'mixtape:is-window-open-by-playlist-id',
      normalizedId
    )
  } catch {
    return true
  }
  if (!isWindowOpen) return true
  await confirm({
    title: t('dialog.hint'),
    content: [t('mixtape.deleteBlockedWindowOpen'), t('mixtape.deleteBlockedWindowOpenHint')],
    confirmShow: false
  })
  return false
}

export const diffLibraryTreeExecuteFileOperation = async () => {
  const runtime = useRuntimeStore()
  // 1. 计算操作
  const operations = calculateFileSystemOperations(runtime.oldLibraryTree, runtime.libraryTree)

  // 如果没有操作，直接返回
  if (operations.length === 0) {
    runtime.oldLibraryTree = JSON.parse(JSON.stringify(runtime.libraryTree)) // 仍然同步 oldTree
    return true
  }

  const libraryUuid = runtime.oldLibraryTree.uuid
  const deletedPlaylistUuids = new Set<string>()
  const collectDeletedPlaylists = (node: IDir) => {
    if (node.type === 'songList' || node.type === 'setList' || node.type === 'mixtapeList') {
      deletedPlaylistUuids.add(node.uuid)
    }
    node.children?.forEach(collectDeletedPlaylists)
  }
  for (const operation of operations) {
    if (operation.type !== 'delete' && operation.type !== 'permanentlyDelete') continue
    const node = getLibraryTreeByUUID(operation.uuid, runtime.oldLibraryTree)
    if (node) collectDeletedPlaylists(node)
  }

  // 2. 发送操作到主进程
  const result = await window.electron.ipcRenderer.invoke('operateFileSystemChange', operations)

  // 3. 处理返回结果并更新 UI
  if (result.success && result.details) {
    // 4. 同步 oldLibraryTree
    runtime.oldLibraryTree = JSON.parse(JSON.stringify(runtime.libraryTree))
    // 只清理本次已确认删除的歌单，不拿可能已包含下一次乐观操作的树做全量清理。
    usePlaylistViewSettingsStore().removePlaylists(
      libraryUuid,
      deletedPlaylistUuids,
      runtime.setting.persistSongFilters
    )
    return true
  } else {
    // 处理主进程报告的失败
    console.error('File system operations failed:', result.error)
    if (result?.errorCode === MIXTAPE_WINDOW_OPEN_ERROR_CODE) {
      runtime.libraryTree = JSON.parse(JSON.stringify(runtime.oldLibraryTree))
      await confirm({
        title: t('dialog.hint'),
        content: [t('mixtape.deleteBlockedWindowOpen'), t('mixtape.deleteBlockedWindowOpenHint')],
        confirmShow: false
      })
      return false
    }
    try {
      const latestTree = await window.electron.ipcRenderer.invoke('getLibrary')
      if (latestTree) {
        runtime.libraryTree = latestTree
        runtime.oldLibraryTree = JSON.parse(JSON.stringify(latestTree))
        usePlaylistViewSettingsStore().pruneDeletedPlaylists(
          latestTree,
          runtime.setting.persistSongFilters
        )
      } else {
        runtime.libraryTree = JSON.parse(JSON.stringify(runtime.oldLibraryTree))
      }
    } catch {
      runtime.libraryTree = JSON.parse(JSON.stringify(runtime.oldLibraryTree))
    }
    return false
  }
}

//根据UUID寻找LibraryTree中对应的对象的父级对象
export const getFatherLibraryTreeByUUID = (targetUuid: string) => {
  const runtime = useRuntimeStore()
  let data = runtime.libraryTree
  // 定义一个辅助函数来递归搜索子对象

  function searchChildren(children: IDir[], targetUuid: string, parent: IDir): IDir | null {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]

      // 如果当前子对象就是要找的对象，返回其父级
      if (child.uuid === targetUuid) {
        return parent
      }

      // 如果当前子对象有子对象，则递归搜索
      if (child.children && child.children.length > 0) {
        const foundParent = searchChildren(child.children, targetUuid, child)
        if (foundParent) {
          return foundParent
        }
      }
    }
    return null // 没有找到
  }
  if (data.children) {
    // 调用辅助函数开始搜索
    return searchChildren(data.children, targetUuid, data) // 初始调用时，parent 为根对象本身
  } else {
    return null
  }
}

//根据UUID寻找LibraryTree中对应的对象
export const getLibraryTreeByUUID = (uuid: string, libraryTree?: IDir): IDir | null => {
  if (libraryTree === undefined) {
    const runtime = useRuntimeStore()
    libraryTree = runtime.libraryTree
  }
  // 如果当前对象就是要找的对象，直接返回
  if (libraryTree.uuid === uuid) {
    return libraryTree
  }

  // 遍历子对象
  if (libraryTree.children && libraryTree.children.length > 0) {
    for (let i = 0; i < libraryTree.children.length; i++) {
      // 递归调用函数
      const found = getLibraryTreeByUUID(uuid, libraryTree.children[i])
      if (found) {
        return found // 如果在子对象中找到了，就返回
      }
    }
  }
  // 如果没有找到，返回null
  return null
}

//根据UUID寻找LibraryTree中对应的对象的路径
export const findDirPathByUuid = (targetUuid: string, path: string = '', data?: IDir): string => {
  if (data === undefined) {
    const runtime = useRuntimeStore()
    data = runtime.libraryTree
  }
  // 如果当前对象的uuid就是要找的uuid，返回当前路径
  if (data.uuid === targetUuid) {
    return path + (path ? '/' : '') + data.dirName // 加上根目录的dirName（如果有的话）
  }

  // 遍历子对象
  if (data.children && data.children.length > 0) {
    for (let i = 0; i < data.children.length; i++) {
      // 递归调用函数，并传递当前路径加上当前dirName
      const foundPath = findDirPathByUuid(
        targetUuid,
        path + (path ? '/' : '') + data.dirName,
        data.children[i]
      )
      if (foundPath) {
        return foundPath // 如果在子对象中找到了，就返回完整的路径
      }
    }
  }

  // 如果没有找到，返回空字符串
  return ''
}

// 根据 UUID 生成展示路径（从核心库开始）
export const buildDisplayPathByUuid = (targetUuid: string): string => {
  const rawPath = findDirPathByUuid(targetUuid)
  if (!rawPath) return ''
  const segments = rawPath.split('/').filter(Boolean)
  const displaySegments = segments
    .filter((seg, idx) => !(idx === 0 && seg === 'library'))
    .map((seg) => {
      if (
        seg === 'FilterLibrary' ||
        seg === 'CuratedLibrary' ||
        seg === 'RecordingLibrary' ||
        seg === 'MixtapeLibrary' ||
        seg === 'RecycleBin'
      ) {
        return toLibraryDisplayName(seg)
      }
      return seg
    })
    .filter(Boolean)
  return displaySegments.join(' / ')
}
export const reOrderChildren = (children: IDir[]) => {
  for (let index in children) {
    children[index].order = Number(index) + 1
  }
}

export const isDragItemInDirChildren = (targetUUID: string, children?: IDir[]) => {
  if (!Array.isArray(children) || children.length === 0) return false
  for (const child of children) {
    if (child.uuid === targetUUID) {
      return true
    }
    if (
      child.children &&
      child.children.length > 0 &&
      isDragItemInDirChildren(targetUUID, child.children)
    ) {
      return true
    }
  }
  return false
}

export function getDepthByUuid(targetUuid: string) {
  const runtime = useRuntimeStore()
  let data = runtime.libraryTree
  // 递归函数，用于遍历JSON对象并计算深度
  function traverse(node: IDir, depth = 0): number | undefined {
    // 如果当前节点的UUID与目标UUID匹配，返回当前深度
    if (node.uuid === targetUuid) {
      return depth
    }

    // 遍历子节点
    if (node.children && node.children.length > 0) {
      for (let i = 0; i < node.children.length; i++) {
        // 递归调用traverse函数，深度+1
        let result = traverse(node.children[i], depth + 1)
        // 如果找到了匹配的UUID，则返回结果
        if (result !== undefined) {
          return result
        }
      }
    }

    // 如果没有找到匹配的UUID，返回undefined
    return undefined
  }

  // 从根节点开始遍历
  return traverse(data)
}
//获取平铺的所有子UUID（包括自己）
export function getAllUuids(data: IDir) {
  const uuids: string[] = []
  function traverse(node: IDir) {
    uuids.push(node.uuid)
    if (node.children && node.children.length > 0) {
      node.children.forEach((child) => {
        traverse(child)
      })
    }
  }
  traverse(data)
  return uuids
}

export function collectSelectableLibraryUuids(data: IDir, includeRoot = true) {
  const uuids: string[] = []
  function traverse(node: IDir, isRoot: boolean) {
    if (
      (!isRoot || includeRoot) &&
      (node.type === 'songList' || node.type === 'mixtapeList' || node.type === 'dir')
    ) {
      uuids.push(node.uuid)
    }
    if (node.children && node.children.length > 0) {
      node.children.forEach((child) => traverse(child, false))
    }
  }
  traverse(data, true)
  return uuids
}

// 更新播放状态
export function updatePlayingState(itemData: IDir): void {
  try {
    const runtime = useRuntimeStore()
    // 不需要查找当前的树，因为可能已被移除，直接使用传入的数据
    const flatUUID = getAllUuids(itemData)

    // 更新当前选中的歌单
    if (flatUUID.includes(runtime.songsArea.songListUUID)) {
      runtime.songsArea.songListUUID = ''
    }

    // 更新正在播放的歌单
    if (flatUUID.includes(runtime.playingData.playingSongListUUID)) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      runtime.playingData.playingSong = null
    }
  } catch (error) {
    console.error('Failed to update playing state:', error)
  }
}

// 导出集合和默认导出（如果其他地方还在用的话，需要恢复）
export const libraryUtils = {
  getFatherLibraryTreeByUUID,
  getLibraryTreeByUUID,
  findDirPathByUuid,
  buildDisplayPathByUuid,
  reOrderChildren,
  isDragItemInDirChildren,
  getDepthByUuid,
  getAllUuids,
  collectSelectableLibraryUuids,
  diffLibraryTreeExecuteFileOperation,
  ensureMixtapeDeleteAllowed,
  updatePlayingState
}
export default libraryUtils
