import type { IDir } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import dropIntoDialog from '../components/dropIntoDialog'
import { isNeteaseVirtualUuid } from '@shared/netease'

export interface DragState {
  dragApproach: 'top' | 'center' | 'bottom' | ''
}

// 拖拽开始时的验证和初始化
export const handleDragStart = async (event: DragEvent, uuid: string): Promise<boolean> => {
  try {
    const runtime = useRuntimeStore()
    const songListPath = libraryUtils.findDirPathByUuid(uuid)

    // 网易云虚拟节点没有磁盘目录，不能按本地歌单去做存在性校验，更不能从树里删掉。
    if (!isNeteaseVirtualUuid(uuid)) {
      const exists = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
      if (!exists) {
        event.preventDefault()
        await confirm({
          title: t('common.error'),
          content: [t('library.notExistOnDisk')],
          confirmShow: false
        })

        // 从列表中删除该项
        const itemToDelete = libraryUtils.getLibraryTreeByUUID(uuid)
        if (itemToDelete) {
          const fatherDir = libraryUtils.getFatherLibraryTreeByUUID(uuid)
          if (fatherDir && fatherDir.children) {
            // 更新播放状态
            libraryUtils.updatePlayingState(itemToDelete)

            // 从父目录中移除该项
            const itemIndex = fatherDir.children.findIndex((item) => item.uuid === uuid)
            if (itemIndex !== -1) {
              fatherDir.children.splice(itemIndex, 1)

              // 重新排序剩余项
              for (let i = 0; i < fatherDir.children.length; i++) {
                const child = fatherDir.children[i]
                if (child?.order !== undefined) {
                  child.order = i + 1
                }
              }

              // 更新排序
              libraryUtils.reOrderChildren(fatherDir.children)
            }
          }
        }
        await libraryUtils.diffLibraryTreeExecuteFileOperation()

        return true // 告知调用者已从列表中删除
      }
    }

    // 存储被拖拽的项目数据
    runtime.dragItemData = libraryUtils.getLibraryTreeByUUID(uuid)
    return false
  } catch (error) {
    console.error('Drag start failed:', error)
    event.preventDefault()
    return false
  }
}

// 计算拖拽指示器位置
const calculateDragApproach = (offsetY: number, isFolder: boolean): 'top' | 'center' | 'bottom' => {
  if (!isFolder) {
    return offsetY <= 12 ? 'top' : 'bottom'
  }

  if (offsetY <= 8) return 'top'
  if (offsetY > 8 && offsetY < 16) return 'center'
  return 'bottom'
}

// 验证拖拽操作是否有效
const isValidDrop = (
  dragItemData: IDir | null,
  targetDir: IDir,
  dragApproach: 'top' | 'center' | 'bottom' | ''
): boolean => {
  // 基础验证
  if (!dragItemData || !targetDir) return false

  // 不能拖拽到自身或其子项
  if (
    dragItemData.uuid === targetDir.uuid ||
    libraryUtils.isDragItemInDirChildren(targetDir.uuid, dragItemData.children)
  ) {
    return false
  }

  const dragItemFather = libraryUtils.getFatherLibraryTreeByUUID(dragItemData.uuid)
  const targetDirFather = libraryUtils.getFatherLibraryTreeByUUID(targetDir.uuid)

  // 不能拖拽到父目录
  if (dragItemFather === targetDir) return false

  // 同级目录的特殊处理
  if (dragItemFather === targetDirFather) {
    const sourceOrder = dragItemData.order ?? 0
    const targetOrder = targetDir.order ?? 0
    const orderDiff = sourceOrder - targetOrder

    // 相邻项的特殊处理
    if (Math.abs(orderDiff) === 1) {
      // 向下拖到下一项的顶部 或 向上拖到上一项的底部时不允许
      if (
        (orderDiff === 1 && dragApproach === 'bottom') ||
        (orderDiff === -1 && dragApproach === 'top')
      ) {
        return false
      }
    }
  }

  return true
}

// 处理拖拽悬停
export const handleDragOver = (e: DragEvent, dirData: IDir | null, dragState: DragState): void => {
  const runtime = useRuntimeStore()
  // 如果正在拖动表头，则不允许放置并重置状态
  if (runtime.dragTableHeader) {
    e.dataTransfer!.dropEffect = 'none'
    dragState.dragApproach = ''
    return
  }
  if (!dirData) return

  // 重置状态
  dragState.dragApproach = ''

  // 外部拖拽处理
  if (!runtime.dragItemData) {
    if (dirData.type === 'songList') {
      e.dataTransfer!.dropEffect = 'copy'
      dragState.dragApproach = 'center'
    } else {
      e.dataTransfer!.dropEffect = 'none'
    }
    return
  }

  const targetElement = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
  const offsetY = targetElement ? e.clientY - targetElement.getBoundingClientRect().top : e.offsetY
  const dragApproach = calculateDragApproach(offsetY, dirData.type === 'dir')

  // 内部拖拽处理
  if (!isValidDrop(runtime.dragItemData, dirData, dragApproach)) {
    e.dataTransfer!.dropEffect = 'none'
    dragState.dragApproach = ''
    return
  }

  e.dataTransfer!.dropEffect = 'move'
  dragState.dragApproach = dragApproach
}

