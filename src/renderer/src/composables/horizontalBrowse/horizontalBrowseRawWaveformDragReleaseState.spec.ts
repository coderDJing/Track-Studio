import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createHorizontalBrowseRawWaveformDragReleaseState } from './horizontalBrowseRawWaveformDragReleaseState'

const createRelease = (playing = false) => {
  const currentSeconds = ref(30)
  const drawWaveformNow = vi.fn()
  const release = createHorizontalBrowseRawWaveformDragReleaseState({
    playing: ref(playing),
    dragging: ref(false),
    currentSeconds: () => currentSeconds.value,
    resolvePlaybackAlignedStart: (seconds) => seconds - 6,
    resolveVisibleDurationSec: () => 12,
    resolveStableWaveformSource: () => false,
    drawWaveformNow
  })
  release.startPending(24)
  return { release, currentSeconds, drawWaveformNow }
}

describe('大波形松手后的帧交接', () => {
  it('接受按松手后的播放时钟绘制的帧，即使回报晚了几帧', () => {
    const { release, currentSeconds } = createRelease(true)
    currentSeconds.value += 0.035
    const frame = { rangeStartSec: 24, rangeDurationSec: 12 }

    expect(release.canComplete(frame, false)).toBe(false)
    expect(release.canComplete(frame, true)).toBe(true)
  })

  it('暂停时仍要求帧对齐松手位置', () => {
    const { release } = createRelease()
    const earlierFrame = { rangeStartSec: 23, rangeDurationSec: 12 }

    expect(release.canComplete(earlierFrame, true)).toBe(false)
    expect(release.canComplete({ ...earlierFrame, rangeStartSec: 24 }, false)).toBe(true)
  })

  it('暂停时松手位置与已提交位置一致也请求最终帧', () => {
    const { release, drawWaveformNow } = createRelease()
    release.startPending(21)

    release.syncViewportStart(30)
    expect(drawWaveformNow).not.toHaveBeenCalled()

    release.syncViewportStart(27)
    release.syncViewportStart(27)
    expect(drawWaveformNow).toHaveBeenCalledExactlyOnceWith({ preferPreviewStart: true })
  })
})
