import type { IPioneerPlaylistTrack, ISongInfo } from 'src/types/globals'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import { resolveSongExternalWaveformSource } from './rekordboxExternalSource'
import { toIpcCloneablePayload } from './ipcCloneablePayload'
import { mergeHorizontalBrowseSongWithSharedGrid } from '@renderer/composables/horizontalBrowse/horizontalBrowseShellSongs'

const inflight = new Map<string, Promise<IPioneerPlaylistTrack | undefined>>()

// Grid entries and audio lead-in are playback data. Never hydrate the entire browse list.
export const loadRekordboxPlaybackRuntime = async (song: ISongInfo): Promise<ISongInfo> => {
  const source = resolveSongExternalWaveformSource(song)
  if (!source || !song.filePath) return { ...song }
  const key = JSON.stringify([
    source.sourceKind,
    source.rootPath,
    source.analyzePath,
    song.filePath
  ])
  let operation = inflight.get(key)
  if (!operation) {
    const track = toIpcCloneablePayload<IPioneerPlaylistTrack>({
      rowKey: song.mixtapeItemId || song.filePath,
      playlistId: 0,
      playlistName: '',
      trackId: 0,
      entryIndex: Number(song.mixOrder) || 0,
      title: song.title || '',
      artist: song.artist || '',
      album: song.album || '',
      label: song.label || '',
      genre: song.genre || '',
      filePath: song.filePath,
      fileName: song.fileName,
      fileFormat: song.fileFormat,
      container: song.container || '',
      duration: song.duration,
      durationSec: 0,
      bpm: song.bpm,
      analyzePath: source.analyzePath,
      hotCues: song.hotCues,
      memoryCues: song.memoryCues
    })
    const channel = buildRekordboxSourceChannel(source.sourceKind, 'attach-playlist-tracks-runtime')
    operation = (async () => {
      try {
        const result = (await window.electron.ipcRenderer.invoke(
          channel,
          ...(source.sourceKind === 'desktop' ? [[track]] : [source.rootPath, [track]])
        )) as { tracks?: IPioneerPlaylistTrack[] }
        return result.tracks?.[0]
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, operation)
  }
  const native = await operation
  const keepFrkbGrid =
    song.externalBeatGridPreference === 'frkb-manual' || song.beatGridMap?.source === 'manual'
  const resolved = native
    ? {
        ...song,
        ...(keepFrkbGrid
          ? {}
          : {
              bpm: native.bpm ?? song.bpm,
              beatGridMap: native.beatGridMap ?? song.beatGridMap,
              beatGridSource: native.beatGridMap?.source ?? song.beatGridSource,
              rekordboxGridEntries: native.rekordboxGridEntries ?? song.rekordboxGridEntries,
              timeBasisOffsetMs: native.timeBasisOffsetMs ?? song.timeBasisOffsetMs
            }),
        hotCues: native.hotCues ?? song.hotCues,
        memoryCues: native.memoryCues ?? song.memoryCues,
        fileMissing: native.fileMissing === true
      }
    : { ...song }
  const manual = (await window.electron.ipcRenderer.invoke('song:get-shared-grid-definition', {
    filePath: song.filePath
  })) as Pick<ISongInfo, 'beatGridMap' | 'timeBasisOffsetMs' | 'externalBeatGridPreference'> | null
  if (
    manual?.externalBeatGridPreference !== 'frkb-manual' &&
    manual?.beatGridMap?.source !== 'manual'
  ) {
    return resolved
  }
  return {
    ...mergeHorizontalBrowseSongWithSharedGrid(resolved, { ...manual, filePath: song.filePath }),
    externalBeatGridPreference: 'frkb-manual'
  }
}
