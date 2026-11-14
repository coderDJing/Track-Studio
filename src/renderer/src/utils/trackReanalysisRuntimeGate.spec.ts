// Run: pnpm exec vitest run src/renderer/src/utils/trackReanalysisRuntimeGate.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const promptMock = vi.hoisted(() => ({ promptAnalysisRuntimeDownload: vi.fn() }))
vi.mock('@renderer/composables/useAnalysisRuntimeDownload', () => ({
  useAnalysisRuntimeDownload: () => ({
    promptAnalysisRuntimeDownload: promptMock.promptAnalysisRuntimeDownload
  })
}))

const runtimeState = vi.hoisted(() => ({ available: false }))
vi.mock('@renderer/stores/runtime', () => ({
  useRuntimeStore: () => ({ analysisRuntime: { available: runtimeState.available } })
}))
vi.mock('@renderer/components/confirmDialog', () => ({ default: vi.fn(async () => 'confirm') }))
vi.mock('@renderer/utils/translate', () => ({ t: (key: string) => key }))

import { ensureAnalysisRuntimeForTrackReanalysis } from './trackReanalysisRuntimeGate'

const selection = (patch: { key?: boolean; beatGrid?: boolean; waveform?: boolean }) => ({
  key: false,
  beatGrid: false,
  waveform: false,
  energy: false,
  structure: false,
  ...patch
})

describe('ensureAnalysisRuntimeForTrackReanalysis', () => {
  beforeEach(() => {
    runtimeState.available = false
    promptMock.promptAnalysisRuntimeDownload.mockReset()
    promptMock.promptAnalysisRuntimeDownload.mockResolvedValue('blocked')
  })

  it('只有本地项的勾选不会触发运行时提示', async () => {
    await expect(
      ensureAnalysisRuntimeForTrackReanalysis(selection({ key: true, waveform: true }))
    ).resolves.toBe(true)
    expect(promptMock.promptAnalysisRuntimeDownload).not.toHaveBeenCalled()
  })

  it('运行时已就绪时不再触发提示', async () => {
    runtimeState.available = true
    await expect(
      ensureAnalysisRuntimeForTrackReanalysis(selection({ beatGrid: true }))
    ).resolves.toBe(true)
    expect(promptMock.promptAnalysisRuntimeDownload).not.toHaveBeenCalled()
  })

  it('需要网格时以 analysis 来源提示，下载启动后不允许继续提交', async () => {
    promptMock.promptAnalysisRuntimeDownload.mockResolvedValue('started')
    await expect(
      ensureAnalysisRuntimeForTrackReanalysis(selection({ beatGrid: true }))
    ).resolves.toBe(false)
    expect(promptMock.promptAnalysisRuntimeDownload).toHaveBeenCalledWith('analysis')
  })

  it('下载完成后允许继续提交', async () => {
    promptMock.promptAnalysisRuntimeDownload.mockResolvedValue('ready')
    await expect(
      ensureAnalysisRuntimeForTrackReanalysis(selection({ beatGrid: true }))
    ).resolves.toBe(true)
  })

  it('用户拒绝下载或下载失败时不允许继续提交', async () => {
    promptMock.promptAnalysisRuntimeDownload.mockResolvedValue('blocked')
    await expect(
      ensureAnalysisRuntimeForTrackReanalysis(selection({ beatGrid: true }))
    ).resolves.toBe(false)
  })
})
