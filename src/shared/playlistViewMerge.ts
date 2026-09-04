import type { ISongInfo } from '../types/globals'
import type { SongListItemComparator } from './songListItemCompare'

/**
 * 后台刷新用的"就地合并计划"。
 *
 * 红线（用户体验）：后台核对/重扫的结果绝不能让列表看起来退出重进或闪动。
 * 因此这里不返回"整份新列表"让上层无脑覆盖，而是逐行判断：
 *   - 内容等价的行 → 复用**旧对象引用**，Vue 的 keyed diff 不会重建这一行；
 *   - 真变了的行 → 用新对象；
 *   - 完全没变化 → `changed = false`，上层必须一个动作都不做（不赋值、不重排、不滚动）。
 *
 * 这样即使 5000 行的歌单在后台被核对，用户看到的也只是个别行的字段刷新。
 */
export type SongListMergeStats = {
  changed: boolean
  addedCount: number
  removedCount: number
  updatedCount: number
  movedCount: number
  /** 变化里是否包含"非分析字段"（文件名/标题/序号…）。仅分析字段变化时可以更安静地处理。 */
  meaningfulUpdatedCount: number
}

export type SongListMergeResult = SongListMergeStats & {
  /** changed 为 false 时，这里就是传入的 current，调用方不要赋值。 */
  items: ISongInfo[]
}

export type PlanSongListMergeParams = {
  current: readonly ISongInfo[]
  next: readonly ISongInfo[]
  comparator: SongListItemComparator
  /** renderer 传入 rAF 让出，避免大歌单合并时长任务卡住合成；主进程可以不传。 */
  onYield?: (processedCount: number, totalCount: number) => Promise<void> | void
}

const UNCHANGED: SongListMergeStats = {
  changed: false,
  addedCount: 0,
  removedCount: 0,
  updatedCount: 0,
  movedCount: 0,
  meaningfulUpdatedCount: 0
}

export async function planSongListMerge(
  params: PlanSongListMergeParams
): Promise<SongListMergeResult> {
  const { current, next, comparator, onYield } = params
  const currentItems = current as ISongInfo[]

  if (current.length === 0 && next.length === 0) {
    return { ...UNCHANGED, items: currentItems }
  }

  const currentIndexByKey = new Map<string, number>()
  let hasUnusableCurrentKey = false
  for (const [index, song] of current.entries()) {
    const key = comparator.getSongIdentityKey(song)
    if (!key || currentIndexByKey.has(key)) {
      hasUnusableCurrentKey = true
      continue
    }
    currentIndexByKey.set(key, index)
  }

  const items: ISongInfo[] = new Array(next.length)
  const matchedCurrentIndexes = new Set<number>()
  let addedCount = 0
  let updatedCount = 0
  let movedCount = 0
  let meaningfulUpdatedCount = 0
  let processed = 0

  for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
    const nextSong = next[nextIndex]
    const key = comparator.getSongIdentityKey(nextSong)
    const currentIndex = key ? currentIndexByKey.get(key) : undefined

    if (currentIndex === undefined) {
      items[nextIndex] = nextSong
      addedCount += 1
    } else {
      matchedCurrentIndexes.add(currentIndex)
      if (currentIndex !== nextIndex) movedCount += 1
      const currentSong = current[currentIndex]
      if (comparator.isEquivalentSongInfo(nextSong, currentSong)) {
        // 关键：复用旧引用，行不会被 Vue 判定为"新行"。
        items[nextIndex] = currentSong
      } else {
        items[nextIndex] = nextSong
        updatedCount += 1
        const diffFields = comparator.getSongInfoDiffFields(nextSong, currentSong)
        if (comparator.hasMeaningfulDiffField(diffFields)) {
          meaningfulUpdatedCount += 1
        }
      }
    }

    processed += 1
    if (onYield) await onYield(processed, next.length)
  }

  const removedCount = currentIndexByKey.size - matchedCurrentIndexes.size
  const changed =
    hasUnusableCurrentKey ||
    current.length !== next.length ||
    addedCount > 0 ||
    removedCount > 0 ||
    updatedCount > 0 ||
    movedCount > 0

  if (!changed) return { ...UNCHANGED, items: currentItems }

  return {
    changed: true,
    items,
    addedCount,
    removedCount,
    updatedCount,
    movedCount,
    meaningfulUpdatedCount
  }
}
