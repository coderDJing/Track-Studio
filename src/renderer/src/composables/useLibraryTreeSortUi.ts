import { computed, ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import rightClickMenu from '@renderer/components/rightClickMenu'
import sortManualIconAsset from '@renderer/assets/librarySortManual.svg?asset'
import sortNameAscIconAsset from '@renderer/assets/librarySortNameAsc.svg?asset'
import sortNameDescIconAsset from '@renderer/assets/librarySortNameDesc.svg?asset'
import sortCountAscIconAsset from '@renderer/assets/librarySortCountAsc.svg?asset'
import sortCountDescIconAsset from '@renderer/assets/librarySortCountDesc.svg?asset'
import {
  buildLibraryTreeSortMenuArr,
  getLibraryTreeSortRule,
  hasCompleteLibraryTreeTrackCounts,
  libraryTreeSortRuleLabelKey,
  libraryTreeSortRuleVersion,
  libraryTreeTrackCountVersion,
  prefetchLibraryTreeTrackCounts,
  resolveLibraryTreeSortRuleFromMenuName,
  setLibraryTreeSortRule,
  sortLibraryTreeChildren,
  type LibraryTreeSortRule
} from '@renderer/utils/libraryTreeSort'
import type { IDir } from 'src/types/globals'

const SORT_ICON_BY_RULE: Record<LibraryTreeSortRule, string> = {
  manual: sortManualIconAsset,
  nameAsc: sortNameAscIconAsset,
  nameDesc: sortNameDescIconAsset,
  countAsc: sortCountAscIconAsset,
  countDesc: sortCountDescIconAsset
}

/**
 * 歌单树显示排序：规则按库共享，歌单区与选择歌单 dialog 使用同一套交互。
 * forceManual / reverseChildren 仅用于回收站这类特殊视图。
 */
export function useLibraryTreeSortUi(options: {
  libraryName: MaybeRefOrGetter<string>
  libraryRoot: MaybeRefOrGetter<IDir | null | undefined>
  isActive?: MaybeRefOrGetter<boolean>
  forceManual?: MaybeRefOrGetter<boolean>
  reverseChildren?: MaybeRefOrGetter<boolean>
}) {
  const runtime = useRuntimeStore()
  const libraryName = computed(() => String(toValue(options.libraryName) || ''))
  const libraryRoot = computed(() => toValue(options.libraryRoot) || null)
  const isActive = computed(
    () => options.isActive === undefined || Boolean(toValue(options.isActive))
  )
  const forceManual = computed(() => Boolean(toValue(options.forceManual)))
  const reverseChildren = computed(() => Boolean(toValue(options.reverseChildren)))

  const currentSortRule = computed(() => {
    void libraryTreeSortRuleVersion.value
    return forceManual.value ? 'manual' : getLibraryTreeSortRule(libraryName.value)
  })
  const isManualSort = computed(() => currentSortRule.value === 'manual')
  const sortButtonBubbleTitle = computed(() =>
    t(libraryTreeSortRuleLabelKey(currentSortRule.value))
  )
  const showSortButton = computed(() => !forceManual.value)
  const sortIconMaskStyle = computed(() => ({
    '--sort-icon-mask': `url("${SORT_ICON_BY_RULE[currentSortRule.value]}")`
  }))
  const isCountSortRule = computed(
    () => currentSortRule.value === 'countAsc' || currentSortRule.value === 'countDesc'
  )

  const displayedChildren = computed(() => {
    const children = libraryRoot.value?.children
    if (!children) return []
    if (reverseChildren.value) return [...children].reverse()
    // 依赖曲目数缓存版本，确保 count 规则在预取完成后重排
    void libraryTreeTrackCountVersion.value
    return sortLibraryTreeChildren(children, currentSortRule.value)
  })

  /**
   * 按曲目数排序且尚无任何数量数据时，先不渲染列表：
   * 否则会先按手动序闪一帧、再随统计结果整体重排。
   * 有持久化缓存的正常情况下这里立刻为 false，不会引入额外等待。
   */
  const isAwaitingTrackCounts = ref(false)
  const refreshTrackCountReadiness = () => {
    if (!isActive.value || forceManual.value || !isCountSortRule.value) {
      isAwaitingTrackCounts.value = false
      return
    }
    isAwaitingTrackCounts.value = !hasCompleteLibraryTreeTrackCounts(libraryRoot.value)
  }

  watch(
    () =>
      [
        libraryName.value,
        isActive.value,
        currentSortRule.value,
        libraryRoot.value?.children?.length,
        runtime.setting.showPlaylistTrackCount
      ] as const,
    () => {
      refreshTrackCountReadiness()
      if (!isActive.value || forceManual.value) return
      // 数量徽标和按数量排序都依赖这份数据，统一走一次批量预取
      if (!isCountSortRule.value && !runtime.setting.showPlaylistTrackCount) return
      const root = libraryRoot.value
      if (!root) return
      void prefetchLibraryTreeTrackCounts(root).then(() => {
        refreshTrackCountReadiness()
      })
    },
    { immediate: true }
  )

  watch(
    () => [libraryTreeTrackCountVersion.value, currentSortRule.value] as const,
    () => {
      refreshTrackCountReadiness()
    }
  )

  const openSortMenu = async (event: MouseEvent) => {
    if (forceManual.value) return
    const result = await rightClickMenu({
      menuArr: buildLibraryTreeSortMenuArr(currentSortRule.value),
      clickEvent: event
    })
    if (result === 'cancel') return
    const nextRule = resolveLibraryTreeSortRuleFromMenuName(result.menuName)
    if (!nextRule) return
    setLibraryTreeSortRule(libraryName.value, nextRule)
    if ((nextRule === 'countAsc' || nextRule === 'countDesc') && libraryRoot.value) {
      void prefetchLibraryTreeTrackCounts(libraryRoot.value)
    }
  }

  return {
    currentSortRule,
    isManualSort,
    showSortButton,
    sortButtonBubbleTitle,
    sortIconMaskStyle,
    displayedChildren,
    isAwaitingTrackCounts,
    openSortMenu
  }
}
