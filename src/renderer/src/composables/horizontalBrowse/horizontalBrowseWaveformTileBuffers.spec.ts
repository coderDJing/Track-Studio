import { describe, expect, it } from 'vitest'
import { createHorizontalBrowseLiveCanvasBuffers } from './horizontalBrowseLiveCanvasBuffers'

const createStubElement = <T>() => {
  const style: Record<string, string> = {
    setProperty(name: string, value: string) {
      style[name.replace(/-([a-z])/g, (_unused, letter: string) => letter.toUpperCase())] = value
    },
    removeProperty(name: string) {
      delete style[name.replace(/-([a-z])/g, (_unused, letter: string) => letter.toUpperCase())]
    }
  } as unknown as Record<string, string>
  return {
    style,
    getBoundingClientRect: () => ({ width: 0 }),
    tagName: 'STUB'
  } as unknown as T & { style: Record<string, string> }
}

const attachBuffers = () => {
  const buffers = createHorizontalBrowseLiveCanvasBuffers()
  const waveformFront = createStubElement<HTMLCanvasElement>()
  const waveformBack = createStubElement<HTMLCanvasElement>()
  const overlayFront = createStubElement<HTMLCanvasElement>()
  const overlayBack = createStubElement<HTMLCanvasElement>()
  const tileContainerFront = createStubElement<HTMLDivElement>()
  const tileContainerBack = createStubElement<HTMLDivElement>()
  const tileFront = createStubElement<HTMLCanvasElement>()
  const tileBack = createStubElement<HTMLCanvasElement>()
  buffers.waveformCanvasRef.value = waveformFront
  buffers.waveformCanvasBackRef.value = waveformBack
  buffers.overlayCanvasRef.value = overlayFront
  buffers.overlayCanvasBackRef.value = overlayBack
  buffers.waveformTileContainerRefs[0].value = tileContainerFront
  buffers.waveformTileContainerRefs[1].value = tileContainerBack
  buffers.waveformTileCanvasRefs[0].value = [tileFront]
  buffers.waveformTileCanvasRefs[1].value = [tileBack]
  return {
    buffers,
    waveformFront,
    waveformBack,
    overlayFront,
    overlayBack,
    tileContainerFront,
    tileContainerBack,
    tileFront
  }
}

describe('horizontalBrowseLiveCanvasBuffers', () => {
  it('整帧渲染将几何写入目标画布', () => {
    const { buffers, waveformFront, tileContainerFront, tileContainerBack } = attachBuffers()
    buffers.setGeometry(0, false, -2896, 6756, 96, 120)
    expect(waveformFront.style.width).toBe('6756px')
    expect(waveformFront.style.left).toBe('-2896px')
    // 块容器完全没有被写入任何几何。
    expect(tileContainerFront.style.width).toBeUndefined()
    expect(tileContainerFront.style.left).toBeUndefined()
    expect(tileContainerBack.style.width).toBeUndefined()
  })

  it('整帧渲染将位移应用到整帧画布', () => {
    const { buffers, waveformFront, tileContainerFront } = attachBuffers()
    buffers.applyPresentationOffset(-123.5, true)
    expect(waveformFront.style.transform).toBe('translate3d(-123.5px, 0, 0)')
    expect(tileContainerFront.style.transform).toBeUndefined()
  })

  it('瓦片渲染将几何写入块容器及网格', () => {
    const { buffers, waveformFront, overlayFront, tileContainerFront } = attachBuffers()
    buffers.setGeometry(0, true, -2896, 6756, 96, 120)
    expect(tileContainerFront.style.width).toBe('6756px')
    expect(tileContainerFront.style.left).toBe('-2896px')
    expect(tileContainerFront.style.height).toBe('96px')
    // 波形侧改由块容器承载，旧 canvas 不再参与布局；overlay 不分块，仍照旧摆放。
    expect(waveformFront.style.width).toBeUndefined()
    expect(overlayFront.style.width).toBe('6756px')
  })

  it('通过块容器统一移动瓦片，保持块边界对齐', () => {
    const { buffers, tileContainerFront, tileFront } = attachBuffers()
    buffers.activate(0, true)
    buffers.applyPresentationOffset(-123.5, true)
    expect(tileContainerFront.style.transform).toBe('translate3d(-123.5px, 0, 0)')
    expect(tileFront.style.transform).toBeUndefined()
  })

  it('applyTileLayout 摆放用到的块并隐藏本轮不用的块', () => {
    const buffers = createHorizontalBrowseLiveCanvasBuffers()
    const usedTile = createStubElement<HTMLCanvasElement>()
    const unusedTile = createStubElement<HTMLCanvasElement>()
    buffers.waveformTileCanvasRefs[0].value = [usedTile, unusedTile]
    buffers.applyTileLayout(0, [{ slotIndex: 0, leftCssPx: 512, widthCssPx: 1478 }], 96)
    expect(usedTile.style.left).toBe('512px')
    expect(usedTile.style.width).toBe('1478px')
    expect(usedTile.style.height).toBe('96px')
    expect(usedTile.style.visibility).toBe('visible')
    // 未参与本轮的块仍持有上一代内容，必须隐藏，否则会露出错位画面。
    expect(unusedTile.style.visibility).toBe('hidden')
  })

  it('瓦片和整帧交接时仅显示已提交的波形和对应网格', () => {
    const {
      buffers,
      waveformFront,
      waveformBack,
      tileContainerFront,
      tileContainerBack,
      overlayFront,
      overlayBack
    } = attachBuffers()
    const opacity = () =>
      [
        waveformFront,
        waveformBack,
        tileContainerFront,
        tileContainerBack,
        overlayFront,
        overlayBack
      ].map((element) => element.style.opacity)

    buffers.setGeometry(1, true, -2896, 6756, 96, 120)
    buffers.activate(1, true)
    expect(opacity()).toEqual(['0', '0', '0', '1', '0', '1'])

    buffers.setGeometry(0, false, 0, 964, 96, 120)
    buffers.withPresentationTarget(0, false, () => buffers.applyPresentationOffset(-0.25, true))
    expect(opacity()).toEqual(['0', '0', '0', '1', '0', '1'])
    expect(tileContainerBack.style.left).toBe('-2896px')
    expect(overlayBack.style.left).toBe('-2896px')
    expect(waveformFront.style.transform).toBe('translate3d(-0.25px, 0, 0)')

    buffers.activate(0, false)
    expect(opacity()).toEqual(['1', '0', '0', '0', '1', '0'])
    expect(buffers.resolveActiveTranslateX()).toBe(-0.25)

    buffers.activate(1, true)
    expect(opacity()).toEqual(['0', '0', '0', '1', '0', '1'])
  })
})