// 处理拖拽进入
export const handleDragEnter = (e: DragEvent, dirData: IDir | null, dragState: DragState): void => {
  const runtime = useRuntimeStore()
  // 如果正在拖动表头，则直接返回
  if (runtime.dragTableHeader) {
    return
  }
  if (!dirData) return
  handleDragOver(e, dirData, dragState)
}

// 处理拖拽离开
export function handleDragLeave(dragState: DragState): void {
  dragState.dragApproach = ''
}

// 更新数据结构
function moveItemToSiblingIndex(
  dragItemData: IDir,
  targetFather: IDir,
  insertIndex: number
): boolean {
  const dragItemFather = libraryUtils.getFatherLibraryTreeByUUID(dragItemData.uuid)
  if (!dragItemFather?.children) {
    console.error('Source parent directory not found or has no children')
    return false
  }

  const sourceIndex = dragItemFather.children.findIndex((item) => item.uuid === dragItemData.uuid)
  if (sourceIndex === -1) {
    console.error('Source item not found in parent directory')
    return false
  }

  const movedItem = JSON.parse(JSON.stringify(dragItemFather.children[sourceIndex]))
  dragItemFather.children.splice(sourceIndex, 1)
  libraryUtils.reOrderChildren(dragItemFather.children)

  if (!targetFather.children) {
    targetFather.children = []
  }

  let finalIndex = Math.max(0, Math.min(insertIndex, targetFather.children.length))
  if (dragItemFather.uuid === targetFather.uuid && sourceIndex < finalIndex) {
    finalIndex = Math.max(0, finalIndex - 1)
  }
  targetFather.children.splice(finalIndex, 0, movedItem)
  libraryUtils.reOrderChildren(targetFather.children)
  return true
}

async function updateDataStructure(
  dragItemData: IDir,
  targetDir: IDir,
  approach: string,
  fatherDirData: IDir | null,
  skipExistingItemCheck: boolean = false
): Promise<void> {
  try {
    const dragItemFather = libraryUtils.getFatherLibraryTreeByUUID(dragItemData.uuid)
    if (!dragItemFather?.children) {
      console.error('Source parent directory not found or has no children')
      return
    }

    // 从原位置移除
    const itemIndex = dragItemFather.children.findIndex((item) => item.uuid === dragItemData.uuid)
    if (itemIndex === -1) {
      console.error('Source item not found in parent directory')
      return
    }

    // 创建深拷贝并保留所有属性
    const movedItem = JSON.parse(JSON.stringify(dragItemFather.children[itemIndex]))
    dragItemFather.children.splice(itemIndex, 1)

    // 重新排序原位置
    libraryUtils.reOrderChildren(dragItemFather.children)

    // 添加到新位置
    if (approach === 'center' && targetDir.type === 'dir') {
      // 把某个item拖拽到文件夹内
      if (!targetDir.children) {
        targetDir.children = []
      }

      // 如果目标文件夹中已有同名项，先移除
      if (!skipExistingItemCheck) {
        let existItem = targetDir.children.find((item) => item.dirName === movedItem.dirName)
        if (existItem) {
          targetDir.children.splice(targetDir.children.indexOf(existItem), 1)
        }
      }

      // 添加到目标文件夹的最前面
      targetDir.children.unshift(movedItem)

      // 重新排序并更新目标目录
      libraryUtils.reOrderChildren(targetDir.children)
    } else if (fatherDirData?.children) {
      // 拖拽到同级的前面或后面
      // 如果不跳过检查，先检查同名项
      if (!skipExistingItemCheck) {
        // 如果目标文件夹中已有同名项，先移除
        let existItem = fatherDirData.children.find(
          (item) => item.dirName === movedItem.dirName && item.uuid !== dragItemData.uuid
        )
        if (existItem) {
          const existingItemIndex = fatherDirData.children.indexOf(existItem)
          if (existingItemIndex !== -1) {
            fatherDirData.children.splice(existingItemIndex, 1)
          }
        }
      }

      // 先判断targetDir是否仍然存在于fatherDirData.children中
      // 如果之前移除了同名项，targetDir可能已经不在children中
      const targetIndex = fatherDirData.children.findIndex((item) => item.uuid === targetDir.uuid)
      if (targetIndex === -1) {
        // 如果目标位置不存在，则添加到父目录的最前面
        movedItem.order = 1
        fatherDirData.children.unshift(movedItem)
      } else {
        // 根据拖放位置（顶部或底部）插入项目
        const insertIndex = approach === 'top' ? targetIndex : targetIndex + 1
        movedItem.order = approach === 'top' ? (targetDir.order ?? 1) : (targetDir.order ?? 0) + 1

        fatherDirData.children.splice(insertIndex, 0, movedItem)
      }

      // 更新受影响项目的order
      for (let i = 0; i < fatherDirData.children.length; i++) {
        const child = fatherDirData.children[i]
        if (child?.order !== undefined) {
          child.order = i + 1
        }
      }

      // 重新排序并更新目标父目录
      libraryUtils.reOrderChildren(fatherDirData.children)
    }

    // 注意: 此处省略文件系统操作，只进行数据结构更新
    // 实际文件操作将通过比对新旧libraryTree来执行
  } catch (error) {
    console.error('Failed to update data structure:', error)
    throw error // 重新抛出错误以便上层处理
  }
}

