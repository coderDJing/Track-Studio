import type { IDir, IPioneerPlaylistTreeNode } from '../../../../types/globals'

type PseudoSongList = IDir
export type TreeDragApproach = 'top' | 'center' | 'bottom'
export type MoveTreeNodeResult = {
  nodes: IPioneerPlaylistTreeNode[]
  playlistId: number
  parentId: number
  seq: number
}

export const normalizeKeyword = (value: string) =>
  String(value || '')
    .trim()
    .toLowerCase()

export const sanitizeNodeName = (value: string) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')

export const calculateDragApproach = (offsetY: number, isFolder: boolean): TreeDragApproach => {
  if (!isFolder) {
    return offsetY <= 12 ? 'top' : 'bottom'
  }
  if (offsetY <= 8) return 'top'
  if (offsetY < 16) return 'center'
  return 'bottom'
}

export const toPseudoSongList = (node: IPioneerPlaylistTreeNode): PseudoSongList => ({
  uuid: String(node.id),
  dirName: node.name,
  type: 'songList'
})

export const findNodeById = (
  nodes: IPioneerPlaylistTreeNode[],
  nodeId: number
): IPioneerPlaylistTreeNode | null => {
  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode | null => {
    for (const item of items) {
      if (item.id === nodeId) return item
      const children = Array.isArray(item.children) ? item.children : []
      const matched = walk(children)
      if (matched) return matched
    }
    return null
  }
  return walk(nodes)
}

export const countNodeDescendants = (node: IPioneerPlaylistTreeNode) => {
  const summary = {
    folderCount: 0,
    playlistCount: 0
  }

  const walk = (items: IPioneerPlaylistTreeNode[]) => {
    for (const item of items) {
      if (item.isFolder) {
        summary.folderCount += 1
        if (Array.isArray(item.children) && item.children.length > 0) {
          walk(item.children)
        }
        continue
      }
      if (!item.isSmartPlaylist) {
        summary.playlistCount += 1
      }
    }
  }

  walk(Array.isArray(node.children) ? node.children : [])
  return summary
}

export const cloneTreeNodes = (nodes: IPioneerPlaylistTreeNode[]) =>
  JSON.parse(JSON.stringify(nodes)) as IPioneerPlaylistTreeNode[]

const findNodeLocation = (
  nodes: IPioneerPlaylistTreeNode[],
  nodeId: number,
  parentId = 0
): {
  node: IPioneerPlaylistTreeNode
  siblings: IPioneerPlaylistTreeNode[]
  index: number
  parentId: number
} | null => {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node.id === nodeId) {
      return {
        node,
        siblings: nodes,
        index,
        parentId
      }
    }
    const children = Array.isArray(node.children) ? node.children : []
    const matched = findNodeLocation(children, nodeId, node.id)
    if (matched) return matched
  }
  return null
}

export const isDescendantNode = (
  nodes: IPioneerPlaylistTreeNode[],
  sourceId: number,
  targetId: number
): boolean => {
  const source = findNodeById(nodes, sourceId)
  if (!source || !Array.isArray(source.children) || source.children.length === 0) return false
  const walk = (items: IPioneerPlaylistTreeNode[]): boolean => {
    for (const item of items) {
      if (item.id === targetId) return true
      if (Array.isArray(item.children) && item.children.length > 0 && walk(item.children)) {
        return true
      }
    }
    return false
  }
  return walk(source.children)
}

const reorderTreeNodes = (nodes: IPioneerPlaylistTreeNode[]) => {
  let seq = 0
  nodes.forEach((node) => {
    node.order = node.isAllTracks ? 0 : ++seq
    if (Array.isArray(node.children) && node.children.length > 0) {
      reorderTreeNodes(node.children)
    }
  })
}

export const moveTreeNode = (
  nodes: IPioneerPlaylistTreeNode[],
  sourceId: number,
  targetId: number,
  approach: TreeDragApproach
): MoveTreeNodeResult | null => {
  const nextNodes = cloneTreeNodes(nodes)
  const sourceBeforeMove = findNodeLocation(nextNodes, sourceId)
  const targetBeforeMove = findNodeLocation(nextNodes, targetId)
  if (!sourceBeforeMove || !targetBeforeMove) return null
  if (sourceBeforeMove.node.isAllTracks || targetBeforeMove.node.isAllTracks) return null

  const originalParentId = sourceBeforeMove.parentId
  const originalSeq = sourceBeforeMove.siblings
    .slice(0, sourceBeforeMove.index + 1)
    .filter((node) => !node.isAllTracks).length

  const [movedNode] = sourceBeforeMove.siblings.splice(sourceBeforeMove.index, 1)
  if (!movedNode) return null

  let nextParentId = 0
  let nextSeq = 1

  if (approach === 'center') {
    const folderTarget = findNodeById(nextNodes, targetId)
    if (!folderTarget || !folderTarget.isFolder) return null
    folderTarget.children = Array.isArray(folderTarget.children) ? folderTarget.children : []
    nextParentId = folderTarget.id
    nextSeq = 1
    movedNode.parentId = nextParentId
    folderTarget.children.unshift(movedNode)
  } else {
    const targetAfterRemoval = findNodeLocation(nextNodes, targetId)
    if (!targetAfterRemoval) return null
    nextParentId = targetAfterRemoval.parentId
    nextSeq = targetAfterRemoval.index + (approach === 'bottom' ? 2 : 1)
    movedNode.parentId = nextParentId
    targetAfterRemoval.siblings.splice(nextSeq - 1, 0, movedNode)
  }

  reorderTreeNodes(nextNodes)
  const movedAfter = findNodeLocation(nextNodes, sourceId)
  if (!movedAfter) return null

  const finalParentId = movedAfter.parentId
  const finalSeq = movedAfter.siblings
    .slice(0, movedAfter.index + 1)
    .filter((node) => !node.isAllTracks).length
  if (finalParentId === originalParentId && finalSeq === originalSeq) {
    return null
  }

  return {
    nodes: nextNodes,
    playlistId: sourceId,
    parentId: finalParentId,
    seq: finalSeq
  }
}

