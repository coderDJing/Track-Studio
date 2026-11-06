import { describe, expect, it } from 'vitest'
import { createGainEnvelopeTrackStateModule } from './gainEnvelopeTrackState'
import { resolveVolumeMuteSegmentMasks, toggleVolumeMuteIntervals } from './gainEnvelopeEditorGrid'
import type { MixtapeTrack } from './types'

describe('volume mute ranges', () => {
  it('displays the saved range even when no grid lines are visible', () => {
    const track: MixtapeTrack = {
      id: 'eight',
      mixOrder: 8,
      title: '',
      artist: '',
      duration: '02:57',
      filePath: '',
      originPath: '',
      bpm: 126,
      originalBpm: 126,
      volumeMuteSegments: [{ startSec: 0, endSec: 18.5642 }]
    }
    let zoom = 0
    const state = createGainEnvelopeTrackStateModule({
      tracks: { value: [track] },
      resolveRenderZoom: () => zoom,
      resolveTrackDurationSeconds: () => 177,
      resolveTrackSourceDurationSeconds: () => 177,
      isStemSegmentParam: () => false
    })
    expect(state.resolveDynamicVisibleGridLines(track, 177)).toEqual([])
    for (zoom of [0, 3, 99]) {
      const { durationSec, segments } = state.resolveTrackVolumeMuteState(track.id)
      expect(segments).toEqual(track.volumeMuteSegments)
      expect(resolveVolumeMuteSegmentMasks(durationSec, segments)[0].width).toBe(10.4882)
    }
  })

  it('toggles the selected interval without expanding existing mute boundaries', () => {
    const base = [{ startSec: 0, endSec: 18.5642 }]
    expect(
      toggleVolumeMuteIntervals(base, new Map([['selected', { startSec: 10, endSec: 20 }]]))
    ).toEqual([
      { startSec: 0, endSec: 10 },
      { startSec: 18.5642, endSec: 20 }
    ])
    expect(
      toggleVolumeMuteIntervals(base, new Map([['selected', { startSec: 0, endSec: 177 }]]))
    ).toEqual([{ startSec: 18.5642, endSec: 177 }])
    expect(
      toggleVolumeMuteIntervals(base, new Map([['selected', { startSec: 20, endSec: 22 }]]))
    ).toEqual([
      { startSec: 0, endSec: 18.5642 },
      { startSec: 20, endSec: 22 }
    ])
  })
})
