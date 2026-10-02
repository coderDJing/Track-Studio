import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseTraktorCollectionXml } from './traktor'
import {
  mutateTraktorCollection,
  mutateTraktorCollectionXml,
  type TraktorMutationRequest
} from './traktorCollectionWriter'
import { buildExternalLibraryBrowserTracks, getPlaylistNumericId } from './browserAdapter'

const sourcePath = 'C:\\Users\\DJ\\Documents\\Native Instruments\\Traktor 4.5.1\\collection.nml'
const trackPath = 'C:\\Music\\Track.mp3'
const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<NML VERSION="20">
  <COLLECTION ENTRIES="1">
    <ENTRY TITLE="Track" ARTIST="Artist"><LOCATION VOLUME="C:" DIR="/:Music/:" FILE="Track.mp3"/><INFO PLAYTIME="180"/></ENTRY>
  </COLLECTION>
  <PLAYLISTS>
    <NODE TYPE="FOLDER" NAME="ROOT">
      <SUBNODES COUNT="2">
        <NODE TYPE="FOLDER" NAME="Sets"><SUBNODES COUNT="1">
          <NODE TYPE="PLAYLIST" NAME="Friday"><PLAYLIST ENTRIES="1" TYPE="LIST" UUID="12345678901234567890123456789012"><ENTRY><PRIMARYKEY TYPE="TRACK" KEY="C:/:Music/:Track.mp3"/></ENTRY></PLAYLIST></NODE>
        </SUBNODES></NODE>
        <NODE TYPE="SMARTLIST" NAME="Recently Played"><SMARTLIST><SEARCH_EXPRESSION/></SMARTLIST></NODE>
      </SUBNODES>
    </NODE>
  </PLAYLISTS>
