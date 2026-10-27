import { computed, onUnmounted, ref, type Ref } from 'vue'
import { clampNumber } from '@renderer/composables/horizontalBrowse/horizontalBrowseMath'
import { clampVolumeValue } from '@renderer/utils/windowVolume'

type UseHorizontalBrowseOutputParams = {
  nativeTransport: {
    state: {
      output?: {
        crossfaderValue?: number
        masterGain?: number
      }
    }
    setOutputState: (crossfaderValue: number, masterGain: number) => Promise<unknown>
  }
  mainWindowVolume: Ref<number>
}

const FADER_TRAVEL_INSET_RATIO = 0.17
const CROSSFADER_KEY_STEP = 0.25
const CROSSFADER_WHEEL_STEP = 0.05

export const useHorizontalBrowseOutput = ({
  nativeTransport,
  mainWindowVolume
}: UseHorizontalBrowseOutputParams) => {
  const faderRef = ref<HTMLElement | null>(null)
  const faderRailRef = ref<HTMLElement | null>(null)
  const faderDragging = ref(false)
  let pendingWheelValue: number | null = null
  let wheelRequestId = 0

  const resolveCrossfaderTravelPercentByValue = (value: number) => {
    const travelPercent = FADER_TRAVEL_INSET_RATIO * 100
    const usablePercent = 100 - travelPercent * 2
    return travelPercent + (1 - clampNumber(value, -1, 1)) * 0.5 * usablePercent
  }

  const faderTicks = Array.from({ length: 9 }, (_, index) => ({
    id: index,
    top: `${resolveCrossfaderTravelPercentByValue(1 - index / 4)}%`,
    major: index === 0 || index === 4 || index === 8,
    center: index === 4
  }))

  const resolveCrossfaderValue = () =>
    clampNumber(Number(nativeTransport.state.output?.crossfaderValue) || 0, -1, 1)

  const faderThumbStyle = computed(() => ({
    top: `${resolveCrossfaderTravelPercentByValue(resolveCrossfaderValue())}%`
  }))

  const syncCrossfaderValue = (value: number) => {
    pendingWheelValue = null
    wheelRequestId += 1
    const safeValue = clampNumber(value, -1, 1)
    const masterVolume = clampVolumeValue(mainWindowVolume.value)
    void nativeTransport.setOutputState(safeValue, masterVolume)
  }

  const handleFaderWheel = (event: WheelEvent) => {
    if (event.deltaY === 0) return
    const value = clampNumber(
      (pendingWheelValue ?? resolveCrossfaderValue()) -
        Math.sign(event.deltaY) * CROSSFADER_WHEEL_STEP,
      -1,
      1
    )
    pendingWheelValue = value
    const requestId = ++wheelRequestId
    const clearPending = () => {
      if (wheelRequestId === requestId) pendingWheelValue = null
    }
    void nativeTransport
      .setOutputState(value, clampVolumeValue(mainWindowVolume.value))
      .then(clearPending, (error: unknown) => {
        clearPending()
        console.error('Failed to adjust crossfader with wheel:', error)
      })
  }

  const resolveCrossfaderValueByClientY = (clientY: number) => {
    const rect =
      faderRailRef.value?.getBoundingClientRect() || faderRef.value?.getBoundingClientRect()
    if (!rect || rect.height <= 0) return resolveCrossfaderValue()
    const travelInsetPx = rect.height * FADER_TRAVEL_INSET_RATIO
    const travelHeight = Math.max(1, rect.height - travelInsetPx * 2)
    const relativeY = clampNumber(clientY - rect.top - travelInsetPx, 0, travelHeight)
    return 1 - (relativeY / travelHeight) * 2
  }

  const stopFaderDragging = () => {
    if (!faderDragging.value) return
    faderDragging.value = false
    window.removeEventListener('pointermove', handleWindowFaderPointerMove)
    window.removeEventListener('pointerup', handleWindowFaderPointerUp)
    window.removeEventListener('pointercancel', handleWindowFaderPointerUp)
  }

  const handleWindowFaderPointerMove = (event: PointerEvent) => {
    if (!faderDragging.value) return
    syncCrossfaderValue(resolveCrossfaderValueByClientY(event.clientY))
  }

  const handleWindowFaderPointerUp = () => {
    stopFaderDragging()
  }

  const handleFaderPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    faderDragging.value = true
    syncCrossfaderValue(resolveCrossfaderValueByClientY(event.clientY))
    window.addEventListener('pointermove', handleWindowFaderPointerMove)
    window.addEventListener('pointerup', handleWindowFaderPointerUp)
    window.addEventListener('pointercancel', handleWindowFaderPointerUp)
  }

  const handleFaderDoubleClick = () => {
    stopFaderDragging()
    syncCrossfaderValue(0)
  }

  const nudgeCrossfaderByKeyboard = (direction: -1 | 1) => {
    syncCrossfaderValue(resolveCrossfaderValue() + direction * CROSSFADER_KEY_STEP)
  }

  const resetCrossfaderByKeyboard = () => {
    syncCrossfaderValue(0)
  }

  onUnmounted(() => {
    stopFaderDragging()
  })

  return {
    faderRef,
    faderRailRef,
    faderTicks,
    faderThumbStyle,
    faderDragging,
    syncCrossfaderValue,
    handleFaderPointerDown,
    handleFaderWheel,
    handleFaderDoubleClick,
    nudgeCrossfaderByKeyboard,
    resetCrossfaderByKeyboard
  }
}
