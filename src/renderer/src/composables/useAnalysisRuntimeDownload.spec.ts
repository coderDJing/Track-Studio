// Run: pnpm exec vitest run src/renderer/src/composables/useAnalysisRuntimeDownload.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAnalysisRuntimeDownload } from './useAnalysisRuntimeDownload'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type confirmDialog from '@renderer/components/confirmDialog'

const runtime = () => ({
  analysisRuntime: { available: true, state: { status: 'ready' }, preferred: {} },
  setting: {},
  mainWindowBrowseMode: 'browser',
  setAnalysisRuntimeDownloadOverlayMinimized: vi.fn()
})
const preferred = {
  supported: true,
  downloadable: true,
  alreadyAvailable: false,
  profile: 'cuda',
  title: 'CUDA',
  archiveSize: 100
}
const state = { status: 'idle' }

afterEach(() => vi.unstubAllGlobals())

describe('BPM repair runtime gate', () => {
  it('checks BPM support and offers an update even when the old runtime is ready', async () => {
    const invoke = vi.fn(async (channel: string) =>
      channel.endsWith('get-status')
        ? { preferred, state }
        : { started: true, state: { status: 'ready' } }
    )
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    const current = runtime()
    const confirm = vi.fn(async (_options: Parameters<typeof confirmDialog>[0]) => 'confirm')
    const gate = useAnalysisRuntimeDownload({
      runtime: current as unknown as ReturnType<typeof useRuntimeStore>,
      t: (key) => key,
      confirmDialog: confirm as unknown as typeof confirmDialog,
      appVersion: '1.0.0'
    })
    expect(await gate.ensureAnalysisRuntimeForHorizontalMode()).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
    expect(await gate.ensureAnalysisRuntimeForBpmFix()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('analysis-runtime:get-status', true)
    expect(invoke).toHaveBeenCalledWith('analysis-runtime:download-preferred', true)
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('does not replace a usable old component when the published package is outdated', async () => {
    const invoke = vi.fn(async () => ({
      preferred: { ...preferred, downloadable: false, reason: 'bpm fix asset unavailable' },
      state
    }))
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    const current = runtime()
    const confirm = vi.fn(async (_options: Parameters<typeof confirmDialog>[0]) => 'confirm')
    const gate = useAnalysisRuntimeDownload({
      runtime: current as unknown as ReturnType<typeof useRuntimeStore>,
      t: (key) => key,
      confirmDialog: confirm as unknown as typeof confirmDialog,
      appVersion: '1.0.0'
    })
    expect(await gate.ensureAnalysisRuntimeForBpmFix()).toBe(false)
    expect(current.analysisRuntime.available).toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0].content).toEqual(['bpmFix.componentUpdateUnavailable'])
  })
})
