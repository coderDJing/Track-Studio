import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useMixtapeBeatAlignGridAdjust } from './mixtapeBeatAlignGridAdjust'

describe('linked grid shifting preserves screen phase', () => {
  for (const playing of [false, true]) {
    for (const dynamic of [false, true]) {
      it(`compensates waveform movement (playing=${playing}, dynamic=${dynamic})`, () => {
        const compensate = vi.fn()
        const shift = vi.fn(() => true)
        const first = ref(100)
        const controller = useMixtapeBeatAlignGridAdjust({
          previewWrapRef: ref(null),
          previewLoading: ref(false),
          previewMixxxData: ref(null),
          canAdjustGrid: ref(true),
          previewPlaying: ref(playing),
          previewDownbeatBeatOffset: ref(0),
          previewFirstBeatMs: first,
          previewStartSec: ref(5),
          bpm: ref(120),
          firstBeatMs: first,
          resolvePreviewAnchorSec: () => 5,
          resolvePreviewDurationSec: () => 180,
          resolveVisibleDurationSec: () => 8,
          clampPreviewStart: (value) => value,
          getPreviewPlaybackSec: () => 5,
          schedulePreviewDraw: vi.fn(),
          applyPlaybackPhaseCompensation: compensate,
          downbeatBeatInterval: 4,
          dynamicGridEdit: {
            isDynamic: ref(dynamic),
            hasV2GridMap: ref(dynamic),
            gridControlsDisabled: ref(false),
            selectTargetByPointer: () => false,
            setActiveGridDownbeatLineAtSec: () => true,
            shiftActiveGrid: shift
          }
        })
        controller.handleGridShift(3, { preservePlaybackPhase: true })
        expect(compensate).toHaveBeenCalledExactlyOnceWith(3)
        expect(dynamic ? shift.mock.calls : first.value).toEqual(dynamic ? [[3]] : 103)
        compensate.mockClear()
        controller.handleGridShift(-1)
        expect(compensate).not.toHaveBeenCalled()
        shift.mockReturnValue(false)
        compensate.mockClear()
        if (dynamic) {
          controller.handleGridShift(3, { preservePlaybackPhase: true })
          expect(compensate).not.toHaveBeenCalled()
        }
      })
    }
  }
})
