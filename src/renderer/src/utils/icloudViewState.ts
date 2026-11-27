import type { ISongInfo } from 'src/types/globals'
import type { IcloudEntry, IcloudSongMetadata } from '@shared/icloudLibrary'
export interface IcloudViewSnapshot {
  songs: ISongInfo[]
  entries: IcloudEntry[]
  metadata: Record<string, IcloudSongMetadata>
  selected: string[]
  query: string
  scrollTop: number
  cursorKey?: string
  anchorKey?: string
  cursor: number
  anchor: number
}
const views = new Map<string, IcloudViewSnapshot>()
export function saveIcloudView(key: string, value: IcloudViewSnapshot) {
  views.delete(key)
  views.set(key, value)
  while (views.size > 16) views.delete(views.keys().next().value!)
}
export const readIcloudView = (key: string) => views.get(key)
export const clearIcloudViews = () => views.clear()
