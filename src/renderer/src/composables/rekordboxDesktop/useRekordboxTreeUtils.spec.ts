import { describe, expect, it } from 'vitest'
import {
  isMovableTreeNode,
  isPlayablePlaylistNode,
  isWritablePlaylistNode,
  moveTreeNode,
  moveTreeNodeToRootEnd
} from './useRekordboxTreeUtils'
import { createDjLibraryCollectionNode } from '@shared/djLibraryCollection'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'

const playlist = (id: number): IPioneerPlaylistTreeNode => ({
  id,
  parentId: 0,
  name: `Set ${id}`,
  isFolder: false,
  order: id,
  sortOrder: id
})

describe('playlist ordering with a fixed collection entry', () => {
  const collection = createDjLibraryCollectionNode(Number.MAX_SAFE_INTEGER)
  const nodes = [collection, playlist(2), playlist(3)]

  it('does not count the collection entry in persisted playlist positions', () => {
    const moved = moveTreeNode(nodes, 3, 2, 'top')
    expect(moved?.seq).toBe(1)
    expect(moved?.nodes.map((node) => node.id)).toEqual([collection.id, 3, 2])
    expect(moved?.nodes.map((node) => node.order)).toEqual([0, 1, 2])
    expect(moveTreeNodeToRootEnd(nodes, 2)?.seq).toBe(2)
  })

  it('protects the collection from moves and selection as a write target', () => {
    expect(isMovableTreeNode(collection)).toBe(false)
    expect(isPlayablePlaylistNode(collection)).toBe(true)
    expect(isWritablePlaylistNode(collection)).toBe(false)
    expect(moveTreeNode(nodes, collection.id, 2, 'bottom')).toBeNull()
    expect(moveTreeNode(nodes, 2, collection.id, 'top')).toBeNull()
    expect(moveTreeNodeToRootEnd(nodes, collection.id)).toBeNull()
    expect(moveTreeNodeToRootEnd(nodes, 3)).toBeNull()
  })
})
