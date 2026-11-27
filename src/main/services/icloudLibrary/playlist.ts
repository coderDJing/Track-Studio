import path from 'node:path'
import type { LibraryNodeRow } from '../../libraryTreeDbHelpers'

// Resolve an actual disk-backed FRKB playlist by UUID, never a renderer-supplied path.
export function localPlaylistRelativePath(
  rows: readonly LibraryNodeRow[],
  uuid: string,
  allowedLibraries: readonly string[]
) {
  const byId = new Map(rows.map((row) => [row.uuid, row]))
  const playlist = byId.get(uuid)
  if (playlist?.nodeType !== 'songList') throw new Error('invalid')
  const parts: string[] = []
  const seen = new Set<string>()
  let node: LibraryNodeRow | undefined = playlist
  let libraryFound = false
  while (node) {
    if (seen.has(node.uuid)) throw new Error('boundary')
    seen.add(node.uuid)
    if (
      !node.dirName ||
      node.dirName === '.' ||
      node.dirName === '..' ||
      /[\\/\0]/.test(node.dirName)
    ) {
      throw new Error('boundary')
    }
    parts.unshift(node.dirName)
    if (node.nodeType === 'library') {
      if (!allowedLibraries.includes(node.dirName)) throw new Error('invalid')
      libraryFound = true
    }
    if (node.parentUuid === null) {
      if (!libraryFound || node.nodeType !== 'root' || node.dirName !== 'library')
        throw new Error('invalid')
      return path.join(...parts)
    }
    node = byId.get(node.parentUuid)
  }
  throw new Error('invalid')
}
