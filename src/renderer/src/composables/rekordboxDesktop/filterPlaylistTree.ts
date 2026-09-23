import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'

export const filterPlaylistTreeByName = (
  nodes: IPioneerPlaylistTreeNode[],
  keyword: string
): IPioneerPlaylistTreeNode[] => {
  const normalizedKeyword = keyword.trim().toLowerCase()
  if (!normalizedKeyword) return nodes

  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode[] => {
    const result: IPioneerPlaylistTreeNode[] = []
    for (const item of items) {
      const children = Array.isArray(item.children) ? walk(item.children) : []
      if (item.isFolder) {
        if (children.length > 0) result.push({ ...item, children })
        continue
      }
      if (item.name.toLowerCase().includes(normalizedKeyword)) {
        result.push({ ...item, children: [] })
      }
    }
    return result
  }
  return walk(nodes)
}
