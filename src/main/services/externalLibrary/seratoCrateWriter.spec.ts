import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { mutateSeratoCrate } from './seratoCrateWriter'
import { __seratoTestUtils, readSeratoLibrary } from './serato'
import { buildExternalLibraryBrowserTracks, getPlaylistNumericId } from './browserAdapter'

const chunk = (tag: string, payload: Buffer) => {
  const header = Buffer.alloc(8)
  header.write(tag)
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}
const crate = (paths: string[]) =>
  Buffer.concat([
    chunk('ovrs', Buffer.from('1.0/Serato ScratchLive Crate', 'utf16le').swap16()),
    ...paths.map((filePath) =>
      chunk(
        'otrk',
        chunk(
          'ptrk',
          Buffer.from(filePath.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, ''), 'utf16le').swap16()
        )
      )
    )
  ])

describe('Serato existing song references', () => {
  it('persists mixed folder/playlist order and protects folder names and cycles', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-serato-tree-'))
    try {
      const seratoRoot = path.join(root, '_Serato_')
      await mutateSeratoCrate({
        operation: 'create-folder',
        sourcePath: seratoRoot,
        name: 'Folder'
      })
      await mutateSeratoCrate({
        operation: 'create-playlist',
        sourcePath: seratoRoot,
        name: 'Child',
        parentExternalId: 'serato:Folder'
      })
      await mutateSeratoCrate({
        operation: 'create-playlist',
        sourcePath: seratoRoot,
        name: 'Other'
      })
      await mutateSeratoCrate({
        operation: 'move',
        sourcePath: seratoRoot,
        externalId: 'serato:Other',
        seq: 1
      })
      const snapshot = await readSeratoLibrary(seratoRoot, { hydrateTracks: false })
      expect(snapshot.playlists.filter((item) => !item.parentId).map((item) => item.name)).toEqual([
        'Other',
        'Folder'
      ])
      await expect(
        mutateSeratoCrate({ operation: 'create-folder', sourcePath: seratoRoot, name: 'Folder' })
      ).rejects.toThrow('同名')
      await expect(
        mutateSeratoCrate({
          operation: 'move',
          sourcePath: seratoRoot,
          externalId: 'serato:Folder',
          parentExternalId: 'serato:Folder/Child'
        })
      ).rejects.toThrow('自身')
      await mutateSeratoCrate({
        operation: 'rename',
        sourcePath: seratoRoot,
        externalId: 'serato:Folder',
        name: 'Renamed'
      })
      expect(
        (await readSeratoLibrary(seratoRoot, { hydrateTracks: false })).playlists.map(
          (item) => item.id
        )
      ).toContain('serato:Renamed/Child')
      await mutateSeratoCrate({
        operation: 'delete',
        sourcePath: seratoRoot,
        externalId: 'serato:Renamed'
      })
      expect(
        (await readSeratoLibrary(seratoRoot, { hydrateTracks: false })).playlists.map(
          (item) => item.name
        )
      ).toEqual(['Other'])
    } finally {
      if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
        throw new Error('Unexpected temp directory')
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('uses original drop boundaries, preserves requested renumber order and rejects stale rows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-serato-order-'))
    try {
      const seratoRoot = path.join(root, '_Serato_')
      const subcrates = path.join(seratoRoot, 'Subcrates')
      await fs.mkdir(subcrates, { recursive: true })
      const paths = ['A', 'B', 'C', 'D'].map((name) => path.join(root, `${name}.mp3`))
      const file = path.join(subcrates, 'Target.crate')
      await fs.writeFile(file, crate(paths))
      const read = async () => {
        const snapshot = await readSeratoLibrary(seratoRoot, { hydrateTracks: false })
        const playlist = snapshot.playlists.find((item) => item.id === 'serato:Target')!
        return buildExternalLibraryBrowserTracks(snapshot, getPlaylistNumericId(playlist)).tracks
      }
      const reorder = async (keys: string[], targetIndex: number) =>
        mutateSeratoCrate({
          operation: 'reorder-tracks',
          sourcePath: seratoRoot,
          externalId: 'serato:Target',
          rowKeys: keys,
          targetIndex
        })
      const original = await read()
      await reorder([original[0].rowKey], 2)
      expect((await read()).map((item) => item.filePath)).toEqual([
        paths[1],
        paths[0],
        paths[2],
        paths[3]
      ])
      const beforeRejected = await fs.readFile(file)
      await expect(
        mutateSeratoCrate({
          operation: 'remove-tracks',
          sourcePath: seratoRoot,
          externalId: 'serato:Target',
          rowKeys: [original[0].rowKey]
        })
      ).rejects.toThrow('已变化')
      expect(await fs.readFile(file)).toEqual(beforeRejected)
      let current = await read()
      await reorder([current[1].rowKey], 0)
      expect((await read()).map((item) => item.filePath)).toEqual(paths)
      current = await read()
      await reorder([current[0].rowKey, current[2].rowKey], 4)
      expect((await read()).map((item) => item.filePath)).toEqual([
        paths[1],
        paths[3],
        paths[0],
        paths[2]
      ])
      current = await read()
      const reversed = [...current].reverse()
      await reorder(
        reversed.map((item) => item.rowKey),
        0
      )
      expect((await read()).map((item) => item.filePath)).toEqual(
        reversed.map((item) => item.filePath)
      )
      current = await read()
      await mutateSeratoCrate({
        operation: 'remove-tracks',
        sourcePath: seratoRoot,
        externalId: 'serato:Target',
        rowKeys: [current[0].rowKey, current[2].rowKey]
      })
      expect((await read()).map((item) => item.filePath)).toEqual([
        current[1].filePath,
        current[3].filePath
      ])
    } finally {
      if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
        throw new Error('Unexpected temp directory')
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('rejects rename collisions without overwriting another crate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-serato-collision-'))
    try {
      const seratoRoot = path.join(root, '_Serato_')
      const subcrates = path.join(seratoRoot, 'Subcrates')
      await fs.mkdir(subcrates, { recursive: true })
      const source = crate([path.join(root, 'A.mp3')])
      const target = crate([path.join(root, 'B.mp3')])
      await fs.writeFile(path.join(subcrates, 'Source.crate'), source)
      await fs.writeFile(path.join(subcrates, 'Target.crate'), target)
      await expect(
        mutateSeratoCrate({
          operation: 'rename',
          sourcePath: seratoRoot,
          externalId: 'serato:Source',
          name: 'Target'
        })
      ).rejects.toThrow('同名')
      expect(await fs.readFile(path.join(subcrates, 'Source.crate'))).toEqual(source)
      expect(await fs.readFile(path.join(subcrates, 'Target.crate'))).toEqual(target)
    } finally {
      if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
        throw new Error('Unexpected temp directory')
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('appends unique references while preserving the source crate and audio bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-serato-drop-write-'))
    try {
      const seratoRoot = path.join(root, '_Serato_')
      const subcrates = path.join(seratoRoot, 'Subcrates')
      await fs.mkdir(subcrates, { recursive: true })
      const paths = [path.join(root, 'A.mp3'), path.join(root, 'B.mp3')]
      const audio = Buffer.from('native analysis and cue bytes must remain untouched')
      for (const filePath of paths) await fs.writeFile(filePath, audio)
      const source = crate(paths)
      await fs.writeFile(path.join(subcrates, 'Source.crate'), source)
      await fs.writeFile(path.join(subcrates, 'Target.crate'), crate(paths.slice(0, 1)))
      const result = await mutateSeratoCrate({
        operation: 'write-tracks',
        sourcePath: seratoRoot,
        externalId: 'serato:Target',
        trackPaths: paths
      })
      expect(result.addedCount).toBe(1)
      expect(result.skippedDuplicateCount).toBe(1)
      expect(await fs.readFile(path.join(subcrates, 'Source.crate'))).toEqual(source)
      const target = await fs.readFile(path.join(subcrates, 'Target.crate'))
      expect(
        __seratoTestUtils.parseChunks(target).filter((item) => item.tag === 'otrk')
      ).toHaveLength(2)
      for (const filePath of paths) expect(await fs.readFile(filePath)).toEqual(audio)
      const repeated = await mutateSeratoCrate({
        operation: 'write-tracks',
        sourcePath: seratoRoot,
        externalId: 'serato:Target',
        trackPaths: paths
      })
      expect(repeated.addedCount).toBe(0)
      expect(await fs.readFile(path.join(subcrates, 'Target.crate'))).toEqual(target)
    } finally {
      if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
        throw new Error('Unexpected temp directory')
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
