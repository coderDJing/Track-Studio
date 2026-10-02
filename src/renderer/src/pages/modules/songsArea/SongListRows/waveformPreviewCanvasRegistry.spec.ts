import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWaveformPreviewCanvasRegistry } from './waveformPreviewCanvasRegistry'

const canvas = () =>
  ({ transferControlToOffscreen: vi.fn(() => ({})) }) as unknown as HTMLCanvasElement
const mountRegistry = (canUseAsyncWaveformWorker = true) => {
  const worker = { postMessage: vi.fn() }
  const registry = createWaveformPreviewCanvasRegistry({
    canUseAsyncWaveformWorker,
    ensureWaveformWorker: () => worker as unknown as Worker
  })
  return { registry, worker }
}

afterEach(() => vi.useRealTimers())

describe('waveform preview canvas binding identity', () => {
  it('initializes a binding once and preserves the same canvas for repeated refs', () => {
    const { registry, worker } = mountRegistry()
    const element = canvas()
    expect(registry.setCanvasRef('row', 'first.mp3', element)).toEqual({
      attachedToWorker: true,
      bindingChanged: true
    })
    expect(registry.setCanvasRef('row', 'first.mp3', element)).toEqual({
      attachedToWorker: false,
      bindingChanged: false
    })
    expect(element.transferControlToOffscreen).toHaveBeenCalledTimes(1)
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
  })

  it('reports a path change on the same transferred canvas and updates path lookup immediately', () => {
    const { registry, worker } = mountRegistry()
    const element = canvas()
    registry.setCanvasRef('row', 'first.mp3', element)
    expect(registry.setCanvasRef('row', 'second.mp3', element)).toEqual({
      attachedToWorker: false,
      bindingChanged: true
    })
    expect(registry.hasCanvasForFilePath('first.mp3')).toBe(false)
    expect(registry.getCanvasEntriesForFilePath('second.mp3')).toEqual([['row', element]])
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])(
    'preserves synchronous null / same element rebind (worker=%s)',
    (async) => {
      vi.useFakeTimers()
      const { registry, worker } = mountRegistry(async)
      const element = canvas()
      registry.setCanvasRef('row', 'first.mp3', element)
      registry.setCanvasRef('row', 'first.mp3', null)
      expect(registry.hasCanvasForFilePath('first.mp3')).toBe(false)
      expect(registry.setCanvasRef('row', 'first.mp3', element).bindingChanged).toBe(false)
      vi.runOnlyPendingTimers()
      expect(registry.hasCanvasForFilePath('first.mp3')).toBe(true)
      expect(worker.postMessage).toHaveBeenCalledTimes(async ? 1 : 0)
      registry.clear()
    }
  )

  it('detaches a removed canvas and initializes its replacement', () => {
    vi.useFakeTimers()
    const { registry, worker } = mountRegistry()
    registry.setCanvasRef('row', 'first.mp3', canvas())
    registry.setCanvasRef('row', 'first.mp3', null)
    vi.runOnlyPendingTimers()
    expect(worker.postMessage.mock.calls[1][0]).toEqual({
      type: 'detachCanvas',
      payload: { canvasId: 'row' }
    })
    expect(registry.setCanvasRef('row', 'first.mp3', canvas())).toEqual({
      attachedToWorker: true,
      bindingChanged: true
    })
    registry.clear()
  })

  it('recognizes a new path during synchronous null / same canvas rebind', () => {
    vi.useFakeTimers()
    const { registry, worker } = mountRegistry()
    const element = canvas()
    registry.setCanvasRef('row', 'first.mp3', element)
    registry.setCanvasRef('row', 'first.mp3', null)
    expect(registry.setCanvasRef('row', 'second.mp3', element)).toEqual({
      attachedToWorker: false,
      bindingChanged: true
    })
    vi.runOnlyPendingTimers()
    expect(registry.hasCanvasForFilePath('first.mp3')).toBe(false)
    expect(registry.hasCanvasForFilePath('second.mp3')).toBe(true)
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    registry.clear()
  })
})
