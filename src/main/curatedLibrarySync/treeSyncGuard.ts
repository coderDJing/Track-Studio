let treeSyncSuppressedUntil = 0

/** 自己落盘引起的树事件不要立刻再开一轮同步。 */
export const suppressCuratedLibraryTreeSync = (ms = 20000): void => {
  treeSyncSuppressedUntil = Math.max(treeSyncSuppressedUntil, Date.now() + Math.max(0, ms))
}

export const isCuratedLibraryTreeSyncSuppressed = (): boolean =>
  Date.now() < treeSyncSuppressedUntil
