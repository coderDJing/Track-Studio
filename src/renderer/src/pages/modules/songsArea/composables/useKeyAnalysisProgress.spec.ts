import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import {
  applyAnalysisStageUpdate,
  computeDynamicGridAnalysisPercent,
  hasCompleteKeyAnalysis,
  useKeyAnalysisProgress
} from './useKeyAnalysisProgress'

const songFor = (index: number, fields: Partial<ISongInfo> = {}): ISongInfo => ({
  filePath: `D:\\music\\ambient-${index}.wav`,
  fileName: `ambient-${index}.wav`,
  fileFormat: 'wav',
  cover: null,
  title: undefined,
  artist: undefined,
  album: undefined,
  duration: '03:00',
  genre: undefined,
  label: undefined,
  bitrate: undefined,
  container: undefined,
  key: '2A',
  beatGridStatus: 'no-bpm',
  ...fields
})

describe('visible song analysis completeness', () => {
  it('does not show pending analysis for three no-bpm tracks without energy or structure', () => {
    const songs = Array.from({ length: 3 }, (_, index) => songFor(index))
    const progress = useKeyAnalysisProgress({
      visibleSongsWithIndex: ref(songs.map((song, idx) => ({ song, idx }))),
      requiresRuntimeAnalysis: ref(true)
    })
    for (const song of songs) {
      expect(hasCompleteKeyAnalysis(song)).toBe(true)
      expect(progress.isSongNeedsAnalysis(song.filePath)).toBe(false)
      expect(progress.getAnalysisProgress(song.filePath)).toBeNull()
    }
  })

  it('still shows missing key on a no-bpm track', () => {
    const song = songFor(0, { key: undefined })
    const progress = useKeyAnalysisProgress({
      visibleSongsWithIndex: ref([{ song, idx: 0 }]),
      requiresRuntimeAnalysis: ref(true)
    })
    expect(hasCompleteKeyAnalysis(song)).toBe(false)
    expect(progress.isSongNeedsAnalysis(song.filePath)).toBe(true)
  })

  it.each([undefined, 'no-bpm'] as const)(
    'still requires energy for a valid grid despite status %s',
    (beatGridStatus) => {
      const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
        bpm: 128,
        firstBeatMs: 125,
        downbeatBeatOffset: 0,
        source: 'analysis'
      })
      expect(beatGridMap).not.toBeNull()
      const song = songFor(0, { beatGridMap: beatGridMap ?? undefined, beatGridStatus })
      const progress = useKeyAnalysisProgress({
        visibleSongsWithIndex: ref([{ song, idx: 0 }])
      })
      expect(hasCompleteKeyAnalysis(song)).toBe(false)
      expect(progress.isSongNeedsAnalysis(song.filePath)).toBe(true)
    }
  )
})

