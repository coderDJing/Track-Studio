// Run: pnpm exec vitest run src/renderer/src/composables/mixtape/timelineHelpers.waveformSources.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { createTimelineHelpersModule } from './timelineHelpers'
import type { MixtapeMixMode, MixtapeTrack } from './types'

const createTrack = (): MixtapeTrack => ({
  id: 'mix-track',
  mixOrder: 1,
  title: 'Track',
  artist: '',
  duration: '4:00',
  filePath: 'E:/Music/library/SetLibrary/__set_custody__/imported-set/track.mp3',
  originPath: 'SetLibrary/MySet',
  originPlaylistUuid: 'origin'
})

const createHelpers = (originType: string | null, mode: MixtapeMixMode = 'eq') => {
  const libraryUtils = {
    getLibraryTreeByUUID: vi.fn(() => (originType ? { type: originType } : null)),
    findDirPathByUuid: vi.fn(() => 'library/SetLibrary/MySet')
  }
  const helpers = createTimelineHelpersModule({
    zoom: { value: 1 },
    renderZoom: { value: 1 },
    tracks: { value: [] },
    mixtapeMixMode: { value: mode },
    t: (key) => key,
    libraryUtils,
    waveformDataMap: new Map(),
    rawWaveformDataMap: new Map(),
    waveformInflight: new Set(),
    rawWaveformInflight: new Set(),
    waveformMinMaxCache: new Map(),
    rawWaveformPyramidMap: new Map(),
    timelineLayoutCache: new Map(),
    timelineLayoutVersion: { value: 0 },
    waveformVersion: { value: 0 },
    overviewWidth: { value: 0 },
    timelineVisualScale: { value: 1 },
    waveformTileCache: new Map(),
    waveformTileCacheIndex: new Map(),
    waveformTileCacheTickRef: { value: 0 },
    waveformTileCacheLimitRef: { value: 100 }
  })
  return { helpers, libraryUtils }
}

describe('Mixtape waveform cache roots', () => {
  it.each(['setList', 'mixtapeList', null])(
    'lets the main process locate the physical cache for a %s origin',
    (originType) => {
      const { helpers, libraryUtils } = createHelpers(originType)
      const track = createTrack()
      expect(helpers.resolveWaveformListRoot(track)).toBe('')
      expect(helpers.resolveTrackWaveformSources(track)).toEqual([
        { filePath: track.filePath, listRoot: '', laneIndex: 0, laneCount: 1, stemId: 'inst' }
      ])
      expect(libraryUtils.findDirPathByUuid).not.toHaveBeenCalled()
    }
  )

  it('keeps the directory hint for a physical songList origin', () => {
    const { helpers, libraryUtils } = createHelpers('songList')
    libraryUtils.findDirPathByUuid.mockReturnValue('library/FilterLibrary/MySongs')
    const track = createTrack()
    track.filePath = 'E:/Music/library/FilterLibrary/MySongs/track.mp3'
    expect(helpers.resolveTrackWaveformSources(track)[0].listRoot).toBe(
      'library/FilterLibrary/MySongs'
    )
  })

  it('does not invent a cache root when there is no origin', () => {
    const { helpers, libraryUtils } = createHelpers('songList')
    const track = createTrack()
    track.originPlaylistUuid = null
    expect(helpers.resolveWaveformListRoot(track)).toBe('')
    expect(libraryUtils.findDirPathByUuid).not.toHaveBeenCalled()
  })

  it('also avoids the logical SET directory for stem and raw waveform requests', () => {
    const { helpers } = createHelpers('setList', 'stem')
    const track = {
      ...createTrack(),
      stemVocalPath: 'E:/Music/stems/vocal.wav',
      stemInstPath: 'E:/Music/stems/inst.wav',
      stemBassPath: 'E:/Music/stems/bass.wav',
      stemDrumsPath: 'E:/Music/stems/drums.wav'
    }
    const sources = helpers.resolveTrackWaveformSources(track)
    expect(sources).toHaveLength(4)
    expect(sources.every((source) => source.listRoot === '')).toBe(true)
    expect(helpers.resolveTrackWaveformFilePaths(track)).toEqual(sources.map((s) => s.filePath))
  })
})
