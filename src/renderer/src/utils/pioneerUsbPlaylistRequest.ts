import type { PioneerUsbLibraryType } from '@shared/pioneerUsbWrite'

export type PioneerUsbSourceSelection = {
  sourceKind: string
  sourceKey: string
  rootPath: string
  libraryType: string
  external: boolean
}

export type PioneerUsbPlaylistDeleteRequest = {
  sourceKey: string
  rootPath: string
  libraryType: PioneerUsbLibraryType
  playlistId: number
}

export const createPioneerUsbPlaylistDeleteRequest = (
  source: PioneerUsbSourceSelection,
  node: { id: number; isFolder: boolean; isSmartPlaylist?: boolean }
): PioneerUsbPlaylistDeleteRequest | null => {
  const libraryType = source.libraryType
  if (
    source.sourceKind !== 'usb' ||
    source.external ||
    !source.rootPath.trim() ||
    (libraryType !== 'deviceLibrary' && libraryType !== 'oneLibrary') ||
    !Number.isSafeInteger(node.id) ||
    node.id <= 0 ||
    node.isFolder ||
    node.isSmartPlaylist
  )
    return null
  return {
    sourceKey: source.sourceKey,
    rootPath: source.rootPath,
    libraryType,
    playlistId: node.id
  }
}

export const matchesPioneerUsbPlaylistDeleteRequest = (
  value: unknown,
  source: PioneerUsbSourceSelection,
  playlistId: number
): value is PioneerUsbPlaylistDeleteRequest => {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  if (!Number.isSafeInteger(playlistId) || playlistId <= 0) return false
  const expected = createPioneerUsbPlaylistDeleteRequest(source, {
    id: playlistId,
    isFolder: false
  })
  return Boolean(
    expected &&
    request.playlistId === expected.playlistId &&
    request.sourceKey === expected.sourceKey &&
    request.rootPath === expected.rootPath &&
    request.libraryType === expected.libraryType
  )
}
