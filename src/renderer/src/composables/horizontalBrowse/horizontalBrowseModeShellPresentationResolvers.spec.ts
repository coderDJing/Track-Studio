import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { createEmptyHorizontalBrowseTransportSnapshot } from '@shared/horizontalBrowseTransport'
import { resolveHorizontalBrowseDeckWaveformPlaybackActive } from './horizontalBrowseModeShellPresentationResolvers'

describe('resolveHorizontalBrowseDeckWaveformPlaybackActive', () => {
  it('试听总闸冻结时停止独立的波形 Canvas 播放时钟', () => {
    const snapshot = createEmptyHorizontalBrowseTransportSnapshot().top
    snapshot.playing = true
    snapshot.playingAudible = false
    snapshot.playheadLoaded = true

    expect(
      resolveHorizontalBrowseDeckWaveformPlaybackActive({
        deck: 'top',
        snapshot,
        auditionSuspended: true,
        topRenderCurrentSeconds: ref(12),
        bottomRenderCurrentSeconds: ref(24),
        negativePlaybackEpsilonSec: 0.0001
      })
    ).toBe(false)
  })
})
