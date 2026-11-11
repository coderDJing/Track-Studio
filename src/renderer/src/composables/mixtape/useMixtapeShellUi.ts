import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'

type ReadonlyRef<T> = Readonly<Ref<T>>

type UseMixtapeShellUiOptions = {
  renderZoomLevel: ReadonlyRef<number>
  setZoomValue: (value: number) => void
  applyRenderZoomImmediate: () => void
  canUndoMixParam: ReadonlyRef<boolean>
  handleUndoMixParam: () => void
  canRedoMixParam: ReadonlyRef<boolean>
  handleRedoMixParam: () => void
  handleEnvelopeKeydown: (event: KeyboardEvent) => void
  beatAlignDialogVisible: ReadonlyRef<boolean>
  outputDialogVisible: ReadonlyRef<boolean>
  autoGainDialogVisible: ReadonlyRef<boolean>
  cleanupGainEnvelopeEditor: () => void
}

export const useMixtapeShellUi = ({
  renderZoomLevel,
  setZoomValue,
  applyRenderZoomImmediate,
  canUndoMixParam,
  handleUndoMixParam,
  canRedoMixParam,
  handleRedoMixParam,
  handleEnvelopeKeydown,
  beatAlignDialogVisible,
  outputDialogVisible,
  autoGainDialogVisible,
  cleanupGainEnvelopeEditor
}: UseMixtapeShellUiOptions) => {
  const runtime = useRuntimeStore()
  const systemPrefersDark = ref(false)
  let systemThemeMedia: MediaQueryList | null = null
  let removeSystemThemeListener: (() => void) | null = null

  const isLightTheme = computed(() => {
    const themeMode = String(runtime.setting.themeMode || 'system')
    if (themeMode === 'light') return true
    if (themeMode === 'dark') return false
    return !systemPrefersDark.value
  })

  const handleZoomIn = () => {
    setZoomValue(renderZoomLevel.value * 1.5)
    applyRenderZoomImmediate()
  }

  const handleZoomOut = () => {
    setZoomValue(renderZoomLevel.value / 1.5)
    applyRenderZoomImmediate()
  }

  const isEditableEventTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null
    if (!element) return false
    if (element.isContentEditable) return true
    const tag = element.tagName?.toLowerCase() || ''
    return tag === 'input' || tag === 'textarea' || tag === 'select'
  }

  const handleUndoKeydown = (event: KeyboardEvent) => {
    if (runtime.confirmShow) return
    if (event.defaultPrevented) return
    if (event.isComposing || event.repeat) return
    if (isEditableEventTarget(event.target)) return
    if (beatAlignDialogVisible.value || outputDialogVisible.value || autoGainDialogVisible.value) {
      return
    }
    handleEnvelopeKeydown(event)
    if (event.defaultPrevented) return
    const key = String(event.key || '').toLowerCase()
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    if ((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)) {
      if (!canRedoMixParam.value) return
      event.preventDefault()
      handleRedoMixParam()
    } else if (key === 'z' && !event.shiftKey && canUndoMixParam.value) {
      event.preventDefault()
      handleUndoMixParam()
    }
  }

  onMounted(() => {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)')
      systemPrefersDark.value = !!systemThemeMedia.matches
      const handleThemeChange = (event: MediaQueryListEvent) => {
        systemPrefersDark.value = !!event.matches
      }
      if (typeof systemThemeMedia.addEventListener === 'function') {
        systemThemeMedia.addEventListener('change', handleThemeChange)
        removeSystemThemeListener = () => {
          systemThemeMedia?.removeEventListener('change', handleThemeChange)
        }
      } else if (typeof systemThemeMedia.addListener === 'function') {
        systemThemeMedia.addListener(handleThemeChange)
        removeSystemThemeListener = () => {
          systemThemeMedia?.removeListener(handleThemeChange)
        }
      }
    }
    window.addEventListener('keydown', handleUndoKeydown)
  })

  onBeforeUnmount(() => {
    if (removeSystemThemeListener) {
      removeSystemThemeListener()
      removeSystemThemeListener = null
    }
    systemThemeMedia = null
    try {
      window.removeEventListener('keydown', handleUndoKeydown)
    } catch {}
    cleanupGainEnvelopeEditor()
  })

  return {
    handleZoomIn,
    handleZoomOut,
    isLightTheme
  }
}
