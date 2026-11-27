import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  queueHorizontalBrowseLinkedCanvasActivation,
  resetHorizontalBrowseLinkedCanvasActivationBarrier
} from './horizontalBrowseLinkedCanvasActivationBarrier'

let nextRafId = 1
let rafCallbacks = new Map<number, FrameRequestCallback>()

const flushAnimationFrame = () => {
  const callbacks = [...rafCallbacks.values()]
  rafCallbacks.clear()
  callbacks.forEach((callback) => callback(performance.now()))
}

const queueActivation = (
  direction: 'up' | 'down',
  commit: () => void,
  playbackFrame = false,
  isCurrent = () => true
) => queueHorizontalBrowseLinkedCanvasActivation(direction, { commit, playbackFrame, isCurrent })

beforeEach(() => {
  vi.useFakeTimers()
  nextRafId = 1
  rafCallbacks = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextRafId++
    rafCallbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id)
  })
})

afterEach(() => {
  resetHorizontalBrowseLinkedCanvasActivationBarrier()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('queueHorizontalBrowseLinkedCanvasActivation', () => {
  it('两轨都就绪后在同一任务内提交，并吸收绘制前的同轨校正帧', () => {
    const committed: string[] = []
    queueActivation('down', () => committed.push('down-old'))
    queueActivation('up', () => committed.push('up'))

    flushAnimationFrame()
    queueActivation('down', () => committed.push('down-latest'))
    expect(committed).toEqual([])

    flushAnimationFrame()

    expect(committed).toEqual(['up', 'down-latest'])
  })

  it('只有一轨可用时通过超时提交，避免永久等待', () => {
    const commit = vi.fn()
    queueActivation('down', commit)

    vi.advanceTimersByTime(119)
    expect(commit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('两轨的起播帧均已就绪后在下一帧同时提交', () => {
    const paused = vi.fn()
    const up = vi.fn()
    const down = vi.fn()
    queueActivation('down', paused)
    queueActivation('up', up, true)
    flushAnimationFrame()
    expect(up).not.toHaveBeenCalled()

    queueActivation('down', down, true)
    flushAnimationFrame()
    expect(up).toHaveBeenCalledOnce()
    expect(down).toHaveBeenCalledOnce()
    expect(paused).not.toHaveBeenCalled()
  })

  it('一轨正在等校正帧时保留另一轨的候选帧，直到两轨都可提交', () => {
    const previousUp = vi.fn()
    const correctedUp = vi.fn()
    const down = vi.fn()
    let previousUpIsCurrent = true
    queueActivation('up', previousUp, true, () => previousUpIsCurrent)
    queueActivation('down', down, true)

    previousUpIsCurrent = false
    flushAnimationFrame()
    expect(down).not.toHaveBeenCalled()

    queueActivation('up', correctedUp, true)
    flushAnimationFrame()
    expect(previousUp).not.toHaveBeenCalled()
    expect(correctedUp).toHaveBeenCalledOnce()
    expect(down).toHaveBeenCalledOnce()
  })
})
