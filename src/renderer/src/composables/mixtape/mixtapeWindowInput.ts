type ValueRef<T> = {
  value: T
}

type MixtapeWindowInputContext = {
  trackContextMenuVisible: ValueRef<boolean>
  beatAlignDialogVisible: ValueRef<boolean>
  transportPreloading: ValueRef<boolean>
  transportPlaying: ValueRef<boolean>
  transportDecoding: ValueRef<boolean>
  outputDialogVisible: ValueRef<boolean>
  chapterDialogVisible: ValueRef<boolean>
  outputRunning: ValueRef<boolean>
  autoGainDialogVisible: ValueRef<boolean>
  closeTrackContextMenu: () => void
  handleTransportStop: () => void
  handleTransportPlayFromStart: () => void
}

export const createMixtapeWindowInputHandlers = (ctx: MixtapeWindowInputContext) => {
  const {
    trackContextMenuVisible,
    beatAlignDialogVisible,
    transportPreloading,
    transportPlaying,
    transportDecoding,
    outputDialogVisible,
    chapterDialogVisible,
    outputRunning,
    autoGainDialogVisible,
    closeTrackContextMenu,
    handleTransportStop,
    handleTransportPlayFromStart
  } = ctx

  const handleGlobalPointerDown = (event: PointerEvent) => {
    if (!trackContextMenuVisible.value) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.mixtape-track-menu')) return
    closeTrackContextMenu()
  }

  const isEditableEventTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null
    if (!element) return false
    if (element.isContentEditable) return true
    const tag = element.tagName?.toLowerCase() || ''
    return tag === 'input' || tag === 'textarea' || tag === 'select'
  }

  const handleWindowKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.isComposing) return
    if (event.code !== 'Space' && event.key !== ' ') return
    if (event.repeat) {
      event.preventDefault()
      return
    }
    if (isEditableEventTarget(event.target)) return
    if (
      beatAlignDialogVisible.value ||
      transportPreloading.value ||
      outputDialogVisible.value ||
      chapterDialogVisible.value ||
      outputRunning.value ||
      autoGainDialogVisible.value
    )
      return

    event.preventDefault()
    if (transportPlaying.value || transportDecoding.value) {
      handleTransportStop()
      return
    }
    handleTransportPlayFromStart()
  }

  return {
    handleGlobalPointerDown,
    handleWindowKeydown
  }
}
