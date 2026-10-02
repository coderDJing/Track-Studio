import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>()
}))

vi.mock('../services/externalLibrary/seratoCrateWriter', () => ({
  mutateSeratoCrate: vi.fn(async () => ({ addedCount: 1 }))
}))
import { mutateSeratoCrate } from '../services/externalLibrary/seratoCrateWriter'

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }
  }
}))

vi.mock('../libraryCacheDb', () => ({
  touchExternalAnalysisDevice: vi.fn(async () => {}),
  reconcileExternalAnalysisCacheEntries: vi.fn(async () => {}),
  pruneStaleExternalAnalysisDevices: vi.fn(async () => {}),
  registerExternalAnalysisContext: vi.fn()
}))

vi.mock('../services/externalLibrary/analysisCache', () => ({
  hydrateExternalLibraryTracksFromAnalysisCache: vi.fn(async (tracks) => tracks)
}))

vi.mock('../services/externalLibrary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/externalLibrary')>()
  return {
    ...actual,
    readSeratoLibrary: async (sourcePath: string) => {
      const hasTrack =
        (await fs.readFile(path.join(sourcePath, 'Subcrates', '4444.crate'), 'utf8')) ===
        'with-track'
      const trackId = 'serato-track:1'
      return {
        kind: 'serato',
        rootPath: sourcePath,
        libraryPath: sourcePath,
        tracks: hasTrack ? [{ id: trackId, filePath: 'C:\\Music\\Track.mp3', cues: [] }] : [],
        playlists: [
          {
            id: 'serato:4444',
            name: '4444',
            parentId: null,
            isFolder: false,
            trackIds: hasTrack ? [trackId] : [],
            order: 0
          }
        ],
        warnings: []
      }
    }
  }
})

vi.mock('../services/externalLibrary/serato', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/externalLibrary/serato')>()
  return {
    ...actual,
    hydrateSeratoTracks: async (tracks: unknown[]) => ({ tracks, warnings: [] })
  }
})

import { registerExternalLibraryHandlers } from './externalLibraryHandlers'

const collectionXml = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?>
<NML VERSION="20">
  <COLLECTION ENTRIES="1">
    <ENTRY TITLE="Track" ARTIST="Artist" PLAYTIME="240">
      <LOCATION VOLUME="C:" DIR="/:Music/:" FILE="Track.mp3"/>
    </ENTRY>
  </COLLECTION>
  <PLAYLISTS>
    <NODE TYPE="FOLDER" NAME="Root">
      <SUBNODES COUNT="1">
        <NODE TYPE="PLAYLIST" NAME="4444">
          <PLAYLIST ENTRIES="${entries ? 1 : 0}" TYPE="LIST" UUID="4444">
            ${entries}
          </PLAYLIST>
        </NODE>
      </SUBNODES>
    </NODE>
  </PLAYLISTS>
</NML>`

describe('Traktor collection snapshot', () => {
  let tempDir = ''

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  })

  it('reads newly added playlist tracks without restarting before cache TTL expires', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-traktor-snapshot-'))
    const collectionPath = path.join(tempDir, 'collection.nml')
    await fs.writeFile(collectionPath, collectionXml(''))
    registerExternalLibraryHandlers()
    const loadTracks = handlers.get('external-library:load-playlist-tracks')
    const loadTree = handlers.get('external-library:load-tree')
    const readRevision = handlers.get('external-library:source-revision')
    expect(loadTracks).toBeDefined()
    expect(loadTree).toBeDefined()
    expect(readRevision).toBeDefined()
    const source = { kind: 'traktor', path: collectionPath }
    const tree = (await loadTree?.(undefined, source)) as {
      treeNodes: Array<{ id: number; name: string }>
    }
    const playlistId = tree.treeNodes.find((node) => node.name === '4444')?.id
    expect(playlistId).toBeDefined()
    const request = { ...source, playlistId }
    const revisionBefore = (await readRevision?.(undefined, request)) as { revision: string }

    const before = (await loadTracks?.(undefined, request)) as { tracks: unknown[] }
    expect(before.tracks).toHaveLength(0)

    await fs.writeFile(
      collectionPath,
      collectionXml('<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="C:/:Music/:Track.mp3"/></ENTRY>')
    )
    const revisionAfter = (await readRevision?.(undefined, request)) as { revision: string }
    expect(revisionAfter.revision).not.toBe(revisionBefore.revision)
    const after = (await loadTracks?.(undefined, request)) as { tracks: unknown[] }
    expect(after.tracks).toHaveLength(1)
  })
})

describe('Serato crate snapshot', () => {
  let tempDir = ''

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
    tempDir = ''
    vi.mocked(mutateSeratoCrate).mockClear()
  })

  it('reconciles source tracks from disk before a drop and rejects a stale source without writing', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-serato-drop-'))
    const sourcePath = path.join(tempDir, '_Serato_')
    const cratePath = path.join(sourcePath, 'Subcrates', '4444.crate')
    await fs.mkdir(path.dirname(cratePath), { recursive: true })
    await fs.writeFile(cratePath, 'with-track')
    registerExternalLibraryHandlers()
    const request = {
      kind: 'serato',
      path: sourcePath,
      operation: 'append-existing-tracks',
      externalId: 'serato:4444',
      sourcePlaylistId: 1,
      trackPaths: ['C:\\Music\\Track.mp3']
    }
    await handlers.get('external-library:read')!(undefined, request)
    await fs.writeFile(cratePath, '')
    const result = (await handlers.get('external-library:mutate')!(undefined, request)) as {
      ok: boolean
    }
    expect(result.ok).toBe(false)
    expect(mutateSeratoCrate).not.toHaveBeenCalled()
    await fs.writeFile(cratePath, 'with-track')
    const added = (await handlers.get('external-library:mutate')!(undefined, request)) as {
      ok: boolean
    }
    expect(added.ok).toBe(true)
    expect(mutateSeratoCrate).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'write-tracks', trackPaths: request.trackPaths })
    )
  })

  it('reads a changed crate immediately while the previous snapshot is still within its TTL', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-serato-snapshot-'))
    const seratoRoot = path.join(tempDir, '_Serato_')
    const cratePath = path.join(seratoRoot, 'Subcrates', '4444.crate')
    await fs.mkdir(path.dirname(cratePath), { recursive: true })
    await fs.writeFile(cratePath, '')
    registerExternalLibraryHandlers()
    const loadTracks = handlers.get('external-library:load-playlist-tracks')
    const loadTree = handlers.get('external-library:load-tree')
    const readRevision = handlers.get('external-library:source-revision')
    expect(loadTracks).toBeDefined()
    expect(loadTree).toBeDefined()
    expect(readRevision).toBeDefined()
    const source = { kind: 'serato', path: seratoRoot }
    const tree = (await loadTree?.(undefined, source)) as {
      treeNodes: Array<{ id: number; name: string }>
    }
    const playlistId = tree.treeNodes.find((node) => node.name === '4444')?.id
    expect(playlistId).toBeDefined()
    const request = { ...source, playlistId }
    const revisionBefore = (await readRevision?.(undefined, request)) as { revision: string }

    const before = (await loadTracks?.(undefined, request)) as { tracks: unknown[] }
    expect(before.tracks).toHaveLength(0)

    await fs.writeFile(cratePath, 'with-track')
    const revisionAfter = (await readRevision?.(undefined, request)) as { revision: string }
    expect(revisionAfter.revision).not.toBe(revisionBefore.revision)
    const after = (await loadTracks?.(undefined, request)) as { tracks: unknown[] }
    expect(after.tracks).toHaveLength(1)
  })
})