describe('dynamic grid analysis progress', () => {
  it('advances with real scan/refine window counts on the same track', () => {
    const filePath = 'D:\\music\\dynamic-windows.wav'
    const progress = useKeyAnalysisProgress({ visibleSongsWithIndex: ref([]) })

    applyAnalysisStageUpdate({ filePath, stage: 'decode-start', needsBpm: true })
    const decodePercent = progress.getAnalysisProgress(filePath)
    applyAnalysisStageUpdate({
      filePath,
      stage: 'analyze-start',
      needsBpm: true,
      dynamicGrid: { phase: 'scan', completedWindows: 6, totalWindows: 10 }
    })
    const scanPercent = progress.getAnalysisProgress(filePath)
    applyAnalysisStageUpdate({
      filePath,
      stage: 'analyze-start',
      needsBpm: true,
      dynamicGrid: { phase: 'refine', completedWindows: 3, totalWindows: 10 }
    })
    const refinePercent = progress.getAnalysisProgress(filePath)

    expect(decodePercent).not.toBeNull()
    expect(scanPercent).toBeGreaterThan(decodePercent!)
    expect(refinePercent).toBeGreaterThan(scanPercent!)
    expect(refinePercent).toBeLessThan(100)
    applyAnalysisStageUpdate({ filePath, stage: 'job-done' })
  })

  it('keeps moving forward when the refine plan grows, and never completes before job-done', () => {
    const filePath = 'D:\\music\\dynamic-refine-growth.wav'
    const progress = useKeyAnalysisProgress({ visibleSongsWithIndex: ref([]) })

    applyAnalysisStageUpdate({
      filePath,
      stage: 'analyze-start',
      needsBpm: true,
      dynamicGrid: { phase: 'refine', completedWindows: 2, totalWindows: 40 }
    })
    const smallPlan = progress.getAnalysisProgress(filePath)!
    applyAnalysisStageUpdate({
      filePath,
      stage: 'analyze-start',
      needsBpm: true,
      dynamicGrid: { phase: 'refine', completedWindows: 2, totalWindows: 80 }
    })
    const grownPlan = progress.getAnalysisProgress(filePath)!
    expect(grownPlan).toBeGreaterThanOrEqual(smallPlan)

    applyAnalysisStageUpdate({
      filePath,
      stage: 'analyze-start',
      needsBpm: true,
      dynamicGrid: { phase: 'fit' }
    })
    expect(progress.getAnalysisProgress(filePath)!).toBeLessThan(100)
    applyAnalysisStageUpdate({
      filePath,
      stage: 'analyze-start',
      needsBpm: true,
      dynamicGrid: { phase: 'persist' }
    })
    expect(progress.getAnalysisProgress(filePath)!).toBeLessThan(100)

    applyAnalysisStageUpdate({ filePath, stage: 'job-done' })
    expect(progress.getAnalysisProgress(filePath)).toBeNull()
    expect(progress.getAnalysisDynamicGrid(filePath)).toBeNull()
  })

  it('never exposes sidecar pid through the public progress surface', () => {
    const filePath = 'D:\\music\\dynamic-pid.wav'
    const progress = useKeyAnalysisProgress({ visibleSongsWithIndex: ref([]) })
    applyAnalysisStageUpdate({
      filePath,
      stage: 'analyze-start',
      needsBpm: true,
      dynamicGrid: { phase: 'scan', completedWindows: 3, totalWindows: 9, sidecarPid: 5150 }
    })

    expect(progress.getAnalysisDynamicGrid(filePath)).toEqual({
      phase: 'scan',
      completedWindows: 3,
      totalWindows: 9
    })
    expect(JSON.stringify(progress.getAnalysisDynamicGrid(filePath))).not.toContain('5150')
    applyAnalysisStageUpdate({ filePath, stage: 'job-done' })
  })

  it('keeps the Normal fixed-stage animation and percentages unchanged', () => {
    const filePath = 'D:\\music\\normal-progress.wav'
    const progress = useKeyAnalysisProgress({ visibleSongsWithIndex: ref([]) })

    applyAnalysisStageUpdate({
      filePath,
      stage: 'decode-start',
      needsKey: true,
      needsBpm: true,
      needsWaveform: true
    })
    expect(progress.getAnalysisProgress(filePath)).toBe(20)
    expect(progress.getAnalysisDynamicGrid(filePath)).toBeNull()

    applyAnalysisStageUpdate({
      filePath,
      stage: 'analyze-done',
      needsKey: true,
      needsBpm: true,
      needsWaveform: true
    })
    expect(progress.getAnalysisProgress(filePath)).toBe(60)

    applyAnalysisStageUpdate({
      filePath,
      stage: 'waveform-done',
      needsKey: true,
      needsBpm: true,
      needsWaveform: true
    })
    expect(progress.getAnalysisProgress(filePath)).toBe(100)

    applyAnalysisStageUpdate({ filePath, stage: 'job-done' })
    expect(progress.getAnalysisProgress(filePath)).toBeNull()
  })

  it('maps each dynamic phase to a bounded range', () => {
    expect(computeDynamicGridAnalysisPercent({ phase: 'scan' })).toBe(5)
    expect(
      computeDynamicGridAnalysisPercent({ phase: 'scan', completedWindows: 10, totalWindows: 10 })
    ).toBe(55)
    expect(
      computeDynamicGridAnalysisPercent({ phase: 'refine', completedWindows: 10, totalWindows: 10 })
    ).toBe(85)
    expect(computeDynamicGridAnalysisPercent({ phase: 'fit' })).toBe(88)
    expect(computeDynamicGridAnalysisPercent({ phase: 'persist' })).toBe(98)
    expect(
      computeDynamicGridAnalysisPercent({ phase: 'scan', completedWindows: 5, totalWindows: 0 })
    ).toBe(5)
  })
})
