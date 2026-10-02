import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import type { IPioneerPlaylistTrack, ISongInfo } from 'src/types/globals'
import { loadRekordboxPlaybackRuntime } from './loadRekordboxPlaybackRuntime'
import { createSongBeatGridMapV2FromRekordboxEntries } from '@shared/songBeatGridMapV2'

const song: ISongInfo = {
  filePath: 'C:\\Music\\Track.mp3',
  fileName: 'Track.mp3',
  fileFormat: 'MP3',
  cover: null,
  title: 'Track',
  artist: '',
  album: '',
  genre: '',
  label: '',
  bitrate: undefined,
  container: undefined,
  duration: '3:00',
  externalSourceKind: 'desktop',
  externalAnalyzePath: 'ANLZ0000.DAT',
  externalWaveformRootPath: 'C:\\rekordbox'
}
const nativeGrid = createSongBeatGridMapV2FromRekordboxEntries([
  { timeMs: 100, bpm: 120, beatNumber: 1 },
  { timeMs: 600, bpm: 120, beatNumber: 2 }
])!

describe('Rekordbox playback runtime', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(['desktop', 'usb'] as const)('hydrates only the loaded %s song', async (sourceKind) => {
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'song:get-shared-grid-definition') return null
      const tracks = args[sourceKind === 'desktop' ? 0 : 1] as Array<{ filePath: string }>
      expect(tracks).toHaveLength(1)
      expect(tracks[0].filePath).toBe(song.filePath)
      expect(channel).toBe(
        `${sourceKind === 'desktop' ? 'rekordbox-desktop' : 'pioneer-device'}-library:attach-playlist-tracks-runtime`
      )
      return { tracks: [{ ...tracks[0], beatGridMap: nativeGrid, timeBasisOffsetMs: 25 }] }
    })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    const resolved = await loadRekordboxPlaybackRuntime({ ...song, externalSourceKind: sourceKind })
    expect(resolved.beatGridMap).toBe(nativeGrid)
    expect(resolved.timeBasisOffsetMs).toBe(25)
    expect(song.beatGridMap).toBeUndefined()
  })

  it('keeps manually reanalyzed FRKB data ahead of the native grid', async () => {
    const manualGrid = { ...nativeGrid, source: 'analysis' as const }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'song:get-shared-grid-definition') {
        return {
          beatGridMap: manualGrid,
          timeBasisOffsetMs: 30,
          externalBeatGridPreference: 'frkb-manual'
        }
      }
      return { tracks: [{ beatGridMap: nativeGrid, timeBasisOffsetMs: 25 }] }
    })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    vi.stubGlobal('navigator', { platform: 'Win32' })
    const resolved = await loadRekordboxPlaybackRuntime(song)
    expect(resolved.beatGridMap?.source).toBe('analysis')
    expect(resolved.timeBasisOffsetMs).toBe(30)
    expect(resolved.externalBeatGridPreference).toBe('frkb-manual')
  })

  it('coalesces concurrent native requests for the same song', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'song:get-shared-grid-definition') return null
      await Promise.resolve()
      return { tracks: [{ beatGridMap: nativeGrid }] }
    })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    await Promise.all([loadRekordboxPlaybackRuntime(song), loadRekordboxPlaybackRuntime(song)])
    expect(
      invoke.mock.calls.filter(([channel]) => channel.endsWith('attach-playlist-tracks-runtime'))
    ).toHaveLength(1)
  })

  it.each(['desktop', 'usb'] as const)(
    'sends cloneable cues from a reactive %s browse row',
    async (sourceKind) => {
      const reactiveSong = reactive({
        ...song,
        externalSourceKind: sourceKind,
        hotCues: [{ slot: 0, sec: 1.25 }],
        memoryCues: [{ sec: 2 }]
      })
      const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
        // Electron IPC uses structured cloning; shallow spreads leave nested Vue proxies.
        const clonedArgs = structuredClone(args)
        if (channel === 'song:get-shared-grid-definition') return null
        const tracks = clonedArgs[sourceKind === 'desktop' ? 0 : 1] as IPioneerPlaylistTrack[]
        return { tracks: [{ ...tracks[0], beatGridMap: nativeGrid }] }
      })
      vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
      const resolved = await loadRekordboxPlaybackRuntime({ ...reactiveSong })
      expect(resolved.beatGridMap).toBe(nativeGrid)
      expect(resolved.hotCues).toEqual([{ slot: 0, sec: 1.25 }])
      expect(resolved.memoryCues).toEqual([{ sec: 2 }])
    }
  )
})
