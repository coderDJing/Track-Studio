import type { ISongInfo } from '../types/globals'

export type SetCustodyAppendPayload = {
  playlistUuid: string
  items: Array<{
    song: ISongInfo
    originPathSnapshot?: string
  }>
}
