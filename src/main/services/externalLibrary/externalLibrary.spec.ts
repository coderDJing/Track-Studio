import { describe, expect, it } from 'vitest'
import { __seratoTestUtils } from './serato'
import { __traktorTestUtils } from './traktor'
import {
  buildExternalLibraryBrowserTracks,
  buildExternalLibraryBrowserTree,
  buildSeratoWaveformOverviews
} from './browserAdapter'
import type { ExternalLibrarySnapshot } from '../../../shared/externalLibrary'
import { parseSeratoWaveformOverview } from '../../../shared/seratoWaveformOverview'
import { mergeExternalAnalysisIntoBrowserTrack } from './analysisCache'
import { createSongBeatGridMapV2FromFixedGrid } from '../../../shared/songBeatGridMapV2'

const textChunk = (tag: string, value: string) => {
  const utf16 = Buffer.from(value, 'utf16le')
  const swapped = Buffer.alloc(utf16.length)
  for (let index = 0; index < utf16.length; index += 2) {
    swapped[index] = utf16[index + 1]
    swapped[index + 1] = utf16[index]
  }
  const header = Buffer.alloc(8)
  header.write(tag, 0, 4, 'ascii')
  header.writeUInt32BE(swapped.length, 4)
  return Buffer.concat([header, swapped])
}

const objectChunk = (tag: string, payload: Buffer) => {
  const header = Buffer.alloc(8)
  header.write(tag, 0, 4, 'ascii')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

describe('Serato external library parser', () => {
  it('parses Database V2 style track records', () => {
    const record = Buffer.concat([
      textChunk('pfil', 'Music/Artist/Track.mp3'),
      textChunk('tsng', 'Track'),
      textChunk('tart', 'Artist'),
      textChunk('tbpm', '128.5')
    ])
    const records = __seratoTestUtils.parseTrackRecords(objectChunk('otrk', record))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      filePath: 'Music/Artist/Track.mp3',
      title: 'Track',
      bpm: 128.5
    })
  })

  it('resolves Serato track paths relative to the volume root', () => {
    const resolveTrackPath = __seratoTestUtils.resolveTrackPath
    const seratoRoot = 'C:\\Users\\DJ\\Music\\_Serato_'

    expect(resolveTrackPath(seratoRoot, 'Users/DJ/Music/Track.mp3')).toBe(
      'C:\\Users\\DJ\\Music\\Track.mp3'
    )
    expect(resolveTrackPath(seratoRoot, '/D:/Music/Track.mp3')).toBe('D:\\Music\\Track.mp3')
    expect(resolveTrackPath(seratoRoot, 'D:/Music/Track.mp3')).toBe('D:\\Music\\Track.mp3')
  })

  it('parses the version header and 16-row native overview pixels', () => {
    const raw = Uint8Array.from([1, 5, ...Array.from({ length: 32 }, (_, index) => index + 1)])
    expect(parseSeratoWaveformOverview(raw)).toMatchObject({
      versionMajor: 1,
      versionMinor: 5,
      columnCount: 2,
      rowCount: 16,
      pixels: Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 1))
    })
    expect(parseSeratoWaveformOverview(Uint8Array.from([1, 5, 1]))).toBeNull()
  })
})

