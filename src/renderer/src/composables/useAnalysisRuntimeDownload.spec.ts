// Run: pnpm exec vitest run src/renderer/src/composables/useAnalysisRuntimeDownload.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetAnalysisRuntimePromptStateForTests,
  useAnalysisRuntimeDownload
} from './useAnalysisRuntimeDownload'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type confirmDialog from '@renderer/components/confirmDialog'

const runtime = () => ({
  analysisRuntime: { available: true, state: { status: 'ready' }, preferred: {} },
  setting: {},
  mainWindowBrowseMode: 'browser'
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

beforeEach(() => {
  // 提示节流与并发标记是模块级的，用例之间要清干净，否则前一个用例会吞掉后一个的提示框。
  resetAnalysisRuntimePromptStateForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('BPM repair runtime gate', () => {
  it('checks BPM support and offers an update even when the old runtime is ready', async () => {
    const invoke = vi.fn(async (channel: string, feature: string) =>
      channel.endsWith('get-status')
        ? {
            preferred:
              feature === 'horizontal' ? { ...preferred, alreadyAvailable: true } : preferred,
            state
          }
        : { started: true, state: { status: 'ready' } }
    )
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    const current = runtime()
    const confirm = vi.fn(async (_options: Parameters<typeof confirmDialog>[0]) => 'confirm')
    const gate = useAnalysisRuntimeDownload({
      runtime: current as unknown as ReturnType<typeof useRuntimeStore>,
      t: (key) => key,
      confirmDialog: confirm as unknown as typeof confirmDialog
    })
    expect(await gate.ensureAnalysisRuntimeForHorizontalMode()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('analysis-runtime:get-status', 'horizontal')
    expect(await gate.ensureAnalysisRuntimeForBpmFix()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('analysis-runtime:get-status', 'bpm-fix')
    expect(invoke).toHaveBeenCalledWith('analysis-runtime:download-preferred', 'bpm-fix')
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('keeps other features available when a BPM component update fails', async () => {
    const invoke = vi.fn(async (channel: string, feature: string) =>
      channel.endsWith('get-status')
        ? {
            preferred:
              feature === 'horizontal' ? { ...preferred, alreadyAvailable: true } : preferred,
            state
          }
        : { started: false, state: { status: 'failed' } }
    )
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    const current = runtime()
    current.analysisRuntime.preferred = { alreadyAvailable: true }
    current.mainWindowBrowseMode = 'horizontal'
    const confirm = vi.fn(async (_options: Parameters<typeof confirmDialog>[0]) => 'confirm')
    const gate = useAnalysisRuntimeDownload({
      runtime: current as unknown as ReturnType<typeof useRuntimeStore>,
      t: (key) => key,
      confirmDialog: confirm as unknown as typeof confirmDialog
    })
    expect(await gate.ensureAnalysisRuntimeForBpmFix()).toBe(false)
    expect(current.analysisRuntime.available).toBe(true)
    expect(current.mainWindowBrowseMode).toBe('horizontal')
    expect(await gate.ensureAnalysisRuntimeForHorizontalMode()).toBe(true)
  })

  it('checks Stem separately even when the general runtime is available', async () => {
    const invoke = vi.fn(async (channel: string, feature: string) =>
      channel.endsWith('get-status')
        ? {
            preferred: feature === 'stem' ? preferred : { ...preferred, alreadyAvailable: true },
            state
          }
        : { started: true, state: { status: 'ready' } }
    )
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    const current = runtime()
    current.analysisRuntime.preferred = { alreadyAvailable: true }
    const confirm = vi.fn(async (_options: Parameters<typeof confirmDialog>[0]) => 'confirm')
    const gate = useAnalysisRuntimeDownload({
      runtime: current as unknown as ReturnType<typeof useRuntimeStore>,
      t: (key) => key,
      confirmDialog: confirm as unknown as typeof confirmDialog
    })
    expect(await gate.ensureAnalysisRuntimeForHorizontalMode()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(await gate.ensureAnalysisRuntimeForStemWorkbench()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('analysis-runtime:get-status', 'stem')
    expect(invoke).toHaveBeenCalledWith('analysis-runtime:download-preferred', 'stem')
    expect(confirm.mock.calls[0][0].content).toContain('analysisRuntime.featureUpdateBody')
  })

  it('does not mark general analysis ready just because Stem installation succeeded', async () => {
    const invoke = vi.fn(async (channel: string) =>
      channel.endsWith('get-status')
        ? { preferred, state }
        : { started: true, state: { status: 'ready' } }
    )
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    const current = runtime()
    current.analysisRuntime.available = false
    const confirm = vi.fn(async (_options: Parameters<typeof confirmDialog>[0]) => 'confirm')
    const gate = useAnalysisRuntimeDownload({
      runtime: current as unknown as ReturnType<typeof useRuntimeStore>,
      t: (key) => key,
      confirmDialog: confirm as unknown as typeof confirmDialog
    })
    expect(await gate.ensureAnalysisRuntimeForStemWorkbench()).toBe(true)
    expect(current.analysisRuntime.available).toBe(false)
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
      confirmDialog: confirm as unknown as typeof confirmDialog
    })
    expect(await gate.ensureAnalysisRuntimeForBpmFix()).toBe(false)
    expect(current.analysisRuntime.available).toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0].content).toEqual(['bpmFix.componentUpdateUnavailable'])
  })
})

describe('分析运行时下载中的重复触发', () => {
  const gateWith = (params: {
    invoke: ReturnType<typeof vi.fn>
    state: Record<string, unknown>
    available?: boolean
  }) => {
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke: params.invoke } } })
    const current = runtime()
    current.analysisRuntime.available = params.available ?? false
    current.analysisRuntime.state = params.state as typeof current.analysisRuntime.state
    const confirm = vi.fn(async (_options: Parameters<typeof confirmDialog>[0]) => 'confirm')
    const gate = useAnalysisRuntimeDownload({
      runtime: current as unknown as ReturnType<typeof useRuntimeStore>,
      t: (key) => key,
      confirmDialog: confirm as unknown as typeof confirmDialog
    })
    return { gate, confirm, current }
  }

  it('下载中再次点开始分析时给出“下载中”提示，而不是静默返回', async () => {
    const invoke = vi.fn()
    const { gate, confirm } = gateWith({
      invoke,
      state: { status: 'downloading', percent: 12, title: 'CUDA' }
    })

    expect(await gate.promptAnalysisRuntimeDownload('analysis')).toBe('started')
    // 命中内存状态就直接答复，不再查主进程（主进程此时忙在下载里）。
    expect(invoke).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0].title).toBe('analysisRuntime.downloadInProgressTitle')
    expect(confirm.mock.calls[0][0].content).toEqual([
      'analysisRuntime.downloadInProgressHint',
      'analysisRuntime.downloadInProgressProgressHint'
    ])
  })

  it('各功能入口同样给反馈：双轨横推 / Stem / 修复 BPM 漂移', async () => {
    for (const run of [
      'ensureAnalysisRuntimeForHorizontalMode',
      'ensureAnalysisRuntimeForStemWorkbench',
      'ensureAnalysisRuntimeForBpmFix'
    ] as const) {
      resetAnalysisRuntimePromptStateForTests()
      const invoke = vi.fn()
      const { gate, confirm } = gateWith({ invoke, state: { status: 'extracting' } })
      expect(await gate[run]()).toBe(false)
      expect(confirm).toHaveBeenCalledOnce()
      expect(confirm.mock.calls[0][0].content).toEqual([
        'analysisRuntime.downloadInProgressHint',
        'analysisRuntime.downloadInProgressProgressHint'
      ])
    }
  })

  it('download-preferred 迟迟不回包时按“已开始”返回，不再卡住界面', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn(async (channel: string) =>
      channel.endsWith('get-status')
        ? { preferred, state: { status: 'idle' } }
        : new Promise(() => {})
    )
    const { gate, confirm } = gateWith({ invoke, state: { status: 'idle' } })

    const task = gate.promptAnalysisRuntimeDownload('analysis')
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(2000)

    await expect(task).resolves.toBe('started')
    expect(invoke).toHaveBeenCalledWith('analysis-runtime:download-preferred', 'analysis')
    // 只有最初的下载确认框，没有额外弹“失败”。
    expect(confirm).toHaveBeenCalledOnce()
  })
})
