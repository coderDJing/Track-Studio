import { rendererFilePathKey } from '@renderer/utils/filePathComparison'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

type SongsRemovedPayload = {
  listUUID?: string
  paths?: string[]
}

type UseHorizontalBrowseSongsRemovedParams = {
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  handleDeckEjectSong: (deck: DeckKey) => Promise<unknown>
}

const normalizePath = (value: string | null | undefined) => rendererFilePathKey(String(value || ''))

export const useHorizontalBrowseSongsRemoved = (params: UseHorizontalBrowseSongsRemovedParams) => {
  const handleSongsRemoved = (payload: SongsRemovedPayload) => {
    const removedPaths = Array.isArray(payload?.paths) ? payload.paths : []
    if (!removedPaths.length) return
    const removedSet = new Set(removedPaths.map(normalizePath))
    for (const deck of ['top', 'bottom'] as DeckKey[]) {
      const songPath = params.resolveDeckSong(deck)?.filePath
      if (songPath && removedSet.has(normalizePath(songPath))) {
        void params.handleDeckEjectSong(deck)
      }
    }
  }

  return { handleSongsRemoved }
}