describe('Traktor external library parser', () => {
  it('maps collection tracks, playlists and cue types', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <NML VERSION="20">
        <COLLECTION ENTRIES="1">
          <ENTRY TITLE="Track" ARTIST="Artist" PLAYTIME="240">
            <LOCATION VOLUME="C:" DIR="/:Music/:" FILE="Track.mp3"/>
            <ALBUM TITLE="Album"/>
            <INFO GENRE="House" COMMENT="Note"/>
            <TEMPO BPM="128.5"/>
            <MUSICAL_KEY VALUE="8"/>
            <CUE_V2 NAME="AutoGrid" TYPE="4" START="1000" LEN="0" HOTCUE="-1"/>
            <CUE_V2 NAME="Drop" TYPE="0" START="2000" LEN="0" HOTCUE="1"/>
            <CUE_V2 NAME="Loop" TYPE="5" START="3000" LEN="4000" HOTCUE="0"/>
          </ENTRY>
        </COLLECTION>
        <PLAYLISTS>
          <NODE TYPE="FOLDER" NAME="Root">
            <SUBNODES COUNT="1">
              <NODE TYPE="PLAYLIST" NAME="Set">
                <PLAYLIST ENTRIES="1"><ENTRY><PRIMARYKEY KEY="C:/:Music/:Track.mp3" TYPE="TRACK"/></ENTRY></PLAYLIST>
              </NODE>
            </SUBNODES>
          </NODE>
        </PLAYLISTS>
      </NML>`
    const parsed = __traktorTestUtils.parseTraktorCollectionXml(xml, 'C:\\Users\\DJ')
    expect(parsed.tracks).toHaveLength(1)
    expect(parsed.tracks[0]).toMatchObject({ title: 'Track', artist: 'Artist', bpm: 128.5 })
    expect(parsed.tracks[0].cues.map((cue) => cue.kind)).toEqual(['grid', 'hotCue', 'loop'])
    expect(parsed.playlists.at(-1)).toMatchObject({ name: 'Set', trackIds: [parsed.tracks[0].id] })
  })
})

describe('External library browser adapter', () => {
  const snapshot: ExternalLibrarySnapshot = {
    kind: 'traktor',
    rootPath: 'C:\\Users\\DJ\\Documents\\Native Instruments\\Traktor 4.4.1',
    libraryPath: 'C:\\Users\\DJ\\Documents\\Native Instruments\\Traktor 4.4.1\\collection.nml',
    tracks: [
      {
        id: 'track-1',
        filePath: 'C:\\Music\\Track.mp3',
        title: 'Track',
        artist: 'Artist',
        bpm: 128,
        durationSec: 185,
        cues: [
          { kind: 'grid', positionMs: 120, bpm: 128 },
          { kind: 'hotCue', positionMs: 1000, slot: 1, name: 'Drop' }
        ]
      }
    ],
    playlists: [
      {
        id: 'folder',
        name: 'Sets',
        parentId: null,
        isFolder: true,
        trackIds: [],
        order: 0
      },
      {
        id: 'playlist',
        name: 'Friday',
        parentId: 'folder',
        isFolder: false,
        trackIds: ['track-1'],
        order: 1
      }
    ],
    warnings: []
  }

  it('maps playlists to the same tree model used by the Rekordbox browser', () => {
    const result = buildExternalLibraryBrowserTree(snapshot)
    expect(result.treeNodes[0]).toMatchObject({ id: 1, name: '全部曲目', isFolder: false })
    expect(result.treeNodes[1]).toMatchObject({ name: 'Sets', isFolder: true })
    expect(result.treeNodes[1].children?.[0]).toMatchObject({ name: 'Friday', isFolder: false })
  })

  it('maps playlist tracks to the standard song-table model', () => {
    const result = buildExternalLibraryBrowserTracks(snapshot, 3)
    expect(result.tracks[0]).toMatchObject({
      title: 'Track',
      artist: 'Artist',
      duration: '3:05',
      bpm: 128,
      hotCues: [{ slot: 1, sec: 1, label: 'Drop' }]
    })
  })

  it('prefers a persisted FRKB grid BPM over the external library BPM', () => {
    const track = buildExternalLibraryBrowserTracks(snapshot, 3).tracks[0]
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 126.25,
      firstBeatMs: 240,
      downbeatBeatOffset: 0,
      source: 'analysis'
    })
    expect(beatGridMap).not.toBeNull()
    const merged = mergeExternalAnalysisIntoBrowserTrack(track, {
      beatGridMap: beatGridMap || undefined,
      timeBasisOffsetMs: 12
    })
    expect(merged.bpm).toBe(126.25)
    expect(merged.beatGridMap?.source).toBe('analysis')
    expect(merged.timeBasisOffsetMs).toBe(12)
  })

  it('returns Serato overviews only for requested track paths', () => {
    const seratoSnapshot: ExternalLibrarySnapshot = {
      ...snapshot,
      kind: 'serato',
      tracks: [
        {
          ...snapshot.tracks[0],
          waveformOverview: Uint8Array.from([1, 5, ...Array.from({ length: 16 }, () => 24)])
        }
      ]
    }
    const result = buildSeratoWaveformOverviews(seratoSnapshot, [
      'c:/music/track.mp3',
      'C:/Music/Missing.mp3'
    ])
    expect(result[0].data).toMatchObject({ columnCount: 1, rowCount: 16 })
    expect(result[1].data).toBeNull()
  })
})