// 处理拖拽放下
export const handleDrop = async (
  e: DragEvent,
  dirData: IDir | null,
  dragState: DragState,
  fatherDirData: IDir | null
): Promise<boolean> => {
  const runtime = useRuntimeStore()
  // 如果正在拖动表头，则阻止放置
  if (runtime.dragTableHeader) {
    dragState.dragApproach = '' // 确保状态被重置
    return false
  }
  if (!dirData || !fatherDirData) return false
  const approach = dragState.dragApproach
  dragState.dragApproach = ''

  try {
    if (runtime.dragItemData) {
      // 创建拖拽项的深拷贝，这样即使原项被删除也有备份
      let dragItemData = JSON.parse(JSON.stringify(runtime.dragItemData))

      // 处理拖入文件夹的情况
      if (approach === 'center' && dirData.type === 'dir') {
        // 确保目标目录有children数组
        if (!dirData.children) {
          dirData.children = []
        }

        const existingItem = dirData.children.find(
          (item) => item.dirName === dragItemData.dirName && item.uuid !== dragItemData.uuid
        )

        // 处理同名文件冲突
        if (existingItem) {
          const shouldReplace = await confirm({
            title: t('common.move'),
            content: [
              t('tracks.fileExistsReplace', { name: dragItemData.dirName }),
              t('tracks.replaceHint')
            ]
          })

          if (shouldReplace !== 'confirm') return false

          // 更新播放状态（对可能被删除的项）
          libraryUtils.updatePlayingState(existingItem)

          // 先手动移除同名项
          const existingItemIndex = dirData.children.indexOf(existingItem)
          if (existingItemIndex !== -1) {
            dirData.children.splice(existingItemIndex, 1)
          }
        }

        // 传入skipExistingItemCheck为true，因为我们已经处理过同名项了
        await updateDataStructure(dragItemData, dirData, approach, fatherDirData, true)

        //diff新旧树，然后执行真实文件系统操作
        await libraryUtils.diffLibraryTreeExecuteFileOperation()

        return false
      } else if (approach === 'top' || approach === 'bottom') {
        // 确保父目录有children数组
        if (!fatherDirData.children) {
          fatherDirData.children = []
        }

        // 处理同级拖拽情况
        const existingItem = fatherDirData.children.find(
          (item) => item.dirName === dragItemData.dirName && item.uuid !== dragItemData.uuid
        )

        // 处理同名文件冲突
        if (existingItem) {
          const shouldReplace = await confirm({
            title: t('common.move'),
            content: [
              t('tracks.fileExistsReplace', { name: dragItemData.dirName }),
              t('tracks.replaceHint')
            ]
          })

          if (shouldReplace !== 'confirm') return false

          // 更新播放状态（对可能被删除的项）
          libraryUtils.updatePlayingState(existingItem)

          // 记录并处理一些特殊情况
          const isTargetSameAsExisting = existingItem.uuid === dirData.uuid

          // 先移除同名项，不管它是不是目标
          const existingItemIndex = fatherDirData.children.indexOf(existingItem)
          if (existingItemIndex !== -1) {
            fatherDirData.children.splice(existingItemIndex, 1)
          }

          // 如果同名项就是目标，拖拽项应占据被替换目标原来的位置
          if (isTargetSameAsExisting) {
            const insertIndex =
              existingItemIndex !== -1 ? existingItemIndex : fatherDirData.children.length
            const moved = moveItemToSiblingIndex(dragItemData, fatherDirData, insertIndex)
            if (!moved) {
              return false
            }
          } else {
            // 传入skipExistingItemCheck为true，因为我们已经处理过同名项了
            await updateDataStructure(dragItemData, dirData, approach, fatherDirData, true)
          }
        } else {
          // 传入skipExistingItemCheck为true，因为我们已经处理过同名项了
          await updateDataStructure(dragItemData, dirData, approach, fatherDirData, true)
        }
        //diff新旧树，然后执行真实文件系统操作
        await libraryUtils.diffLibraryTreeExecuteFileOperation()
        return false
      }
    } else if (e.dataTransfer?.files.length && dirData.type === 'songList') {
      if (runtime.songDragActive && runtime.draggingSongFilePaths.length > 0) {
        return false
      }
      // 处理外部文件拖入
      const filePaths = []
      for (let item of Array.from(e.dataTransfer.files)) {
        filePaths.push(window.api.showFilesPath(item))
      }
      let result = await dropIntoDialog({
        songListUuid: dirData.uuid,
        libraryName: runtime.libraryAreaSelected
      })

      if (result === 'cancel') {
        return false
      }

      runtime.importingSongListUUID = result.importingSongListUUID
      runtime.isProgressing = true

      window.electron.ipcRenderer.send('startImportSongs', {
        filePaths: filePaths,
        songListPath: result.songListPath,
        isDeleteSourceFile: result.isDeleteSourceFile,
        isComparisonSongFingerprint: result.isComparisonSongFingerprint,
        isPushSongFingerprintLibrary: result.isPushSongFingerprintLibrary,
        deduplicateMode: result.deduplicateMode,
        songListUUID: result.importingSongListUUID
      })
    }

    return false
  } catch (error) {
    console.error('Drop operation failed:', error)
    return false
  } finally {
    runtime.dragItemData = null
  }
}

