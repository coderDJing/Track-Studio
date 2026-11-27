import { ref } from 'vue'
import {
  applyHorizontalBrowseCanvasPresentationOffset,
  setHorizontalBrowseLiveCanvasGeometry,
  setHorizontalBrowseWaveformTileContainerGeometry,
  setHorizontalBrowseWaveformTileGeometry
} from '@renderer/composables/horizontalBrowse/horizontalBrowseCanvasGeometry'
import {
  resolveHorizontalBrowseCanvasTranslateX,
  resolveHorizontalBrowseRenderedCanvasViewportStartSec
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRenderedCanvasViewport'
import { HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTileLayout'

const normalizeBufferIndex = (value: unknown, fallback: 0 | 1) => {
  const numeric = Math.floor(Number(value))
  return numeric === 0 || numeric === 1 ? numeric : fallback
}

export const createHorizontalBrowseLiveCanvasBuffers = () => {
  const waveformSurfaceRef = ref<HTMLDivElement | null>(null)
  const overlaySurfaceRef = ref<HTMLDivElement | null>(null)
  const waveformCanvasRef = ref<HTMLCanvasElement | null>(null)
  const waveformCanvasBackRef = ref<HTMLCanvasElement | null>(null)
  const gridCanvasRef = ref<HTMLCanvasElement | null>(null)
  const overlayCanvasRef = ref<HTMLCanvasElement | null>(null)
  const overlayCanvasBackRef = ref<HTMLCanvasElement | null>(null)
  // 分块路径：每 buffer 一个块容器 + 固定数量的块 canvas。
  // 块池必须按 buffer 分开（stable 路径渲染到非活动 buffer 再翻转，两个 buffer 的块内容不共享）。
  const waveformTileContainerRefs = [
    ref<HTMLDivElement | null>(null),
    ref<HTMLDivElement | null>(null)
  ]
  const waveformTileCanvasRefs = [
    ref<Array<HTMLCanvasElement | null>>([]),
    ref<Array<HTMLCanvasElement | null>>([])
  ]
  let activeIndex: 0 | 1 = 0
  let activeTiled = false
  let presentationTarget: { index: number; tiled: boolean } | null = null

  const resolveTileContainer = (index: number) =>
    waveformTileContainerRefs[normalizeBufferIndex(index, activeIndex)]?.value ?? null
  const resolveTileCanvases = (index: number) =>
    waveformTileCanvasRefs[normalizeBufferIndex(index, activeIndex)]?.value ?? []
  /** 波形侧的位移 / 几何目标：分块路径下是块容器，旧路径下是单张超宽 canvas。 */
  const resolveWaveformSurfaceTarget = (index: number, tiled: boolean): HTMLElement | null =>
    tiled ? resolveTileContainer(index) : resolveWaveformCanvas(index)

  const waveformCanvases = () => [waveformCanvasRef.value, waveformCanvasBackRef.value]
  const overlayCanvases = () => [overlayCanvasRef.value, overlayCanvasBackRef.value]
  const resolveWaveformCanvas = (index: number = activeIndex) =>
    waveformCanvases()[normalizeBufferIndex(index, activeIndex)] ?? null
  const resolveOverlayCanvas = (index: number = activeIndex) =>
    overlayCanvases()[normalizeBufferIndex(index, activeIndex)] ?? null
  const activeWaveformCanvas = () => resolveWaveformCanvas(activeIndex)
  const activeOverlayCanvas = () => resolveOverlayCanvas(activeIndex)
  // presentation 目标：分块路径返回块容器，旧路径返回单张 canvas。二者的 left / width /
  // transform 语义一致，故 presentation controller 无需区分。
  const presentationWaveformCanvas = () =>
    resolveWaveformSurfaceTarget(
      presentationTarget?.index ?? activeIndex,
      presentationTarget?.tiled ?? activeTiled
    )
  const presentationOverlayCanvas = () =>
    resolveOverlayCanvas(presentationTarget?.index ?? activeIndex)
  const inactiveIndex = () => (activeIndex === 0 ? 1 : 0)

  const syncVisibility = () => {
    // 同一个缓冲区的瓦片和整帧画布可能都留有像素，只显示当前提交的渲染面。
    waveformTileContainerRefs.forEach((containerRef, index) => {
      const container = containerRef.value
      if (!container) return
      container.style.opacity = index === activeIndex && activeTiled ? '1' : '0'
      container.style.zIndex = index === activeIndex ? '2' : '1'
    })
    waveformCanvases().forEach((canvas, index) => {
      if (!canvas) return
      canvas.style.opacity = index === activeIndex && !activeTiled ? '1' : '0'
      canvas.style.zIndex = index === activeIndex ? '2' : '1'
    })
    overlayCanvases().forEach((canvas, index) => {
      if (!canvas) return
      canvas.style.opacity = index === activeIndex ? '1' : '0'
      canvas.style.zIndex = index === activeIndex ? '2' : '1'
    })
  }

  const activate = (index: number, tiled: boolean) => {
    activeIndex = normalizeBufferIndex(index, activeIndex)
    activeTiled = tiled
    syncVisibility()
  }

  const setGeometry = (
    index: number,
    tiled: boolean,
    left: number,
    width: number,
    height: number,
    overlayHeight: number
  ) => {
    if (tiled) {
      setHorizontalBrowseWaveformTileContainerGeometry(
        resolveTileContainer(index),
        left,
        width,
        height
      )
    }
    setHorizontalBrowseLiveCanvasGeometry(
      tiled ? null : resolveWaveformCanvas(index),
      gridCanvasRef.value,
      resolveOverlayCanvas(index),
      left,
      width,
      height,
      overlayHeight
    )
  }

  /** 按渲染计划摆放块的容器内位置。块位图尺寸由 worker 侧设置，这里只管 CSS 布局。 */
  const applyTileLayout = (
    bufferIndex: number,
    tiles: Array<{ slotIndex: number; leftCssPx: number; widthCssPx: number }>,
    heightCssPx: number
  ) => {
    const tileCanvases = resolveTileCanvases(bufferIndex)
    const usedSlots = new Set<number>()
    for (const tile of tiles) {
      const canvas = tileCanvases[tile.slotIndex] ?? null
      if (!canvas) continue
      usedSlots.add(tile.slotIndex)
      setHorizontalBrowseWaveformTileGeometry(canvas, tile.leftCssPx, tile.widthCssPx, heightCssPx)
      canvas.style.visibility = 'visible'
    }
    // 本轮用不到的块藏起来：它们仍持有上一代内容，露出来就是错位画面。
    tileCanvases.forEach((canvas, slotIndex) => {
      if (!canvas || usedSlots.has(slotIndex)) return
      canvas.style.visibility = 'hidden'
    })
  }

  const applyPresentationOffset = (offsetCssPx: number, applyOverlayOffset: boolean) => {
    applyHorizontalBrowseCanvasPresentationOffset(
      presentationWaveformCanvas(),
      presentationOverlayCanvas(),
      offsetCssPx,
      applyOverlayOffset
    )
  }

  const withPresentationTarget = <T>(index: number, tiled: boolean, callback: () => T) => {
    presentationTarget = { index: normalizeBufferIndex(index, activeIndex), tiled }
    try {
      return callback()
    } finally {
      presentationTarget = null
    }
  }

  const resolveActiveTranslateX = () =>
    resolveHorizontalBrowseCanvasTranslateX(resolveWaveformSurfaceTarget(activeIndex, activeTiled))

  const resolveActiveViewportStartSec = (
    rangeStartSec: number | null,
    rangeDurationSec: number | null
  ) =>
    resolveHorizontalBrowseRenderedCanvasViewportStartSec({
      canvas: resolveWaveformSurfaceTarget(activeIndex, activeTiled),
      rangeStartSec,
      rangeDurationSec
    })

  /** 供 worker attach 用：两个 buffer 的块 canvas 展平成 [buffer0 全部块, buffer1 全部块]。 */
  const tileCanvases = () => [resolveTileCanvases(0), resolveTileCanvases(1)]

  return {
    waveformSurfaceRef,
    waveformCanvasRef,
    waveformCanvasBackRef,
    gridCanvasRef,
    overlaySurfaceRef,
    overlayCanvasRef,
    overlayCanvasBackRef,
    waveformTileContainerRefs,
    waveformTileCanvasRefs,
    tileSlotCount: HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT,
    tileCanvases,
    applyTileLayout,
    activeIndex: () => activeIndex,
    isActiveTiled: () => activeTiled,
    inactiveIndex,
    activate,
    syncVisibility,
    setGeometry,
    waveformCanvases,
    overlayCanvases,
    activeWaveformCanvas,
    activeOverlayCanvas,
    presentationWaveformCanvas,
    presentationOverlayCanvas,
    applyPresentationOffset,
    withPresentationTarget,
    resolveActiveTranslateX,
    resolveActiveViewportStartSec
  }
}
