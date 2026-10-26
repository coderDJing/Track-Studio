import { sameRendererFilePath } from '@renderer/utils/filePathComparison'
import { nextTick } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import type { ISongsAreaPaneRuntimeState, useRuntimeStore } from '@renderer/stores/runtime'
import { detectSongsAreaScrollCarrier } from './scrollCarrier'

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

interface UseAutoScrollParams {
  runtime: ReturnType<typeof useRuntimeStore>
  songsAreaState: ISongsAreaPaneRuntimeState
  songsAreaRef: { value: OverlayScrollbarsComponentRef }
}

export function useAutoScrollToCurrent(params: UseAutoScrollParams) {
  const { songsAreaState, songsAreaRef } = params

  const ROW_HEIGHT = 30
  const SCROLL_TOLERANCE_PX = 2
  const TOP_VISIBILITY_MARGIN_PX = 2
  const MAX_SCROLL_RETRIES = 8
  const FOLLOW_UP_CHECK_DELAY_MS = 120
  let activeScrollToken = 0

  const resolveScrollContext = () => {
    const scrollElements = songsAreaRef.value?.osInstance()?.elements()
    const explicitViewport = scrollElements?.viewport as HTMLElement | undefined
    const explicitHost = scrollElements?.host as HTMLElement | undefined
    const detected = detectSongsAreaScrollCarrier(
      explicitViewport || explicitHost || null,
      explicitHost || null
    )
    const viewportElement = detected.viewport || detected.carrier
    const scrollElement = detected.carrier
    if (!viewportElement || !scrollElement || detected.height <= 0) return null
    return { viewportElement, scrollElement }
  }

  const resolveHeaderOffset = (viewportElement: HTMLElement) => {
    const host = viewportElement.closest('.os-host') as HTMLElement | null
    const header = host?.querySelector('.songListHeader') as HTMLElement | null
    const height = header?.offsetHeight ?? 0
    return Number.isFinite(height) ? height : 0
  }

  const resolveBottomOverlayInset = (viewportElement: HTMLElement) => {
    const viewportRect = viewportElement.getBoundingClientRect()
    const selectors = [
      '.playerArea',
      '.controlsContainer',
      '.playerControlsRoot',
      '.playerControls',
      '.bottom-info-area'
    ]
    const segments: Array<[number, number]> = []
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector)
      for (const el of Array.from(elements)) {
        if (!(el instanceof HTMLElement)) continue
        const rect = el.getBoundingClientRect()
        if (rect.height <= 0 || rect.width <= 0) continue
        const top = Math.max(viewportRect.top, rect.top)
        const bottom = Math.min(viewportRect.bottom, rect.bottom)
        if (bottom <= top) continue
        segments.push([top, bottom])
      }
    }
    if (segments.length === 0) return 0
    segments.sort((a, b) => a[0] - b[0])
    let covered = 0
    let currentStart = segments[0][0]
    let currentEnd = segments[0][1]
    for (let i = 1; i < segments.length; i++) {
      const [start, end] = segments[i]
      if (start <= currentEnd) {
        currentEnd = Math.max(currentEnd, end)
        continue
      }
      covered += currentEnd - currentStart
      currentStart = start
      currentEnd = end
    }
    covered += currentEnd - currentStart
    return Math.max(0, covered)
  }

  const resolveTopOverlayInset = (viewportElement: HTMLElement) => {
    const viewportRect = viewportElement.getBoundingClientRect()
    const selectors = ['.songListHeader']
    let inset = 0
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector)
      for (const el of Array.from(elements)) {
        if (!(el instanceof HTMLElement)) continue
        const rect = el.getBoundingClientRect()
        if (rect.height <= 0 || rect.width <= 0) continue
        const top = Math.max(viewportRect.top, rect.top)
        const bottom = Math.min(viewportRect.bottom, rect.bottom)
        if (bottom <= top) continue
        const touchesTop = top <= viewportRect.top + 2
        if (!touchesTop) continue
        inset = Math.max(inset, bottom - viewportRect.top)
      }
    }
    return inset
  }

  const resolveSafeAreaMetrics = (viewportElement: HTMLElement) => {
    const viewportRect = viewportElement.getBoundingClientRect()
    const headerOffset = resolveHeaderOffset(viewportElement)
    const topInsetRaw = resolveTopOverlayInset(viewportElement)
    const clampedTopInset = Math.min(topInsetRaw, viewportElement.clientHeight)
    const topVisibilityInset = clampedTopInset + TOP_VISIBILITY_MARGIN_PX
    const bottomInset = resolveBottomOverlayInset(viewportElement)
    const clampedBottomInset = Math.min(bottomInset, viewportElement.clientHeight)
    const safeTop = viewportRect.top + topVisibilityInset
    const safeBottom = viewportRect.bottom - clampedBottomInset
    const safeHeight = Math.max(0, safeBottom - safeTop)
    return {
      headerOffset,
      topInset: clampedTopInset,
      topVisibilityInset,
      bottomInset: clampedBottomInset,
      safeTop,
      safeBottom,
      safeHeight
    }
  }

  const resolveViewportMetrics = (viewportElement: HTMLElement, scrollElement: HTMLElement) => {
    const { headerOffset, topVisibilityInset, bottomInset } =
      resolveSafeAreaMetrics(viewportElement)
    const viewTop = scrollElement.scrollTop + topVisibilityInset
    const viewBottom = scrollElement.scrollTop + viewportElement.clientHeight - bottomInset
    const safeHeight = Math.max(0, viewportElement.clientHeight - topVisibilityInset - bottomInset)
    return { headerOffset, topVisibilityInset, bottomInset, viewTop, viewBottom, safeHeight }
  }

  const resolveRowElement = (index: number, queryRoot: ParentNode) => {
    const song = songsAreaState.songInfoArr[index]
    const rowKey = song?.mixtapeItemId || song?.setItemId || song?.filePath
    if (!rowKey) return null
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(rowKey)
        : rowKey.replace(/["\\]/g, '\\$&')
    const selector = `.song-row-item[data-rowkey="${escaped}"]`
    return (queryRoot.querySelector(selector) as HTMLElement | null) ?? null
  }

  const isIndexVisible = (
    index: number,
    viewportElement: HTMLElement,
    scrollElement: HTMLElement
  ) => {
    const rowEl = resolveRowElement(index, viewportElement)
    if (rowEl) {
      const { safeTop, safeBottom } = resolveSafeAreaMetrics(viewportElement)
      const rect = rowEl.getBoundingClientRect()
      return rect.top >= safeTop && rect.bottom <= safeBottom
    }
    const { headerOffset, viewTop, viewBottom } = resolveViewportMetrics(
      viewportElement,
      scrollElement
    )
    const rowTop = headerOffset + index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    return rowTop >= viewTop && rowBottom <= viewBottom
  }

  const getTargetTop = (
    index: number,
    viewportElement: HTMLElement,
    scrollElement: HTMLElement,
    align: 'center' | 'nearest'
  ) => {
    const rowEl = resolveRowElement(index, viewportElement)
    if (rowEl) {
      const { safeTop, safeBottom, safeHeight } = resolveSafeAreaMetrics(viewportElement)
      const rect = rowEl.getBoundingClientRect()
      const scrollTop = scrollElement.scrollTop
      if (align === 'nearest') {
        if (rect.top < safeTop) return Math.max(0, scrollTop - (safeTop - rect.top))
        if (rect.bottom > safeBottom) return Math.max(0, scrollTop + (rect.bottom - safeBottom))
        return scrollTop
      }
      if (safeHeight <= 0) {
        return Math.max(0, scrollTop + rect.top - safeTop)
      }
      const rowCenter = rect.top + rect.height / 2
      const safeCenter = safeTop + safeHeight / 2
      return Math.max(0, scrollTop + (rowCenter - safeCenter))
    }
    const { headerOffset, topVisibilityInset, bottomInset, viewTop, viewBottom, safeHeight } =
      resolveViewportMetrics(viewportElement, scrollElement)
    const rowTop = headerOffset + index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    if (align === 'nearest') {
      if (rowTop < viewTop) return Math.max(0, rowTop - topVisibilityInset)
      if (rowBottom > viewBottom) {
        return Math.max(0, rowBottom - (viewportElement.clientHeight - bottomInset))
      }
      return scrollElement.scrollTop
    }
    if (safeHeight <= 0) {
      return Math.max(0, rowTop - viewportElement.clientHeight / 2)
    }
    return Math.max(0, rowTop + ROW_HEIGHT / 2 - topVisibilityInset - safeHeight / 2)
  }

  const runScroll = (
    index: number,
    options?: {
      behavior?: ScrollBehavior
      align?: 'center' | 'nearest'
      onlyIfNeeded?: boolean
    }
  ): 'done' | 'retry' => {
    if (!Number.isFinite(index) || index < 0) return 'done'
    const scrollContext = resolveScrollContext()
    if (!scrollContext) return 'retry'
    const { viewportElement, scrollElement } = scrollContext

    const align = options?.align ?? 'center'
    if (options?.onlyIfNeeded && isIndexVisible(index, viewportElement, scrollElement))
      return 'done'

    const targetTop = getTargetTop(index, viewportElement, scrollElement, align)
    if (Math.abs(scrollElement.scrollTop - targetTop) <= SCROLL_TOLERANCE_PX) return 'done'
    try {
      scrollElement.scrollTo({ top: targetTop, behavior: options?.behavior ?? 'smooth' })
    } catch {
      scrollElement.scrollTop = targetTop
    }
    return 'done'
  }

  const needsFollowUpCheck = (
    index: number,
    viewportElement: HTMLElement,
    scrollElement: HTMLElement,
    options?: {
      behavior?: ScrollBehavior
      align?: 'center' | 'nearest'
      onlyIfNeeded?: boolean
    }
  ) => {
    if (options?.onlyIfNeeded) {
      return !isIndexVisible(index, viewportElement, scrollElement)
    }
    const align = options?.align ?? 'center'
    const targetTop = getTargetTop(index, viewportElement, scrollElement, align)
    return Math.abs(scrollElement.scrollTop - targetTop) > SCROLL_TOLERANCE_PX
  }

  const queueScroll = (
    index: number,
    options: {
      behavior?: ScrollBehavior
      align?: 'center' | 'nearest'
      onlyIfNeeded?: boolean
    },
    attempt = 0,
    token = activeScrollToken
  ) => {
    if (!songsAreaRef.value || token !== activeScrollToken) return
    nextTick(() => {
      if (token !== activeScrollToken) return
      const result = runScroll(index, options)
      if (result === 'retry') {
        if (attempt >= MAX_SCROLL_RETRIES) return
        requestAnimationFrame(() => queueScroll(index, options, attempt + 1, token))
        return
      }
      if (attempt >= MAX_SCROLL_RETRIES) return
      window.setTimeout(() => {
        if (token !== activeScrollToken) return
        nextTick(() => {
          if (token !== activeScrollToken) return
          const scrollContext = resolveScrollContext()
          if (!scrollContext) {
            requestAnimationFrame(() =>
              queueScroll(index, { ...options, behavior: 'auto' }, attempt + 1, token)
            )
            return
          }
          const { viewportElement, scrollElement } = scrollContext
          if (!needsFollowUpCheck(index, viewportElement, scrollElement, options)) return
          queueScroll(index, { ...options, behavior: 'auto' }, attempt + 1, token)
        })
      }, FOLLOW_UP_CHECK_DELAY_MS)
    })
  }

  const scrollToIndex = (index: number, behavior: ScrollBehavior = 'smooth') => {
    activeScrollToken += 1
    queueScroll(index, { behavior, align: 'center' }, 0, activeScrollToken)
  }

  const scrollToIndexIfNeeded = (index: number, align: 'center' | 'nearest' = 'center') => {
    activeScrollToken += 1
    queueScroll(index, { onlyIfNeeded: true, align }, 0, activeScrollToken)
  }

  const scrollToSong = (filePath?: string | null) => {
    if (!filePath) return
    const index = songsAreaState.songInfoArr.findIndex((s) =>
      sameRendererFilePath(s.filePath, filePath)
    )
    if (index < 0) return
    scrollToIndex(index)
  }

  return {
    scrollToIndex,
    scrollToIndexIfNeeded,
    scrollToSong
  }
}