// 处理拖拽到库区域空白处的情况
export async function handleLibraryAreaEmptySpaceDrop(
  dragItemData: IDir | null,
  libraryData: IDir
): Promise<boolean> {
  try {
    // 验证拖拽数据
    if (!dragItemData) {
      return false
    }

    // 获取拖拽项的父目录
    const dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(dragItemData.uuid)
    if (!dragItemDataFather?.children) {
      console.error('Source parent directory not found or has no children')
      return false
    }

    // 确保目标目录有 children 数组
    if (!libraryData.children) {
      libraryData.children = []
    }

    // 判断是否是同一父目录内的拖拽排序
    if (dragItemDataFather.uuid === libraryData.uuid) {
      // 如果已经是最后一项，无需移动
      if (
        libraryData.children.length > 0 &&
        libraryData.children[libraryData.children.length - 1].uuid === dragItemData.uuid
      ) {
        return true
      }

      // 从原位置移除并添加到末尾
      const itemIndex = dragItemDataFather.children.findIndex(
        (item) => item.uuid === dragItemData.uuid
      )
      if (itemIndex !== -1) {
        const removedElement = dragItemDataFather.children.splice(itemIndex, 1)[0]
        libraryData.children.push(removedElement)
        libraryUtils.reOrderChildren(libraryData.children)
        await libraryUtils.diffLibraryTreeExecuteFileOperation()
        return true
      }
    } else {
      // 跨目录移动 - 检查是否有同名冲突
      const existingItem = libraryData.children.find(
        (item) => item.dirName === dragItemData.dirName
      )

      if (existingItem) {
        // 处理同名冲突
        const shouldReplace = await confirm({
          title: t('common.move'),
          content: [
            t('tracks.fileExistsReplace', { name: dragItemData.dirName }),
            t('tracks.replaceHint')
          ]
        })

        if (shouldReplace !== 'confirm') {
          return false
        }

        // 更新被替换项的播放状态
        libraryUtils.updatePlayingState(existingItem)

        // 移除同名项
        const existingItemIndex = libraryData.children.indexOf(existingItem)
        if (existingItemIndex !== -1) {
          libraryData.children.splice(existingItemIndex, 1)
        }
      }

      // 从原父目录移除
      const sourceIndex = dragItemDataFather.children.findIndex(
        (item) => item.uuid === dragItemData.uuid
      )
      if (sourceIndex !== -1) {
        const removedElement = dragItemDataFather.children.splice(sourceIndex, 1)[0]
        libraryUtils.reOrderChildren(dragItemDataFather.children)

        // 添加到目标目录末尾
        libraryData.children.push(removedElement)
        libraryUtils.reOrderChildren(libraryData.children)
        await libraryUtils.diffLibraryTreeExecuteFileOperation()
        return true
      }
    }

    return false
  } catch (error) {
    console.error('Library area empty space drop failed:', error)
    return false
  }
}
