export type SongListLoadTicket = Readonly<{
  generation: number
  songListUUID: string
}>

export const isSongListViewPending = (songListUUID: string, appliedSongListUUID: string) =>
  songListUUID !== '' && appliedSongListUUID !== songListUUID

// 转圈只看延迟后的 loadingShow。切歌单时 UUID 还没落地不能立刻改 viewState，
// 否则外层 out-in 会把整页卸掉再装上，快照命中也会闪一下。
// 回切到已落地歌单且可见列表已被清空时，仍立刻保持载入态，避免先画出空表头。
export const shouldHoldSongListLoading = (params: {
  songListUUID: string
  appliedSongListUUID: string
  visibleCount: number
  isRequesting: boolean
  loadingShow?: boolean
}) => {
  if (params.loadingShow) return true
  return (
    params.isRequesting &&
    params.visibleCount === 0 &&
    params.songListUUID !== '' &&
    params.appliedSongListUUID === params.songListUUID
  )
}

// 离开动画只能画“当前 UUID 的数据还没落地”时的旧快照。
// 新歌单一旦 applied，绝不能再让上一份 leaveData 盖住真实列表。
export const resolveDisplayedSongList = <T>(
  leaveSongs: T[] | null | undefined,
  currentSongs: T[],
  songListUUID: string,
  appliedSongListUUID: string
): T[] => {
  if (leaveSongs && isSongListViewPending(songListUUID, appliedSongListUUID)) {
    return leaveSongs
  }
  return currentSongs
}

export const createSongListLoadGenerationGuard = (getCurrentSongListUUID: () => string) => {
  let generation = 0

  const begin = (songListUUID: string): SongListLoadTicket => ({
    generation: ++generation,
    songListUUID
  })

  const invalidate = () => {
    generation += 1
  }

  const isCurrent = (ticket: SongListLoadTicket) =>
    ticket.generation === generation && ticket.songListUUID === getCurrentSongListUUID()

  return {
    begin,
    invalidate,
    isCurrent
  }
}
