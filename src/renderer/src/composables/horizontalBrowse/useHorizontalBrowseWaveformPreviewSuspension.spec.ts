import { effectScope, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import emitter from '@renderer/utils/mitt'
import {
  WAVEFORM_PREVIEW_TRANSPORT_RESUME_EVENT,
  WAVEFORM_PREVIEW_TRANSPORT_SUSPEND_EVENT,
  type WaveformPreviewTransportGatePayload
} from '@renderer/utils/exclusivePlayback'
import { useHorizontalBrowseWaveformPreviewSuspension } from './useHorizontalBrowseWaveformPreviewSuspension'

const emitGate = async (event: string, sessionId: string) => {
  const operations: Promise<unknown>[] = []
  emitter.emit(event, {
    sessionId,
    waitUntil: (operation) => operations.push(operation)
  } satisfies WaveformPreviewTransportGatePayload)
  await Promise.all(operations)
}

describe('useHorizontalBrowseWaveformPreviewSuspension', () => {
  it('同一原生总闸负责暂停和恢复，不逐轨改 playing', async () => {
    const state = reactive({ auditionSuspended: false })
    const setAuditionSuspended = vi.fn(async (suspended: boolean) => {
      state.auditionSuspended = suspended
    })
    const syncDeckRenderState = vi.fn()
    const setAuditionPresentationSuspended = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      useHorizontalBrowseWaveformPreviewSuspension({
        nativeTransport: { state, setAuditionSuspended },
        syncDeckRenderState,
        setAuditionPresentationSuspended
      })
    })

    await emitGate(WAVEFORM_PREVIEW_TRANSPORT_SUSPEND_EVENT, 'session-a')
    expect(setAuditionSuspended).toHaveBeenCalledTimes(1)
    expect(setAuditionSuspended).toHaveBeenLastCalledWith(true)
    expect(state.auditionSuspended).toBe(true)
    expect(setAuditionPresentationSuspended).toHaveBeenLastCalledWith(true)

    await emitGate(WAVEFORM_PREVIEW_TRANSPORT_RESUME_EVENT, 'session-a')
    expect(setAuditionSuspended).toHaveBeenCalledTimes(2)
    expect(setAuditionSuspended).toHaveBeenLastCalledWith(false)
    expect(state.auditionSuspended).toBe(false)
    expect(setAuditionPresentationSuspended).toHaveBeenLastCalledWith(false)
    expect(syncDeckRenderState).toHaveBeenCalledWith({
      force: 'all',
      preserveRevision: true
    })
    scope.stop()
  })

  it('旧试听会话结束不能解除新试听持有的总闸', async () => {
    const state = reactive({ auditionSuspended: false })
    const setAuditionSuspended = vi.fn(async (suspended: boolean) => {
      state.auditionSuspended = suspended
    })
    const setAuditionPresentationSuspended = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      useHorizontalBrowseWaveformPreviewSuspension({
        nativeTransport: { state, setAuditionSuspended },
        syncDeckRenderState: vi.fn(),
        setAuditionPresentationSuspended
      })
    })

    await emitGate(WAVEFORM_PREVIEW_TRANSPORT_SUSPEND_EVENT, 'session-a')
    await emitGate(WAVEFORM_PREVIEW_TRANSPORT_SUSPEND_EVENT, 'session-b')
    await emitGate(WAVEFORM_PREVIEW_TRANSPORT_RESUME_EVENT, 'session-a')

    expect(state.auditionSuspended).toBe(true)
    expect(setAuditionSuspended).toHaveBeenCalledTimes(1)
    expect(setAuditionPresentationSuspended).toHaveBeenCalledTimes(2)
    expect(setAuditionPresentationSuspended).toHaveBeenLastCalledWith(true)

    await emitGate(WAVEFORM_PREVIEW_TRANSPORT_RESUME_EVENT, 'session-b')
    expect(state.auditionSuspended).toBe(false)
    expect(setAuditionSuspended).toHaveBeenCalledTimes(2)
    expect(setAuditionPresentationSuspended).toHaveBeenLastCalledWith(false)
    scope.stop()
  })
})
