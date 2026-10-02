import { computed, reactive, watch } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { ISongInfo } from 'src/types/globals'
import { createEmptyHorizontalBrowseTransportSnapshot } from '@shared/horizontalBrowseTransport'
import { useHorizontalBrowseDeckTempoNudge } from './useHorizontalBrowseDeckTempoNudge'
import { resolveHorizontalBrowseWaveformTimeScale } from './horizontalBrowseWaveformTimeScale'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>()
  return { ...actual, onUnmounted: vi.fn() }
})

const createHarness = (baseRate = 0.8) => {
  const snapshot = reactive(createEmptyHorizontalBrowseTransportSnapshot())
  snapshot.top.playbackRate = baseRate
  const song: ISongInfo = {
    filePath: 'nudge.wav',
    fileName: 'nudge',
    fileFormat: 'wav',
    cover: null,
    title: undefined,
    artist: undefined,
    album: undefined,
    duration: '300',
    genre: undefined,
    label: undefined,
    bitrate: undefined,
    container: undefined,
    bpm: 150
  }
  const commands: Array<{ rate: number; finish: () => void }> = []
  const syncDeckRenderState = vi.fn()
  const nudge = useHorizontalBrowseDeckTempoNudge({
    touchDeckInteraction: vi.fn(),
    resolveDeckSong: () => song,
    resolveTransportDeckSnapshot: (deck) => snapshot[deck],
    syncDeckRenderState,
    nativeTransport: {
      setTempoNudgePlaybackRate: (deck, rate) =>
        new Promise<void>((resolve) => {
          commands.push({
            rate,
            finish: () => {
              snapshot[deck].playbackRate = rate
              resolve()
            }
          })
        })
    }
  })
  // 与 WaveformStack 接线一致：密度取正式倍率，实际时钟取 native playbackRate。
  const density = computed(() =>
    resolveHorizontalBrowseWaveformTimeScale(nudge.resolveDeckPlaybackRateForTransport('top'))
  )
  const densityChanges: number[] = []
  const stopWatch = watch(density, (value) => densityChanges.push(value), { flush: 'sync' })
  const finishCommand = async (index: number) => {
    await vi.waitFor(() => expect(commands[index]).toBeDefined())
    commands[index].finish()
    await vi.waitFor(() => expect(syncDeckRenderState).toHaveBeenCalledTimes(index + 1))
  }
  return { snapshot, nudge, density, densityChanges, stopWatch, commands, finishCommand }
}

describe('临时推拉与波形密度', () => {
  it.each(['fast', 'slow'] as const)('%s 按住和松手恢复等待期间密度都不变', async (direction) => {
    const h = createHarness()
    h.nudge.startDeckTempoNudge('top', direction)
    expect(h.density.value).toBe(0.8)
    await h.finishCommand(0)
    expect(h.snapshot.top.playbackRate).toBeCloseTo(0.8 * (direction === 'fast' ? 1.04 : 0.96), 8)
    expect(h.density.value).toBe(0.8)
    h.nudge.stopDeckTempoNudge('top', direction)
    expect(h.nudge.resolveDeckTempoNudgeDirection('top')).toBeNull()
    // 按钮已松开，旧临时倍率仍在 native 快照中；pending restore 必须继续排除它。
    expect(h.density.value).toBe(0.8)
    await h.finishCommand(1)
    expect(h.snapshot.top.playbackRate).toBe(0.8)
    expect(h.densityChanges).toEqual([])
    h.snapshot.top.playbackRate = 1.2
    expect(h.density.value).toBe(1.2)
    h.stopWatch()
  })

  it('快速反向推拉、旧按钮松手和恢复等待中重新按住均使用同一正式倍率', async () => {
    const h = createHarness(1.2)
    h.nudge.startDeckTempoNudge('top', 'fast')
    await h.finishCommand(0)
    h.nudge.startDeckTempoNudge('top', 'slow')
    h.nudge.stopDeckTempoNudge('top', 'fast')
    expect(h.nudge.resolveDeckTempoNudgeDirection('top')).toBe('slow')
    await h.finishCommand(1)
    h.nudge.stopDeckTempoNudge('top', 'slow')
    h.nudge.startDeckTempoNudge('top', 'fast')
    await h.finishCommand(2)
    expect(h.nudge.resolveDeckTempoNudgeDirection('top')).toBe('fast')
    await h.finishCommand(3)
    h.nudge.stopAllDeckTempoNudge()
    await h.finishCommand(4)
    expect(h.commands.map((command) => command.rate)).toEqual([
      1.2 * 1.04,
      1.2 * 0.96,
      1.2,
      1.2 * 1.04,
      1.2
    ])
    expect(h.densityChanges).toEqual([])
    h.stopWatch()
  })

  it('重置结束临时推拉时不会把旧临时倍率暴露给密度', async () => {
    const h = createHarness(1)
    h.nudge.startDeckTempoNudge('top', 'fast')
    await h.finishCommand(0)
    const reset = h.nudge.resetAllDeckTempoNudgePlaybackRates(1)
    expect(h.density.value).toBe(1)
    await h.finishCommand(1)
    // 两轨各自的重置请求都要完成。
    await vi.waitFor(() => expect(h.commands).toHaveLength(3))
    h.commands[2].finish()
    await reset
    expect(h.densityChanges).toEqual([])
    h.stopWatch()
  })
})
