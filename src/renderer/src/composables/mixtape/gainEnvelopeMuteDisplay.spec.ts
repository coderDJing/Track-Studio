import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createGainEnvelopeTrackStateModule } from './gainEnvelopeTrackState'
import { createMixtapeGainEnvelopeEditor } from './useGainEnvelopeEditor'
import { resolveVolumeMuteSegmentMasks, toggleVolumeMuteIntervals } from './gainEnvelopeEditorGrid'
import type { MixtapeEnvelopeParamId, MixtapeTrack } from './types'

describe('volume mute ranges', () => {
  it('keeps volume masks visible when the selected parameter changes', () => {
    const track: MixtapeTrack = {
      id: 'track',
      mixOrder: 1,
      title: '',
      artist: '',
      duration: '01:40',
      filePath: '',
      originPath: '',
      volumeMuteSegments: [{ startSec: 10, endSec: 20 }]
    }
    let activeParam: MixtapeEnvelopeParamId | null = null
    let segmentSelection = false
    const editor = createMixtapeGainEnvelopeEditor({
      tracks: ref([track]),
      renderZoomLevel: ref(3),
      resolveTrackDurationSeconds: () => 100,
      resolveTrackSourceDurationSeconds: () => 100,
      resolveTrackFirstBeatSeconds: () => 0,
      resolveActiveParam: () => activeParam,
      isSegmentSelectionMode: () => segmentSelection,
      isEditable: () => true
    })
    const item = { track, laneIndex: 0, startSec: 0, startX: 0, width: 100 }
    for (const param of [null, 'gain', 'high', 'vocal', 'volume'] as const) {
      activeParam = param
      for (segmentSelection of [false, true]) {
        expect(editor.resolveVolumeSegmentMasks(item)).toEqual([
          { key: '10.0000:20.0000', left: 10, width: 10 }
        ])
      }
    }
  })

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
