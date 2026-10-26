import type { ISongInfo } from 'src/types/globals'
import { rendererFilePathKey } from './filePathComparison'

// A loaded song must resolve to the displayed list's row key, which can be a
// file path, SET occurrence ID or external-library track ID.
export const createSongRowPlaybackLookup = (
  songs: readonly ISongInfo[],
  getRowKey: (song: ISongInfo) => string,
  pathKey: (filePath: string) => string = rendererFilePathKey
) => {
  const rows = new Map<string, ISongInfo[]>()
  for (const song of songs) {
    const key = pathKey(song.filePath)
    if (!key) continue
    const matches = rows.get(key)
    if (matches) matches.push(song)
    else rows.set(key, [song])
  }
  return (song: ISongInfo | null | undefined): string[] => {
    if (!song?.filePath) return []
    const matches = rows.get(pathKey(song.filePath)) || []
    const loadedKey = getRowKey(song)
    const usesItemId =
      (song.setItemId && loadedKey === song.setItemId) ||
      (song.mixtapeItemId && loadedKey === song.mixtapeItemId)
    return matches.filter((item) => !usesItemId || getRowKey(item) === loadedKey).map(getRowKey)
  }
}
