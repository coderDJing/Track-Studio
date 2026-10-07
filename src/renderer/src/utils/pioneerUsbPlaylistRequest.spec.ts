import { describe, expect, it } from 'vitest'
import {
  createPioneerUsbPlaylistDeleteRequest,
  matchesPioneerUsbPlaylistDeleteRequest,
  type PioneerUsbSourceSelection
} from './pioneerUsbPlaylistRequest'

const source: PioneerUsbSourceSelection = {
  sourceKind: 'usb',
  sourceKey: 'fixture-drive',
  rootPath: 'D:\\',
  libraryType: 'oneLibrary',
  external: false
}
const node = { id: 12, isFolder: false }

describe('USB playlist context actions retain their originating source', () => {
  it.each(['deviceLibrary', 'oneLibrary'])('accepts a normal playlist from %s', (libraryType) => {
    const selection = { ...source, libraryType }
    const request = createPioneerUsbPlaylistDeleteRequest(selection, node)
    expect(request).toEqual({
      sourceKey: source.sourceKey,
      rootPath: source.rootPath,
      libraryType,
      playlistId: node.id
    })
    expect(matchesPioneerUsbPlaylistDeleteRequest(request, selection, node.id)).toBe(true)
  })

  it.each([
    { ...source, sourceKind: 'desktop' },
    { ...source, external: true },
    { ...source, libraryType: 'unknown' },
    { ...source, rootPath: '' }
  ])('does not offer USB deletion for an unsupported source: %j', (selection) => {
    expect(createPioneerUsbPlaylistDeleteRequest(selection, node)).toBeNull()
  })

  it.each([
    { ...node, isFolder: true },
    { ...node, isSmartPlaylist: true },
    { ...node, id: 0 }
  ])('does not offer ordinary playlist deletion for %j', (target) => {
    expect(createPioneerUsbPlaylistDeleteRequest(source, target)).toBeNull()
  })

  it('rejects a queued menu action after drive, library, source or playlist changes', () => {
    const request = createPioneerUsbPlaylistDeleteRequest(source, node)
    for (const changed of [
      { ...source, sourceKey: 'another-drive' },
      { ...source, rootPath: 'E:\\' },
      { ...source, libraryType: 'deviceLibrary' },
      { ...source, external: true }
    ])
      expect(matchesPioneerUsbPlaylistDeleteRequest(request, changed, node.id)).toBe(false)
    expect(matchesPioneerUsbPlaylistDeleteRequest(request, source, node.id + 1)).toBe(false)
    expect(matchesPioneerUsbPlaylistDeleteRequest({ playlistId: node.id }, source, node.id)).toBe(
      false
    )
  })
})
