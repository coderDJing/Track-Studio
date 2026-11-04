import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createMixtapeAutoGainController } from './autoGainController'
import { buildAutoGainEnvelopes } from './autoGain'
import type { MixtapeTrack } from './types'

vi.mock('./autoGain', () => ({
  buildAutoGainEnvelopes: vi.fn(),
  pickLoudestReferenceTrackId: vi.fn(),
  pickQuietestReferenceTrackId: vi.fn()
}))

describe('auto gain application', () => {
  it('keeps playback running and stays busy until the new envelopes are saved', async () => {
    const tracks = ref<MixtapeTrack[]>(
      ['a', 'b'].map((id, index) => ({
        id,
        title: id,
        artist: '',
        filePath: `${id}.mp3`,
        originPath: '',
        mixOrder: index + 1,
        startSec: index * 60,
        duration: '01:00',
        bpm: 120
      }))
    )
    const points = [
      { sec: 0, gain: 0.8 },
      { sec: 60, gain: 0.8 }
    ]
    vi.mocked(buildAutoGainEnvelopes).mockResolvedValue(
      tracks.value.map((track) => ({ trackId: track.id, filePath: track.filePath, points }))
    )
    let finishSave!: () => void
    const saved = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    const stop = vi.fn()
    const params = {
      tracks,
      selectedTrackId: ref('a'),
      bpmAnalysisActive: ref(false),
      transportPlaying: ref(true),
      transportDecoding: ref(false),
      onStopTransport: stop,
      resolveTrackTitle: (track: MixtapeTrack) => track.title,
      t: (key: string) => key,
      onEnvelopeApplied: vi.fn(),
      persistGainEnvelope: vi.fn(() => saved),
      showErrorDialog: vi.fn(async () => {})
    }
    const controller = createMixtapeAutoGainController(params)
    controller.openAutoGainDialog()
    const applying = controller.handleAutoGainDialogConfirm()
    await vi.waitFor(() => expect(params.persistGainEnvelope).toHaveBeenCalledOnce())
    expect(tracks.value[1].gainEnvelope).toEqual(points)
    expect(stop).not.toHaveBeenCalled()
    expect(controller.autoGainBusy.value).toBe(true)
    expect(controller.autoGainDialogVisible.value).toBe(true)
    expect(controller.autoGainProgressText.value).toBe('mixtape.autoGainSaving')
    await controller.handleAutoGainDialogConfirm()
    expect(buildAutoGainEnvelopes).toHaveBeenCalledOnce()
    finishSave()
    await applying
    expect(controller.autoGainBusy.value).toBe(false)
    expect(controller.autoGainDialogVisible.value).toBe(false)
  })
})