</NML>`

const mutate = (xml: string, request: Omit<TraktorMutationRequest, 'sourcePath'>) =>
  mutateTraktorCollectionXml(xml, { ...request, sourcePath })

describe('Traktor collection mutations', () => {
  it('keeps exact root positions with hidden smartlists and rejects stale folder targets', () => {
    let xml = mutate(fixture, { operation: 'create-playlist', name: 'A' }).xml
    const b = mutate(xml, { operation: 'create-playlist', name: 'B' })
    xml = mutate(b.xml, { operation: 'move', externalId: b.summary.externalId, seq: 2 }).xml
    const parsed = parseTraktorCollectionXml(xml)
    expect(
      parsed.playlists
        .filter((item) => !item.parentId && !item.isSmartPlaylist)
        .map((item) => item.name)
    ).toEqual(['Sets', 'B', 'A'])
    const folder = parsed.playlists.find((item) => item.name === 'Sets')!
    expect(() =>
      mutate(xml, { operation: 'move', externalId: folder.id, parentExternalId: folder.id })
    ).toThrow('自身')
    expect(() =>
      mutate(xml, {
        operation: 'create-playlist',
        name: 'Invalid',
        parentExternalId: 'stale-folder'
      })
    ).toThrow('已变化')
  })

  it('moves down using original row boundaries and preserves explicit renumber order', () => {
    let xml = fixture
    let playlist = parseTraktorCollectionXml(xml).playlists.find((item) => item.name === 'Friday')!
    xml = mutate(xml, {
      operation: 'write-tracks',
      externalId: playlist.id,
      trackPaths: ['C:\\Music\\Second.mp3', 'C:\\Music\\Third.mp3', 'C:\\Music\\Fourth.mp3']
    }).xml
    const read = () => {
      const parsed = parseTraktorCollectionXml(xml)
      playlist = parsed.playlists.find((item) => item.name === 'Friday')!
      return buildExternalLibraryBrowserTracks(
        { ...parsed, kind: 'traktor', rootPath: '', libraryPath: '' },
        getPlaylistNumericId(playlist)
      ).tracks
    }
    const reorder = (rowKeys: string[], targetIndex: number) => {
      xml = mutate(xml, {
        operation: 'reorder-tracks',
        externalId: playlist.id,
        rowKeys,
        targetIndex
      }).xml
    }
    const original = read()
    const paths = original.map((item) => item.filePath)
    reorder([original[0].rowKey], 2)
    expect(read().map((item) => item.filePath)).toEqual([paths[1], paths[0], paths[2], paths[3]])
    let rows = read()
    reorder([rows[1].rowKey], 0)
    expect(read().map((item) => item.filePath)).toEqual(paths)
    rows = read()
    reorder([rows[0].rowKey, rows[2].rowKey], 4)
    expect(read().map((item) => item.filePath)).toEqual([paths[1], paths[3], paths[0], paths[2]])
    rows = read().reverse()
    reorder(
      rows.map((item) => item.rowKey),
      0
    )
    expect(read().map((item) => item.filePath)).toEqual(rows.map((item) => item.filePath))
  })

  it('adds existing tracks to another playlist once and preserves source cues and grids', () => {
    const native = fixture.replace(
      '<INFO PLAYTIME="180"/>',
      '<INFO PLAYTIME="180"/><CUE_V2 NAME="Grid" TYPE="4" START="26.122"><GRID BPM="128"/></CUE_V2>'
    )
    const created = mutate(native, { operation: 'create-playlist', name: 'Target' })
    const before = parseTraktorCollectionXml(created.xml)
    const target = before.playlists.find((item) => item.name === 'Target')!
    const added = mutate(created.xml, {
      operation: 'write-tracks',
      externalId: target.id,
      trackPaths: [trackPath, trackPath]
    })
    const after = parseTraktorCollectionXml(added.xml)
    expect(added.summary.addedCount).toBe(1)
    expect(added.summary.skippedDuplicateCount).toBe(1)
    expect(after.tracks).toEqual(before.tracks)
    expect(after.playlists.find((item) => item.name === 'Friday')!.trackIds).toEqual(
      before.playlists.find((item) => item.name === 'Friday')!.trackIds
    )
    expect(after.playlists.find((item) => item.name === 'Target')!.trackIds).toHaveLength(1)
  })
  it('shows real playlists below the NML root and reads INFO duration', () => {
    const parsed = parseTraktorCollectionXml(fixture)
    expect(parsed.tracks[0].durationSec).toBe(180)
    expect(parsed.playlists.map((playlist) => playlist.name)).toEqual([
      'Sets',
      'Friday',
      'Recently Played'
    ])
    expect(parsed.playlists[1].trackIds).toEqual([parsed.tracks[0].id])
  })

  it('creates, renames and moves a playlist while preserving the existing track', () => {
    const created = mutate(fixture, { operation: 'create-playlist', name: 'Saturday' })
    let parsed = parseTraktorCollectionXml(created.xml)
    expect(parsed.playlists.map((item) => item.name)).toContain('Saturday')
    expect(created.xml).toContain('COUNT="3"')
    const renamed = mutate(created.xml, {
      operation: 'rename',
      externalId: created.summary.externalId,
      name: 'Sunday & Friends'
    })
    parsed = parseTraktorCollectionXml(renamed.xml)
    expect(parsed.playlists.find((item) => item.name === 'Sunday & Friends')).toBeTruthy()
    const folder = parsed.playlists.find((item) => item.name === 'Sets')
    const moved = mutate(renamed.xml, {
      operation: 'move',
      externalId: renamed.summary.externalId,
      parentExternalId: folder?.id,
      seq: 1
    })
    parsed = parseTraktorCollectionXml(moved.xml)
    expect(parsed.playlists.find((item) => item.name === 'Sunday & Friends')?.parentId).toBe(
      folder?.id
    )
    expect(parsed.playlists.find((item) => item.name === 'Friday')?.trackIds).toHaveLength(1)
  })

  it('adds existing and new collection tracks, reorders and removes exact rows', () => {
    const playlist = parseTraktorCollectionXml(fixture).playlists.find(
      (item) => item.name === 'Friday'
    )!
    const appended = mutate(fixture, {
      operation: 'write-tracks',
      externalId: playlist.id,
      trackPaths: [trackPath, 'D:\\Sets\\Second.mp3'],
      trackMetadata: [
        {
          storedPath: 'D:\\Sets\\Second.mp3',
          title: 'Second',
          artist: 'Guest',
          bpm: 125,
          durationSec: 192.5,
          hotCues: [{ slot: 1, sec: 32, label: 'Drop' }]
        }
      ]
    })
    expect(appended.summary).toMatchObject({ addedCount: 1, skippedDuplicateCount: 1 })
    let parsed = parseTraktorCollectionXml(appended.xml)
    expect(parsed.tracks).toHaveLength(2)
    expect(parsed.tracks[1]).toMatchObject({
      title: 'Second',
      artist: 'Guest',
      bpm: 125,
      durationSec: 192.5,
      cues: [{ kind: 'hotCue', slot: 1, positionMs: 32000, name: 'Drop' }]
    })
    expect(parsed.playlists.find((item) => item.name === 'Friday')?.trackIds).toHaveLength(2)
    const selected = parsed.playlists.find((item) => item.name === 'Friday')!
    const browserTracks = buildExternalLibraryBrowserTracks(
      { ...parsed, kind: 'traktor', rootPath: '', libraryPath: '' },
      getPlaylistNumericId(selected)
    ).tracks
    const reordered = mutate(appended.xml, {
      operation: 'reorder-tracks',
      externalId: selected.id,
      rowKeys: [browserTracks[1].rowKey],
      targetIndex: 0
    })
    parsed = parseTraktorCollectionXml(reordered.xml)
    expect(parsed.playlists.find((item) => item.name === 'Friday')?.trackIds[0]).toBe(
      parsed.tracks[1].id
    )
    const newRows = buildExternalLibraryBrowserTracks(
      { ...parsed, kind: 'traktor', rootPath: '', libraryPath: '' },
      getPlaylistNumericId(selected)
    ).tracks
    const removed = mutate(reordered.xml, {
      operation: 'remove-tracks',
      externalId: selected.id,
      rowKeys: [newRows[0].rowKey]
    })
    expect(removed.summary.removedCount).toBe(1)
    expect(parseTraktorCollectionXml(removed.xml).playlists[1].trackIds).toHaveLength(1)
    expect(() =>
      mutate(removed.xml, {
        operation: 'remove-tracks',
        externalId: selected.id,
        rowKeys: [newRows[0].rowKey]
      })
    ).toThrow('已变化')
  })

  it('protects smartlists and rejects malformed NML', () => {
    const smartlist = parseTraktorCollectionXml(fixture).playlists.find(
      (item) => item.isSmartPlaylist
    )!
    expect(() => mutate(fixture, { operation: 'delete', externalId: smartlist.id })).toThrow(
      '智能歌单'
    )
    expect(() =>
      mutate('<NML><broken></NML>', { operation: 'create-folder', name: 'Bad' })
    ).toThrow('不是有效')
  })

  it('writes an isolated collection and keeps the original as a backup', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-traktor-test-'))
    const collectionPath = path.join(tempRoot, 'collection.nml')
    try {
      await fs.writeFile(collectionPath, fixture)
      await mutateTraktorCollection({
        operation: 'create-folder',
        sourcePath: collectionPath,
        name: 'New Folder'
      })
      const updated = await fs.readFile(collectionPath, 'utf8')
      expect(parseTraktorCollectionXml(updated).playlists.at(-1)?.name).toBe('New Folder')
      const backups = await fs.readdir(path.join(tempRoot, 'FRKB Backups'))
      expect(backups).toHaveLength(1)
      expect(await fs.readFile(path.join(tempRoot, 'FRKB Backups', backups[0]), 'utf8')).toBe(
        fixture
      )
    } finally {
      if (!path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        throw new Error('Temporary test directory is outside the system temp root.')
      }
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  }, 30000)
})
