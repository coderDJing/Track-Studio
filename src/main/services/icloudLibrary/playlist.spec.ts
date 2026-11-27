import { describe, expect, it } from 'vitest'
import { localPlaylistRelativePath } from './playlist'
import type { LibraryNodeRow } from '../../libraryTreeDbHelpers'
const rows: LibraryNodeRow[] = [
  { uuid: 'root', parentUuid: null, dirName: 'library', nodeType: 'root', order: 0 },
  { uuid: 'lib', parentUuid: 'root', dirName: 'FilterLibrary', nodeType: 'library', order: 0 },
  { uuid: 'folder', parentUuid: 'lib', dirName: 'Music', nodeType: 'dir', order: 0 },
  { uuid: 'list', parentUuid: 'folder', dirName: 'Songs', nodeType: 'songList', order: 0 }
]
describe('local playlist authorization', () => {
  it('resolves trusted ancestry, not renderer supplied paths', () => {
    expect(localPlaylistRelativePath(rows, 'list', ['FilterLibrary'])).toBe(
      'library/FilterLibrary/Music/Songs'
    )
  })
  it('rejects unknown UUIDs, non-songlists and other libraries', () => {
    for (const uuid of ['missing', 'lib', 'folder'])
      expect(() => localPlaylistRelativePath(rows, uuid, ['FilterLibrary'])).toThrow('invalid')
    expect(() => localPlaylistRelativePath(rows, 'list', ['CuratedLibrary'])).toThrow('invalid')
  })
  it('rejects traversal node names, broken chains and cycles', () => {
    expect(() =>
      localPlaylistRelativePath(
        rows.map((row) => (row.uuid === 'folder' ? { ...row, dirName: '../outside' } : row)),
        'list',
        ['FilterLibrary']
      )
    ).toThrow('boundary')
    expect(() =>
      localPlaylistRelativePath(
        rows.filter((row) => row.uuid !== 'folder'),
        'list',
        ['FilterLibrary']
      )
    ).toThrow('invalid')
    expect(() =>
      localPlaylistRelativePath(
        rows.map((row) => (row.uuid === 'folder' ? { ...row, parentUuid: 'list' } : row)),
        'list',
        ['FilterLibrary']
      )
    ).toThrow('boundary')
  })
})
