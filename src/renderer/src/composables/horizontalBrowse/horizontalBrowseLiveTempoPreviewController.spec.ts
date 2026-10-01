import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createHorizontalBrowseLiveTempoPreviewController } from './horizontalBrowseLiveTempoPreviewController'

const createHarness = (initialScale = 1, playing = true) => {
  const livePlaybackRate = ref<number | null>(null)
  const incomingScale = ref(initialScale)
  const appliedScale = ref(initialScale)
  const activeBuffer = ref<0 | 1>(0)
  const linkedPending = ref(false)
  const surfaces = [0, 1].map(() => [
    { style: { transform: '', transformOrigin: '', willChange: '' } },
    { style: { transform: '', transformOrigin: '', willChange: '' } }
  ])
  const applyIncomingTimeScale = vi.fn(() => {
    appliedScale.value = incomingScale.value
    return true
  })
  const reanchorPlayback = vi.fn()
  const controller = createHorizontalBrowseLiveTempoPreviewController({
    livePlaybackRate,
    initialTimeScale: initialScale,
    activeBufferIndex: () => activeBuffer.value,
    scalers: (buffer) => surfaces[buffer] as unknown as HTMLElement[],
    getLastAppliedTimeScale: () => appliedScale.value,
    resolveIncomingTimeScale: () => incomingScale.value,
    linkedGridVisualPending: () => linkedPending.value,
    stablePlaybackActive: () => playing,
    currentSeconds: () => 60,
    reanchorPlayback,
    applyIncomingTimeScale
  })
  const scaleX = (buffer = activeBuffer.value) =>
    Number(surfaces[buffer][0].style.transform.match(/scale3d\(([^,]+)/)?.[1] ?? 1)
  return {
    controller,
    livePlaybackRate,
    incomingScale,
    appliedScale,
    activeBuffer,
    linkedPending,
    surfaces,
    applyIncomingTimeScale,
    reanchorPlayback,
    scaleX
  }
}

describe('双轨调速的画布交接', () => {
  it('imperative 调速立即使用请求倍率，连续拖动不重画、不等待 native 快照', () => {
    const h = createHarness()
    for (const rate of [1.05, 1.2, 0.8, 1.3]) {
      h.controller.setPlaybackRate(rate)
      expect(h.scaleX()).toBeCloseTo(1 / rate, 9)
      expect(h.livePlaybackRate.value).toBe(rate)
      expect(h.surfaces[0][0].style.transform).toBe(h.surfaces[0][1].style.transform)
    }
    expect(h.incomingScale.value).toBe(1)
    expect(h.applyIncomingTimeScale).not.toHaveBeenCalled()
    expect(h.reanchorPlayback).toHaveBeenLastCalledWith(60, 1.3)
  })

  it.each([true, false])('松手前后任意标记的屏幕位置连续 (playing=%s)', (playing) => {
    const h = createHarness(0.8, playing)
    const finalScale = 1.2
    const position = (renderedScale: number, scaleX: number, seconds: number) =>
      480 + (seconds - 60) * (960 / (12 * renderedScale)) * scaleX
    h.controller.setPlaybackRate(finalScale)
    const before = [59, 60, 61].map((seconds) => position(0.8, h.scaleX(), seconds))
    h.incomingScale.value = finalScale
    h.controller.setPlaybackRate(null)
    expect(h.livePlaybackRate.value).toBeNull()
    expect(h.scaleX()).toBeCloseTo(0.8 / finalScale, 9)
    expect(h.applyIncomingTimeScale).toHaveBeenCalledExactlyOnceWith(true, {
      keepCurrentFrame: true,
      forceFrameWhenUnchanged: true
    })
    // worker 准备 back buffer 时缩放先写好，再交换可见 buffer。
    h.controller.prepareBuffer(1, finalScale)
    h.activeBuffer.value = 1
    h.controller.presented(finalScale)
    expect(h.scaleX()).toBe(1)
    const after = [59, 60, 61].map((seconds) => position(finalScale, h.scaleX(), seconds))
    after.forEach((x, index) => expect(x).toBeCloseTo(before[index], 9))
    expect(
      h.surfaces.flat().every((surface) => surface.style.transform === 'scale3d(1, 1, 1)')
    ).toBe(true)
    if (!playing) expect(h.reanchorPlayback).not.toHaveBeenCalled()
  })

  it('松手后收到旧密度或中间帧仍保持最终密度，只有最终帧才能撤掉缩放', () => {
    const h = createHarness()
    h.controller.setPlaybackRate(1.2)
    h.incomingScale.value = 1.2
    h.controller.setPlaybackRate(null)
    for (const [index, scale] of [1, 1.1, 1.2].entries()) {
      const buffer = (index % 2) as 0 | 1
      h.controller.prepareBuffer(buffer, scale)
      h.activeBuffer.value = buffer
      h.controller.presented(scale)
      expect(h.scaleX()).toBeCloseTo(scale / 1.2, 9)
      expect(h.scaleX() / scale).toBeCloseTo(1 / 1.2, 9)
    }
  })

  it('等待最终帧期间再次拖动，以新目标缩放，旧 release 不提前归位', () => {
    const h = createHarness()
    h.controller.setPlaybackRate(1.2)
    h.incomingScale.value = 1.2
    h.controller.setPlaybackRate(null)
    h.controller.setPlaybackRate(0.9)
    h.controller.prepareBuffer(1, 1.2)
    h.activeBuffer.value = 1
    h.controller.presented(1.2)
    expect(h.livePlaybackRate.value).toBe(0.9)
    expect(h.scaleX()).toBeCloseTo(1.2 / 0.9, 9)
    h.incomingScale.value = 0.9
    h.controller.setPlaybackRate(null)
    h.controller.prepareBuffer(0, 0.9)
    h.activeBuffer.value = 0
    h.controller.presented(0.9)
    expect(h.scaleX()).toBe(1)
  })

  it('取消调速返回 committed 倍率，旧帧已匹配时不强制重新换帧', () => {
    const h = createHarness()
    h.controller.setPlaybackRate(1.2)
    h.controller.setPlaybackRate(null)
    expect(h.scaleX()).toBe(1)
    expect(h.applyIncomingTimeScale).toHaveBeenCalledExactlyOnceWith(true, {
      keepCurrentFrame: true
    })
  })

  it('Sync 事务拥有换帧时撤销 live 预览，不另外提交单轨帧', () => {
    const h = createHarness()
    h.controller.setPlaybackRate(1.2)
    h.linkedPending.value = true
    h.controller.setPlaybackRate(null)
    expect(h.livePlaybackRate.value).toBeNull()
    expect(h.scaleX()).toBe(1)
    expect(h.applyIncomingTimeScale).not.toHaveBeenCalled()
  })
})
