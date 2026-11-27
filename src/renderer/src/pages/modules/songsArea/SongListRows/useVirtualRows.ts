import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'

export const isProvidedVerticalMetrics = (top: unknown, height: unknown) =>
  typeof top === 'number' &&
  Number.isFinite(top) &&
  typeof height === 'number' &&
  Number.isFinite(height)

interface UseVirtualRowsOptions {
  songs: Ref<ISongInfo[] | undefined>
  scrollHostElement?: Ref<HTMLElement | null | undefined>
  externalScrollTop?: Ref<number | undefined>
  externalViewportHeight?: Ref<number | undefined>
}

export function useVirtualRows({
  songs,
  scrollHostElement,
  externalScrollTop,
  externalViewportHeight
}: UseVirtualRowsOptions) {
  const rowsRoot = ref<HTMLElement | null>(null)
  const viewportElement = ref<HTMLElement | null>(null)
  const hostElement = ref<HTMLElement | null>(null)
  const defaultRowHeight = 30
  const rowHeight = ref(defaultRowHeight)
  const BUFFER_ROWS = 12
  const scrollTop = ref(0)
  const scrollLeft = ref(0)
  const viewportHeight = ref(0)
  const songsComputed = computed(() => songs.value ?? [])
  const totalHeight = computed(() => songsComputed.value.length * rowHeight.value)
  // SongListRows always passes these refs, even when the parent did not sample
  // OverlayScrollbars. Only numeric values mean external metrics are in use.
  const usesExternalVerticalMetrics = () =>
    isProvidedVerticalMetrics(externalScrollTop?.value, externalViewportHeight?.value)

  function measureRowHeight() {
    const root = rowsRoot.value
    if (!root) return
    const el = root.querySelector('.song-row-content') as HTMLElement | null
    const h = el?.offsetHeight
    if (h && h > 0 && h !== rowHeight.value) {
      rowHeight.value = h
    }
  }

  let onScrollBound: ((e: Event) => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  let attachedScrollElements: HTMLElement[] = []
  let attachRetryTimer: ReturnType<typeof setTimeout> | null = null

  function getScrollHostCandidate(): HTMLElement | null | undefined {
    return scrollHostElement ? scrollHostElement.value : undefined
  }

  function resolveViewportEl(): HTMLElement | null {
    const explicitHost = getScrollHostCandidate()
    if (explicitHost instanceof HTMLElement) {
      const host = explicitHost.closest('.os-host') as HTMLElement | null
      hostElement.value = host || null
      const content = host?.querySelector('.os-content') as HTMLElement | null
      if (explicitHost.scrollHeight > explicitHost.clientHeight + 1) return explicitHost
      if (content && content.scrollHeight > content.clientHeight + 1) return content
      return explicitHost
    }
    const root = rowsRoot.value
    if (!root) return null
    const host = root.closest('.os-host') as HTMLElement | null
    hostElement.value = host || null
    const vp = host?.querySelector('.os-viewport') as HTMLElement | null
    const content = host?.querySelector('.os-content') as HTMLElement | null
    if (vp && vp.scrollHeight > vp.clientHeight + 1) return vp
    if (content && content.scrollHeight > content.clientHeight + 1) return content
    return vp || content || host || null
  }

  function detectScrollCarrier(): {
    el: HTMLElement | null
    height: number
    top: number
    left: number
  } {
    const host =
      hostElement.value ||
      rowsRoot.value?.closest?.('.os-host') ||
      viewportElement.value?.closest?.('.os-host') ||
      null
    const vp = (host as HTMLElement | null)?.querySelector?.('.os-viewport') as HTMLElement | null
    const content = (host as HTMLElement | null)?.querySelector?.(
      '.os-content'
    ) as HTMLElement | null
    const candidates: HTMLElement[] = []
    if (viewportElement.value) candidates.push(viewportElement.value)
    if (vp && !candidates.includes(vp)) candidates.push(vp)
    if (content && !candidates.includes(content)) candidates.push(content)
    if (host && !candidates.includes(host)) candidates.push(host as HTMLElement)
    for (const el of candidates) {
      const h = el.clientHeight
      const sh = el.scrollHeight
      if (h > 0 && sh > h + 1) {
        return { el, height: h, top: el.scrollTop, left: el.scrollLeft || 0 }
      }
    }
    const fallback = viewportElement.value || vp || content || (host as HTMLElement | null)
    return {
      el: fallback,
      height: fallback?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0),
      top: fallback?.scrollTop || 0,
      left: fallback?.scrollLeft || 0
    }
  }

  function applyCarrierSnapshot() {
    const carrier = detectScrollCarrier()
    if (!usesExternalVerticalMetrics()) {
      scrollTop.value = carrier.top
      viewportHeight.value = carrier.height
    }
    scrollLeft.value = carrier.left ?? 0
    return carrier
  }

  function clearAttachRetryTimer() {
    if (!attachRetryTimer) return
    clearTimeout(attachRetryTimer)
    attachRetryTimer = null
  }

  function attachListeners() {
    detachListeners()
    viewportElement.value = resolveViewportEl()
    if (!viewportElement.value) return false
    applyCarrierSnapshot()
    measureRowHeight()

    onScrollBound = () => {
      applyCarrierSnapshot()
    }

    const host = hostElement.value
    const vp = host?.querySelector('.os-viewport') as HTMLElement | null
    const content = host?.querySelector('.os-content') as HTMLElement | null
    attachedScrollElements = [viewportElement.value, vp, content, host].filter(
      (element, index, list): element is HTMLElement =>
        element instanceof HTMLElement && list.indexOf(element) === index
    )
    for (const element of attachedScrollElements) {
      element.addEventListener('scroll', onScrollBound, { passive: true })
    }

    if (typeof window !== 'undefined' && 'ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => {
        applyCarrierSnapshot()
        measureRowHeight()
      })
      for (const element of attachedScrollElements) {
        resizeObserver.observe(element)
      }
      if (rowsRoot.value) {
        resizeObserver.observe(rowsRoot.value)
      }
    }

    return true
  }

  function detachListeners() {
    clearAttachRetryTimer()
    if (onScrollBound) {
      for (const element of attachedScrollElements) {
        element.removeEventListener('scroll', onScrollBound)
      }
    }
    attachedScrollElements = []
    onScrollBound = null
    if (resizeObserver) {
      resizeObserver.disconnect()
    }
    resizeObserver = null
    viewportElement.value = null
  }

  function scheduleAttachRetry(attempt = 0) {
    if (attachRetryTimer || attempt >= 12) return
    attachRetryTimer = setTimeout(() => {
      attachRetryTimer = null
      if (!attachListeners()) {
        scheduleAttachRetry(attempt + 1)
      }
    }, 120)
  }

  onMounted(() => {
    if (!attachListeners()) {
      nextTick(() => {
        if (!attachListeners()) {
          scheduleAttachRetry()
        }
      })
    }
  })

  watch(
    () => rowsRoot.value,
    (value) => {
      if (!value) {
        detachListeners()
        return
      }
      nextTick(() => {
        if (!attachListeners()) {
          scheduleAttachRetry()
        }
      })
    }
  )

  watch(
    () => getScrollHostCandidate(),
    () => {
      nextTick(() => {
        if (!attachListeners()) {
          scheduleAttachRetry()
        }
      })
    }
  )

  watch(
    () => songsComputed.value.length,
    () => {
      nextTick(() => {
        measureRowHeight()
        applyCarrierSnapshot()
      })
    }
  )

  onUnmounted(() => {
    detachListeners()
  })

  const effectiveScrollTop = computed(() => {
    const externalTop = externalScrollTop ? externalScrollTop.value : undefined
    return typeof externalTop === 'number' ? externalTop : scrollTop.value
  })
  const effectiveViewportHeight = computed(() => {
    const externalHeight = externalViewportHeight ? externalViewportHeight.value : undefined
    return typeof externalHeight === 'number' ? externalHeight : viewportHeight.value
  })

  const startIndex = computed(() => {
    const raw = Math.floor(effectiveScrollTop.value / rowHeight.value) - BUFFER_ROWS
    return Math.max(0, raw)
  })
  const actualStartIndex = computed(() => {
    const raw = Math.floor(effectiveScrollTop.value / rowHeight.value)
    return Math.max(0, raw)
  })
  const actualVisibleRowCount = computed(() => {
    const vh =
      effectiveViewportHeight.value && effectiveViewportHeight.value > 0
        ? effectiveViewportHeight.value
        : rowsRoot.value?.parentElement?.clientHeight ||
          (typeof window !== 'undefined' ? window.innerHeight : 0)
    return Math.max(1, Math.ceil(vh / rowHeight.value))
  })
  const visibleCount = computed(() => {
    const vh =
      effectiveViewportHeight.value && effectiveViewportHeight.value > 0
        ? effectiveViewportHeight.value
        : rowsRoot.value?.parentElement?.clientHeight ||
          (typeof window !== 'undefined' ? window.innerHeight : 0)
    const base = Math.ceil(vh / rowHeight.value) + BUFFER_ROWS * 2
    return Math.max(base, BUFFER_ROWS * 2 + 1)
  })
  const endIndex = computed(() => {
    return Math.min(songsComputed.value.length, startIndex.value + visibleCount.value)
  })
  const actualEndIndex = computed(() => {
    return Math.min(
      songsComputed.value.length,
      actualStartIndex.value + actualVisibleRowCount.value
    )
  })
  const offsetTopPx = computed(() => startIndex.value * rowHeight.value)
  const visibleSongsWithIndex = computed(() => {
    const out: { song: ISongInfo; idx: number }[] = []
    const arr = songsComputed.value || []
    for (let i = startIndex.value; i < endIndex.value; i++) {
      const song = arr[i]
      if (song) out.push({ song, idx: i })
    }
    return out
  })

  return {
    rowsRoot,
    hostElement,
    viewportElement,
    visibleSongsWithIndex,
    offsetTopPx,
    totalHeight,
    rowHeight,
    effectiveScrollTop,
    effectiveViewportHeight,
    startIndex,
    endIndex,
    actualStartIndex,
    actualEndIndex,
    visibleCount,
    scrollLeft
  }
}
