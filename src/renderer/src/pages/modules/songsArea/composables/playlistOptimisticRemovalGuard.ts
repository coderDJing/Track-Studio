type SongPathItem = {
  filePath?: string
}

export const createPlaylistOptimisticRemovalGuard = (
  normalizePath: (filePath: string | undefined | null) => string
) => {
  const blockedPathsByPlaylist = new Map<string, Set<string>>()

  const block = (songListUUID: string, filePaths: readonly string[]) => {
    if (!songListUUID) return
    const blocked = blockedPathsByPlaylist.get(songListUUID) || new Set<string>()
    for (const filePath of filePaths) {
      const key = normalizePath(filePath)
      if (key) blocked.add(key)
    }
    if (blocked.size > 0) blockedPathsByPlaylist.set(songListUUID, blocked)
  }

  const release = (songListUUID: string, filePaths: readonly string[]) => {
    const blocked = blockedPathsByPlaylist.get(songListUUID)
    if (!blocked) return
    for (const filePath of filePaths) {
      const key = normalizePath(filePath)
      if (key) blocked.delete(key)
    }
    if (blocked.size === 0) blockedPathsByPlaylist.delete(songListUUID)
  }

  const filterRefreshItems = <T extends SongPathItem>(songListUUID: string, items: T[]): T[] => {
    const blocked = blockedPathsByPlaylist.get(songListUUID)
    if (!blocked?.size) return items

    const refreshPathSet = new Set(
      items.map((item) => normalizePath(item.filePath)).filter(Boolean)
    )
    for (const blockedPath of [...blocked]) {
      // 新权威刷新已经不含该路径，说明乐观删除得到磁盘确认，屏障可以释放。
      if (!refreshPathSet.has(blockedPath)) blocked.delete(blockedPath)
    }
    if (blocked.size === 0) {
      blockedPathsByPlaylist.delete(songListUUID)
      return items
    }
    return items.filter((item) => !blocked.has(normalizePath(item.filePath)))
  }

  const isBlocked = (songListUUID: string, filePath: string): boolean =>
    blockedPathsByPlaylist.get(songListUUID)?.has(normalizePath(filePath)) === true

  return {
    block,
    release,
    filterRefreshItems,
    isBlocked
  }
}