export const moveTreeNodeToRootEnd = (
  nodes: IPioneerPlaylistTreeNode[],
  sourceId: number
): MoveTreeNodeResult | null => {
  const nextNodes = cloneTreeNodes(nodes)
  const sourceBeforeMove = findNodeLocation(nextNodes, sourceId)
  if (!sourceBeforeMove) return null
  if (sourceBeforeMove.node.isAllTracks) return null

  const originalParentId = sourceBeforeMove.parentId
  const originalSeq = sourceBeforeMove.siblings
    .slice(0, sourceBeforeMove.index + 1)
    .filter((node) => !node.isAllTracks).length

  const [movedNode] = sourceBeforeMove.siblings.splice(sourceBeforeMove.index, 1)
  if (!movedNode) return null

  movedNode.parentId = 0
  nextNodes.push(movedNode)
  reorderTreeNodes(nextNodes)

  const movedAfter = findNodeLocation(nextNodes, sourceId)
  if (!movedAfter) return null

  const finalParentId = movedAfter.parentId
  const finalSeq = movedAfter.siblings
    .slice(0, movedAfter.index + 1)
    .filter((node) => !node.isAllTracks).length
  if (finalParentId === originalParentId && finalSeq === originalSeq) {
    return null
  }

  return {
    nodes: nextNodes,
    playlistId: sourceId,
    parentId: finalParentId,
    seq: finalSeq
  }
}

export const isPlayablePlaylistNode = (
  node: IPioneerPlaylistTreeNode | null | undefined
): node is IPioneerPlaylistTreeNode => Boolean(node && !node.isFolder && !node.isSmartPlaylist)

export const isWritablePlaylistNode = (
  node: IPioneerPlaylistTreeNode | null | undefined
): node is IPioneerPlaylistTreeNode => isPlayablePlaylistNode(node) && !node.isAllTracks

export const isMovableTreeNode = (node: IPioneerPlaylistTreeNode | null | undefined) =>
  Boolean(node && !node.isSmartPlaylist && !node.isAllTracks)

export const flattenPlayableNodes = (nodes: IPioneerPlaylistTreeNode[]) => {
  const result: IPioneerPlaylistTreeNode[] = []
  const walk = (items: IPioneerPlaylistTreeNode[]) => {
    for (const item of items) {
      if (isWritablePlaylistNode(item)) result.push(item)
      if (Array.isArray(item.children) && item.children.length > 0) {
        walk(item.children)
      }
    }
  }
  walk(nodes)
  return result
}

export const filterTreeNodes = (nodes: IPioneerPlaylistTreeNode[], keyword: string) => {
  const normalizedKeyword = normalizeKeyword(keyword)
  if (!normalizedKeyword) {
    const stripSmart = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode[] =>
      items
        .map((item) => {
          if (item.isFolder) {
            return {
              ...item,
              children: stripSmart(Array.isArray(item.children) ? item.children : [])
            }
          }
          return item
        })
        .filter((item) => item.isFolder || !item.isSmartPlaylist)
    return stripSmart(nodes)
  }

  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode[] => {
    const result: IPioneerPlaylistTreeNode[] = []
    for (const item of items) {
      if (item.isFolder) {
        const children = walk(Array.isArray(item.children) ? item.children : [])
        if (children.length > 0) {
          result.push({
            ...item,
            children
          })
        }
        continue
      }
      if (item.isSmartPlaylist) continue
      if (item.name.toLowerCase().includes(normalizedKeyword)) {
        result.push({
          ...item,
          children: []
        })
      }
    }
    return result
  }

  return walk(nodes)
}

export const collectFolderIds = (nodes: IPioneerPlaylistTreeNode[]) => {
  const ids: number[] = []
  const walk = (items: IPioneerPlaylistTreeNode[]) => {
    for (const item of items) {
      if (item.isFolder) ids.push(item.id)
      if (Array.isArray(item.children) && item.children.length > 0) {
        walk(item.children)
      }
    }
  }
  walk(nodes)
  return ids
}
